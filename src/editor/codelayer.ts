// Menampilkan blok kode (``` ... ```) sebagai kotak yang bisa digulir ke samping.
//
// GtkTextView hanya bisa membungkus atau tidak membungkus seluruh teksnya: kalau baris kode
// dibiarkan panjang, lebar seluruh dokumen ikut melebar. Karena itu, seperti tabel
// (tablelayer.ts), blok kode ditampilkan sebagai widget yang ditempel di atas ruang kosong
// di dalam teks, sehingga isi dokumen tidak berubah.
//
//   Kursor DI LUAR blok → seluruh baris blok (termasuk pembatas) dikecilkan jadi ~1 px
//                         (tag codehide), ruang setinggi kotak disediakan di bawah baris
//                         terakhir, dan kotaknya ditempel di ruang itu.
//   Kursor DI DALAM blok → kotak disembunyikan dan teks mentahnya (dibungkus) tampil untuk
//                         disunting.
//
// Klik kotak menaruh kursor di baris pertama isinya, yang membuka blok untuk disunting.
// Blok diagram (mermaid, dbml) ditangani mermaid.ts; blok yang belum ditutup atau kosong
// tetap berupa teks.

import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
import type { CodeBlock } from './highlighter.js';
import type { CodeHighlighter } from './codehighlight.js';
import { diagramKind } from './mermaid.js';
import { setTagGroup, setTagRanges, type Range } from './tagsync.js';
import { OverlaySlots } from './overlays.js';
import { iterAtLine, onClick } from '../gtkutil.js';

const GAP = 12;         // jarak di atas dan bawah kotak
const HIDDEN_LINE = 2;  // tinggi satu baris yang disembunyikan (lihat tablelayer.ts)
const PAD_X = 12;
const PAD_Y = 8;

interface Block {
    start: number;           // baris pembatas pembuka
    end: number;             // baris pembatas penutup
    lang: string;
    code: string;
    key: string;             // bahasa + isi; mencocokkan blok yang sama setelah baris bergeser
    lines: number;           // jumlah baris isi
    widget: Gtk.Box | null;  // slot overlay berisi kotak; dibuat saat pertama kali terlihat
    height: number;
    collapsed: boolean;      // true = tampil sebagai kotak
    x: number;
    y: number;
}

export class CodeLayer {
    readonly view: Gtk.TextView;
    readonly buffer: Gtk.TextBuffer;
    enabled = true;
    maxWidth = 700;
    blocks: Block[] = [];

    onActivate: (line: number) => void = () => {};  // kotak diklik

    private cursor: [number, number] = [-1, -1];
    private gapTags = new Map<number, Gtk.TextTag>();   // tinggi → tag
    private relayoutQueued = false;
    private destroyed = false;
    private adjustment: Gtk.Adjustment | null = null;
    private lineHeight = 0;
    private probe: Gtk.Label | null = null;
    private holder: Gtk.ScrolledWindow | null = null;   // memberi probe CSS yang sama dengan kotaknya
    private readonly slots: OverlaySlots;

    constructor(view: Gtk.TextView, private readonly hideTag: Gtk.TextTag, private readonly highlighter: CodeHighlighter) {
        this.view = view;
        this.buffer = view.buffer;
        this.slots = new OverlaySlots(view);
        view.connect('notify::vadjustment', () => this.watchAdjustment());
        this.watchAdjustment();
    }

    destroy(): void {
        this.destroyed = true;
        this.slots.destroy();
        this.probe = null;
        this.holder = null;
    }

    private watchAdjustment(): void {
        const adj = this.view.get_vadjustment();
        if (!adj || adj === this.adjustment) return;
        this.adjustment = adj;
        adj.connect('changed', () => this.queueRelayout());
        adj.connect('value-changed', () => this.queueRelayout());
    }

    // Skema warna berubah → markup berwarna dibuat ulang; tinggi baris bisa ikut berubah (CSS).
    setPalette(): void {
        this.lineHeight = 0;
        for (const block of this.blocks) this.destroyWidget(block);
        this.sync();
    }

    setMaxWidth(width: number): void {
        width = Math.max(200, Math.floor(width));
        if (width === this.maxWidth) return;
        this.maxWidth = width;
        for (const block of this.blocks) block.widget?.get_first_child()?.set_size_request(width, -1);
    }

    setEnabled(enabled: boolean): void {
        if (enabled === this.enabled) return;
        this.enabled = enabled;
        this.sync();
    }

    // codeBlocks dari highlighter.ts. force = teks blok bisa saja diganti (tag-nya hilang),
    // jadi tag dipasang ulang walaupun daftar bloknya sama.
    update(codeBlocks: CodeBlock[], force = false): void {
        const unused = [...this.blocks];
        const next: Block[] = [];
        let changed = force;
        for (const found of codeBlocks) {
            if (!found.closed || found.text.trim() === '' || diagramKind(found)) continue;
            const key = `${found.lang}\0${found.text}`;
            const k = unused.findIndex(b => b.key === key);
            if (k >= 0) {
                const block = unused.splice(k, 1)[0];
                changed ||= block.start !== found.startLine || block.end !== found.endLine;
                block.start = found.startLine;
                block.end = found.endLine;
                next.push(block);
            } else {
                changed = true;
                next.push({
                    start: found.startLine, end: found.endLine, lang: found.lang, code: found.text, key,
                    lines: found.text.replace(/\n$/, '').split('\n').length,
                    widget: null, height: 0, collapsed: false, x: -1, y: -1,
                });
            }
        }
        changed ||= unused.length > 0;
        for (const block of unused) this.destroyWidget(block);
        this.blocks = next;
        if (!changed && this.blocks.every(b => b.collapsed === this.isCollapsed(b))) return;
        this.sync();
    }

