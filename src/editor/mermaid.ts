// Menampilkan blok ```mermaid dan ```dbml sebagai diagram.
// Blok DBML (bahasa skema dbdiagram.io) diterjemahkan dulu menjadi diagram ER Mermaid
// oleh markdown/dbml.ts, lalu dirender dengan jalur yang sama.
//
// Caranya sama dengan tabel (tablelayer.ts) dan gambar (images.ts): widget ditempel di
// atas ruang kosong yang disediakan di dalam teks, sehingga isi dokumen tidak berubah.
// Gambar diagramnya dibuat oleh mermaidrender.ts.
//
//   Kursor DI LUAR blok → seluruh baris blok (termasuk pembatas) dikecilkan jadi ~1 px
//                         (tag mermaidhide) dan hanya diagram yang terlihat.
//   Kursor DI DALAM blok → kodenya tampil untuk disunting, diagram tetap tampil di
//                         bawahnya sebagai pratinjau yang ikut berubah saat mengetik.
//
// Kode yang salah tidak pernah disembunyikan: pesan galatnya muncul di bawah blok,
// sehingga kodenya bisa langsung diperbaiki.
//
// Render ditunda sebentar setelah kode berubah, supaya mengetik tidak merender tiap huruf.

import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import type { CodeBlock } from './highlighter.js';
import { mermaidRenderer, type DiagramTheme } from './mermaidrender.js';
import { dbmlToMermaid } from '../markdown/dbml.js';
import { setTagGroup, setTagRanges, type Range } from './tagsync.js';
import { OverlaySlots } from './overlays.js';
import { iterAtLine, onClick, removeChildren } from '../gtkutil.js';

const GAP = 12;             // jarak di atas dan bawah diagram
const NOTE_HEIGHT = 24;     // tinggi pesan "Merender…" / galat
const MAX_HEIGHT = 640;     // tinggi maksimum diagram yang ditampilkan
const DEBOUNCE_MS = 400;    // jeda setelah kode berubah sebelum dirender

export type Kind = 'mermaid' | 'dbml';

// Jenis diagram sebuah blok kode, atau null jika bukan diagram (atau kosong/belum ditutup).
export const diagramKind = (block: CodeBlock): Kind | null => {
    if (!block.closed || block.text.trim() === '') return null;
    const lang = block.lang.toLowerCase();
    return lang === 'mermaid' ? 'mermaid' : lang === 'dbml' ? 'dbml' : null;
};

type Status = 'loading' | 'ok' | 'error';

export interface Block {
    start: number;           // baris pembatas pembuka
    end: number;             // baris pembatas penutup
    kind: Kind;
    code: string;
    status: Status;
    busy: boolean;           // ada permintaan render yang belum selesai
    pixbuf: GdkPixbuf.Pixbuf | null;   // diagram terakhir yang berhasil (tetap tampil selama dirender ulang)
    error: string | null;
    widget: Gtk.Box;         // slot overlay (lihat overlays.ts)
    content: Gtk.Box;
    height: number;
    collapsed: boolean;
    timer: number;
    x: number;
    y: number;
}

export class MermaidLayer {
    readonly view: Gtk.TextView;
    readonly buffer: Gtk.TextBuffer;
    enabled = true;
    maxWidth = 700;
    blocks: Block[] = [];

    onActivate: (line: number) => void = () => {};                        // diagram diklik sekali
    onZoom: (pixbuf: GdkPixbuf.Pixbuf, title: string) => void = () => {};  // diagram diklik dua kali

    private theme: DiagramTheme = { dark: false, bg: '#ffffff', fg: '#333333', accent: '#4183c4', node: '#f3f4f4' };
    private cursor: [number, number] = [-1, -1];
    private signature = '';
    private gapTags = new Map<number, Gtk.TextTag>();   // tinggi → tag
    private relayoutQueued = false;
    private destroyed = false;
    private adjustment: Gtk.Adjustment | null = null;
    private readonly slots: OverlaySlots;

    constructor(view: Gtk.TextView, private readonly hideTag: Gtk.TextTag) {
        this.view = view;
        this.buffer = view.buffer;
        this.slots = new OverlaySlots(view);
        view.connect('notify::vadjustment', () => this.watchAdjustment());
        this.watchAdjustment();
    }

    // Editor ditutup: hentikan pekerjaan tertunda (lihat MarkdownView.destroy()).
    destroy(): void {
        this.destroyed = true;
        this.slots.destroy();
        for (const b of this.blocks) this.cancelTimer(b);
    }

    private watchAdjustment(): void {
        const adj = this.view.get_vadjustment();
        if (!adj || adj === this.adjustment) return;
        this.adjustment = adj;
        adj.connect('changed', () => this.queueRelayout());
    }