    // Kursor (atau seleksi) berada di baris first..last.
    setCursor(first: number, last: number): void {
        this.cursor = [first, last];
        if (this.blocks.some(b => b.collapsed !== this.isCollapsed(b))) this.sync();
    }

    private isCollapsed(block: Block): boolean {
        const [first, last] = this.cursor;
        return this.enabled && !(block.end >= first && block.start <= last);
    }

    private destroyWidget(block: Block): void {
        if (block.widget) this.slots.release(block.widget);
        block.widget = null;
    }

    // Tinggi satu baris kode, diukur dari label dengan CSS yang sama dengan kotaknya.
    private measureLine(): number {
        if (!this.lineHeight) {
            if (!this.probe) {
                this.probe = new Gtk.Label({ label: 'Ag', xalign: 0 });
                this.holder = new Gtk.ScrolledWindow({ child: this.probe });
                this.holder.add_css_class('md-codeblock');
            }
            this.lineHeight = Math.max(1, this.probe.measure(Gtk.Orientation.VERTICAL, -1)[1]);
        }
        return this.lineHeight;
    }

    // Samakan teks, ruang kosong, dan widget dengan keadaan sekarang.
    private sync(): void {
        const hide: Range[] = [];
        const gaps = new Map<Gtk.TextTag, Range[]>();
        for (const block of this.blocks) {
            block.collapsed = this.isCollapsed(block);
            if (!block.collapsed) { block.widget?.set_visible(false); continue; }
            block.height = block.lines * this.measureLine() + 2 * PAD_Y;

            const first = iterAtLine(this.buffer, block.start).get_offset();
            const lastLine = iterAtLine(this.buffer, block.end);
            const afterLast = lastLine.copy();
            afterLast.forward_to_line_end();
            hide.push([first, afterLast.get_offset()]);

            const gap = this.gapTag(this.reserved(block));
            if (!gaps.has(gap)) gaps.set(gap, []);
            gaps.get(gap)!.push([lastLine.get_offset(), afterLast.get_offset()]);
        }
        setTagRanges(this.buffer, this.hideTag, hide);
        setTagGroup(this.buffer, this.gapTags.values(), gaps);
        this.queueRelayout();
    }

    // Ruang di bawah baris terakhir (lihat TableLayer.reserved()).
    private reserved(block: Block): number {
        return Math.max(0, block.height + 2 * GAP - (block.end - block.start + 1) * HIDDEN_LINE);
    }

    private gapTag(height: number): Gtk.TextTag {
        let tag = this.gapTags.get(height);
        if (!tag) {
            tag = new Gtk.TextTag({ name: `code-gap-${height}`, pixels_below_lines: height });
            this.buffer.get_tag_table().add(tag);
            this.gapTags.set(height, tag);
        }
        return tag;
    }

    // ---------- Widget ----------

    private build(block: Block): void {
        const label = new Gtk.Label({
            use_markup: true, wrap: false, xalign: 0, yalign: 0,
            margin_start: PAD_X, margin_end: PAD_X, margin_top: PAD_Y, margin_bottom: PAD_Y,
        });
        label.set_markup(this.highlighter.markup(block.lang, block.code.replace(/\n$/, '')));
        const box = new Gtk.ScrolledWindow({
            child: label, hexpand: false,
            hscrollbar_policy: Gtk.PolicyType.AUTOMATIC, vscrollbar_policy: Gtk.PolicyType.NEVER,
            min_content_height: block.height, max_content_height: block.height,
        });
        box.set_size_request(this.maxWidth, block.height);
        box.add_css_class('md-codeblock');
        onClick(box, () => {
            this.onActivate(block.start + 1);
            return true;
        });
        block.widget = this.slots.acquire();
        block.widget.append(box);
        block.x = block.y = -1;
    }

    // ---------- Posisi widget ----------

    queueRelayout(): void {
        if (this.destroyed || this.relayoutQueued) return;
        this.relayoutQueued = true;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.relayoutQueued = false;
            if (!this.destroyed) this.relayout();
            return GLib.SOURCE_REMOVE;
        });
    }

    relayout(): void {
        if (!this.blocks.length) return;
        const x = this.view.get_left_margin();
        const rect = this.view.get_visible_rect();
        const [top] = this.view.get_line_at_y(rect.y);
        const [bottom] = this.view.get_line_at_y(rect.y + rect.height);
        const first = top.get_line(), last = bottom.get_line();
        for (const block of this.blocks) {
            // Hanya blok yang terlihat yang dibuat dan diposisikan (lihat TableLayer.relayout()).
            const visible = block.collapsed && block.end >= first && block.start <= last;
            if (visible && !block.widget) this.build(block);
            block.widget?.set_visible(visible);
            if (!visible || block.end >= this.buffer.get_line_count()) continue;
            const [lineY, lineHeight] = this.view.get_line_yrange(iterAtLine(this.buffer, block.end));
            const y = lineY + lineHeight - block.height - GAP;
            if (x === block.x && y === block.y) continue;
            block.x = x;
            block.y = y;
            this.slots.place(block.widget!, x, y);
        }
    }
}