    // Tema berubah → semua diagram dirender ulang dengan warna baru.
    setTheme(theme: DiagramTheme): void {
        if (JSON.stringify(theme) === JSON.stringify(this.theme)) return;
        this.theme = theme;
        for (const block of this.blocks) this.request(block, false);
    }

    // Lebar kolom teks berubah → skala ulang diagram.
    setMaxWidth(width: number): void {
        width = Math.max(100, Math.floor(width));
        if (width === this.maxWidth) return;
        this.maxWidth = width;
        for (const block of this.blocks) this.render(block);
        this.sync();
    }

    setEnabled(enabled: boolean): void {
        if (enabled === this.enabled) return;
        this.enabled = enabled;
        this.sync();
    }

    // codeBlocks dari highlighter.ts.
    update(codeBlocks: CodeBlock[]): void {
        const unused = [...this.blocks];
        const next: Block[] = [];
        const toRender: [Block, boolean][] = [];
        for (const found of codeBlocks) {
            const kind = diagramKind(found);
            if (!kind) continue;
            // Blok yang kodenya sama dipakai ulang walaupun barisnya bergeser; blok yang
            // kodenya baru diubah (sedang diketik) dikenali dari baris awalnya.
            let k = unused.findIndex(b => b.kind === kind && b.code === found.text);
            const edited = k < 0;
            if (edited) k = unused.findIndex(b => b.kind === kind && b.start === found.startLine);
            if (k >= 0) {
                const block = unused.splice(k, 1)[0];
                block.start = found.startLine;
                block.end = found.endLine;
                if (edited) {
                    block.code = found.text;
                    toRender.push([block, true]);
                }
                next.push(block);
            } else {
                const block = this.createBlock(found);
                next.push(block);
                toRender.push([block, false]);
            }
        }
        for (const block of unused) this.destroyBlock(block);
        this.blocks = next;
        // Setelah this.blocks diisi: hasil dari cache datang seketika dan hanya diterima blok yang terdaftar.
        for (const [block, delay] of toRender) this.request(block, delay);
        this.signature = '';
        this.sync();
    }

    // Kursor (atau seleksi) berada di baris first..last.
    setCursor(first: number, last: number): void {
        this.cursor = [first, last];
        if (this.stateSignature() !== this.signature) this.sync();
    }

    // ---------- Render ----------

    // Minta gambar untuk kode blok ini. delay = true saat kode sedang diketik.
    private request(block: Block, delay: boolean): void {
        this.cancelTimer(block);
        block.busy = true;
        const code = block.code;
        const theme = this.theme;
        const renderer = mermaidRenderer();
        let source = code;
        if (block.kind === 'dbml') {
            try {
                source = dbmlToMermaid(code);
            } catch (e) {
                // Galat DBML dilaporkan seketika, tanpa menunggu jeda ketik.
                block.busy = false;
                block.status = 'error';
                block.error = e instanceof Error ? e.message : String(e);
                this.render(block);
                this.sync();
                return;
            }
        }
        const run = () => {
            block.timer = 0;
            renderer.render(source, theme, result => {
                // Hasil lama (kode atau tema sudah berganti, atau blok dibuang) diabaikan.
                if (block.code !== code || this.theme !== theme || !this.blocks.includes(block)) return;
                block.busy = false;
                if (result.ok) {
                    block.status = 'ok';
                    block.pixbuf = result.pixbuf;
                    block.error = null;
                } else {
                    block.status = 'error';
                    block.error = result.error;
                }
                this.render(block);
                this.sync();
            });
        };
        const hit = renderer.cached(source, theme);
        if (hit || !delay) {
            run();
        } else {
            block.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => { run(); return GLib.SOURCE_REMOVE; });
        }
    }

    private cancelTimer(block: Block): void {
        if (block.timer) GLib.source_remove(block.timer);
        block.timer = 0;
    }

    // ---------- Keadaan ----------

    // Diagram yang berhasil dirender menggantikan kodenya saat kursor di luar blok.
    private isCollapsed(block: Block): boolean {
        const [first, last] = this.cursor;
        return this.enabled && block.status === 'ok' && !(block.end >= first && block.start <= last);
    }

    private stateSignature(): string {
        return this.blocks.map(b => `${b.start}-${b.end}:${this.isCollapsed(b) ? 1 : 0}`).join(',');
    }

    // Samakan teks, ruang kosong, dan widget dengan keadaan sekarang.
    private sync(): void {
        const hide: Range[] = [];
        const gaps = new Map<Gtk.TextTag, Range[]>();
        for (const block of this.blocks) {
            block.collapsed = this.isCollapsed(block);
            block.widget.set_visible(this.enabled);
            if (!this.enabled || block.end >= this.buffer.get_line_count()) continue;

            const afterLast = iterAtLine(this.buffer, block.end);
            afterLast.forward_to_line_end();
            const end = afterLast.get_offset();
            if (block.collapsed) hide.push([iterAtLine(this.buffer, block.start).get_offset(), end]);
            const gap = this.gapTag(block.height + 2 * GAP);
            if (!gaps.has(gap)) gaps.set(gap, []);
            gaps.get(gap)!.push([iterAtLine(this.buffer, block.end).get_offset(), end]);
        }
        setTagRanges(this.buffer, this.hideTag, hide);
        setTagGroup(this.buffer, this.gapTags.values(), gaps);
        this.signature = this.stateSignature();
        this.queueRelayout();
    }

    private gapTag(height: number): Gtk.TextTag {
        let tag = this.gapTags.get(height);
        if (!tag) {
            tag = new Gtk.TextTag({ name: `mermaid-gap-${height}`, pixels_below_lines: height });
            this.buffer.get_tag_table().add(tag);
            this.gapTags.set(height, tag);
        }
        return tag;
    }

    // ---------- Widget ----------

    private createBlock(found: CodeBlock): Block {
        const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        content.add_css_class('image-block');
        const widget = this.slots.acquire();
        widget.append(content);
        const block: Block = {
            start: found.startLine, end: found.endLine, kind: diagramKind(found)!, code: found.text, status: 'loading', busy: false, pixbuf: null, error: null,
            widget, content, height: NOTE_HEIGHT, collapsed: false, timer: 0, x: -1, y: -1,
        };
        onClick(content, count => {
            this.press(block, count === 2);
            return true;
        });
        this.render(block);
        return block;
    }

    private destroyBlock(block: Block): void {
        this.cancelTimer(block);
        this.slots.release(block.widget);
    }

    // Klik sekali: kursor masuk ke kode (kodenya terbuka). Klik ganda: perbesar.
    press(block: Block, doubleClick: boolean): void {
        if (doubleClick) this.zoom(block);
        else this.onActivate(block.end - 1);
    }

    zoom(block: Block): void {
        if (block.pixbuf) this.onZoom(block.pixbuf, block.kind === 'dbml' ? 'Diagram DBML' : 'Diagram Mermaid');
    }

    // Bangun ulang isi widget sesuai status dan lebar kolom saat ini.
    private render(block: Block): void {
        removeChildren(block.content);
        const note = (text: string, tooltip?: string) => {
            // Tanpa wrap: widget di dalam TextView hanya diberi lebar minimum.
            const label = new Gtk.Label({ label: text, xalign: 0 });
            label.add_css_class('image-note');
            if (tooltip) label.set_tooltip_text(tooltip);
            block.content.append(label);
            block.height = NOTE_HEIGHT;
        };

        if (block.status === 'error') {
            // Diagram lama (jika ada) disembunyikan: yang tampil harus sesuai kode sekarang.
            note(`⚠ Diagram tidak bisa dirender: ${block.error}`, block.error ?? undefined);
        } else if (block.pixbuf) {
            const pb = block.pixbuf;
            const scale = Math.min(1, this.maxWidth / pb.get_width(), MAX_HEIGHT / pb.get_height());
            const w = Math.max(1, Math.round(pb.get_width() * scale));
            const h = Math.max(1, Math.round(pb.get_height() * scale));
            const scaled = (scale < 1 ? pb.scale_simple(w, h, GdkPixbuf.InterpType.BILINEAR) : null) ?? pb;
            // Gtk.Image di GTK 4 berukuran ikon; Picture tampil seukuran gambarnya.
            const image = Gtk.Picture.new_for_pixbuf(scaled);
            image.set_can_shrink(false);
            image.set_halign(Gtk.Align.START);
            image.set_tooltip_text('Klik ganda untuk memperbesar');
            block.content.append(image);
            block.height = h;
        } else {
            note('Merender diagram…');
        }
    }

    // ---------- Posisi widget ----------

    queueRelayout(): void {
        if (this.destroyed || this.relayoutQueued) return;
        this.relayoutQueued = true;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.relayoutQueued = false;
            if (!this.destroyed) this.relayout();   // tab bisa ditutup sebelum idle berjalan
            return GLib.SOURCE_REMOVE;
        });
    }

    relayout(): void {
        if (!this.enabled) return;
        const x = this.view.get_left_margin();
        for (const block of this.blocks) {
            if (block.end >= this.buffer.get_line_count()) continue;
            const [lineY, lineHeight] = this.view.get_line_yrange(iterAtLine(this.buffer, block.end));
            const y = lineY + lineHeight - block.height - GAP;
            // Hanya pindahkan jika berubah, supaya tidak memicu resize berulang.
            if (x === block.x && y === block.y) continue;
            block.x = x;
            block.y = y;
            this.slots.place(block.widget, x, y);
        }
    }
}
