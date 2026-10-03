// Menampilkan tabel sebagai grid sungguhan, seperti Typora.
//
// Caranya sama dengan gambar (images.ts): widget ditempel di atas ruang kosong
// yang disediakan di dalam teks, sehingga isi dokumen tidak berubah.
//
//   Kursor DI LUAR tabel → baris-baris tabel dikecilkan jadi ~1 px (tag tablehide),
//                          ruang setinggi grid disediakan di bawah baris terakhir,
//                          dan grid ditempel di ruang itu.
//   Kursor DI DALAM tabel → grid disembunyikan dan teks mentahnya terlihat untuk
//                          disunting (Tab pindah sel, lihat tableedit.ts).
//
// Klik sel di grid menaruh kursor di sel itu pada teks mentahnya, yang otomatis
// membuka tabelnya untuk disunting.

import Gtk from 'gi://Gtk?version=3.0';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import { TABLE_CELL_PAD_X, TABLE_CELL_PAD_Y } from '../config.js';
import { parseTable, type TableRange } from '../markdown/table.js';
import { cellMarkup, type MarkupColors } from '../markdown/pango.js';
import type { Palette } from '../ui/theme.js';
import { setTagGroup, setTagRanges, type Range } from './tagsync.js';

const BORDER = 1;       // tebal garis sel (sama dengan CSS di ui/theme.ts)
const GAP = 12;         // jarak di atas dan bawah grid
const MIN_COLUMN = 56;  // lebar kolom terkecil saat tabel harus dipersempit

// Lebar kolom agar jumlahnya muat di `available`. Kolom yang sudah sempit dibiarkan,
// sisa ruang dibagi rata ke kolom yang lebar (teksnya dipotong dengan "…").
export function fitColumns(natural: number[], available: number): number[] {
    const widths = [...natural];
    if (natural.reduce((a, b) => a + b, 0) <= available) return widths;

    let remaining = available;
    let open = natural.map((_, i) => i);
    for (let changed = true; changed && open.length;) {
        changed = false;
        const share = remaining / open.length;
        for (const i of [...open]) {
            if (natural[i] > share) continue;
            remaining -= natural[i];
            open = open.filter(j => j !== i);
            changed = true;
        }
    }
    for (const i of open) widths[i] = Math.max(MIN_COLUMN, Math.floor(remaining / open.length));
    return widths;
}

interface Block {
    start: number;           // baris judul
    end: number;             // baris isi terakhir
    key: string;             // isi tabel; mencocokkan blok yang sama setelah baris bergeser
    widget: Gtk.EventBox | null;   // dibuat saat pertama kali dibutuhkan
    height: number;
    collapsed: boolean;      // true = tampil sebagai grid
    x: number;
    y: number;
}

export class TableLayer {
    readonly view: Gtk.TextView;
    readonly buffer: Gtk.TextBuffer;
    enabled = true;
    maxWidth = 700;
    blocks: Block[] = [];

    onActivate: (line: number, col: number) => void = () => {};  // sel diklik

    private lines: string[] = [];
    private cursor: [number, number] = [-1, -1];
    private colors: MarkupColors = { code: '#c7254e', codeBg: '#f3f4f4', link: '#4183c4', mark: '#fff3a3' };
    private signature = '';
    private gapTags = new Map<number, Gtk.TextTag>();   // tinggi → tag
    private relayoutQueued = false;
    private adjustment: Gtk.Adjustment | null = null;

    constructor(view: Gtk.TextView, private readonly hideTag: Gtk.TextTag) {
        this.view = view;
        this.buffer = view.buffer;
        view.connect('size-allocate', () => this.queueRelayout());
        view.connect('notify::vadjustment', () => this.watchAdjustment());
        this.watchAdjustment();
    }

    private watchAdjustment(): void {
        const adj = this.view.get_vadjustment();
        if (!adj || adj === this.adjustment) return;
        this.adjustment = adj;
        adj.connect('changed', () => this.queueRelayout());
    }

    setPalette(palette: Palette): void {
        this.colors = { code: palette.codeFg, codeBg: palette.codeBg, link: palette.accent, mark: palette.markBg };
        this.rebuildAll();
    }

    // Lebar kolom teks berubah → hitung ulang lebar kolom tabel.
    setMaxWidth(width: number): void {
        width = Math.max(200, Math.floor(width));
        if (width === this.maxWidth) return;
        this.maxWidth = width;
        this.rebuildAll();
    }

    setEnabled(enabled: boolean): void {
        if (enabled === this.enabled) return;
        this.enabled = enabled;
        this.sync();
    }

    // tables dari highlighter.ts; lines = isi dokumen per baris.
    update(tables: TableRange[], lines: string[], force = false): void {
        this.lines = lines;
        // Pakai ulang blok yang isinya sama walaupun barisnya bergeser.
        let changed = force, moved = false;
        const unused = [...this.blocks];
        const next: Block[] = [];
        for (const t of tables) {
            const key = lines.slice(t.start, t.end + 1).join('\n');
            const k = unused.findIndex(b => b.key === key);
            if (k >= 0) {
                const block = unused.splice(k, 1)[0];
                moved ||= block.start !== t.start || block.end !== t.end;
                block.start = t.start;
                block.end = t.end;
                next.push(block);
            } else {
                changed = true;
                next.push({ start: t.start, end: t.end, key, widget: null, height: 0, collapsed: false, x: -1, y: -1 });
            }
        }
        changed ||= unused.length > 0;
        for (const block of unused) this.destroyWidget(block);
        this.blocks = next;
        if (!changed && this.blocks.every(b => b.collapsed === this.isCollapsed(b))) {
            // Rentang tag ikut bergeser di GTK; cukup pindahkan widgetnya.
            this.signature = this.stateSignature();
            if (moved) this.queueRelayout();
            return;
        }
        this.signature = '';
        this.sync();
    }

    // Kursor (atau seleksi) berada di baris first..last.
    setCursor(first: number, last: number): void {
        this.cursor = [first, last];
        if (this.stateSignature() !== this.signature) this.sync();
    }

    // ---------- Keadaan ----------

    private isCollapsed(block: Block): boolean {
        const [first, last] = this.cursor;
        return this.enabled && !(block.end >= first && block.start <= last);
    }

    private stateSignature(): string {
        return this.blocks.map(b => `${b.start}-${b.end}:${this.isCollapsed(b) ? 1 : 0}`).join(',');
    }

    private rebuildAll(): void {
        for (const block of this.blocks) this.destroyWidget(block);
        this.signature = '';
        this.sync();
    }

    private destroyWidget(block: Block): void {
        block.widget?.destroy();
        block.widget = null;
    }

    // Samakan teks, ruang kosong, dan widget dengan keadaan sekarang.
    private sync(): void {
        const hide: Range[] = [];
        const gaps = new Map<Gtk.TextTag, Range[]>();
        for (const block of this.blocks) {
            block.collapsed = this.isCollapsed(block);
            if (block.collapsed && !block.widget) this.build(block);
            block.widget?.set_visible(block.collapsed);
            if (!block.collapsed) continue;

            const first = this.buffer.get_iter_at_line(block.start).get_offset();
            const lastLine = this.buffer.get_iter_at_line(block.end);
            const afterLast = lastLine.copy();
            afterLast.forward_to_line_end();
            hide.push([first, afterLast.get_offset()]);

            const gap = this.gapTag(block.height + 2 * GAP);
            if (!gaps.has(gap)) gaps.set(gap, []);
            gaps.get(gap)!.push([lastLine.get_offset(), afterLast.get_offset()]);
        }
        setTagRanges(this.buffer, this.hideTag, hide);
        setTagGroup(this.buffer, this.gapTags.values(), gaps);
        this.signature = this.stateSignature();
        this.queueRelayout();
    }

    private gapTag(height: number): Gtk.TextTag {
        let tag = this.gapTags.get(height);
        if (!tag) {
            tag = new Gtk.TextTag({ name: `table-gap-${height}`, pixels_below_lines: height });
            this.buffer.get_tag_table().add(tag);
            this.gapTags.set(height, tag);
        }
        return tag;
    }

    // ---------- Widget ----------

    private build(block: Block): void {
        const table = parseTable(this.lines.slice(block.start, block.end + 1));
        const columns = table.header.length;
        const grid = new Gtk.Grid();
        grid.get_style_context().add_class('md-table');

        const allRows = [table.header, ...table.rows];
        const labels: Gtk.Label[][] = [];
        const boxes: Gtk.EventBox[][] = [];
        allRows.forEach((row, r) => {
            labels.push([]);
            boxes.push([]);
            row.forEach((text, c) => {
                const align = table.aligns[c];
                const label = new Gtk.Label({
                    use_markup: true, ellipsize: Pango.EllipsizeMode.END,
                    xalign: align === 'right' ? 1 : align === 'center' ? 0.5 : 0,
                    margin_start: TABLE_CELL_PAD_X, margin_end: TABLE_CELL_PAD_X,
                    margin_top: TABLE_CELL_PAD_Y, margin_bottom: TABLE_CELL_PAD_Y,
                });
                const markup = cellMarkup(text, this.colors);
                label.set_markup(r === 0 ? `<b>${markup}</b>` : markup);

                const box = new Gtk.EventBox({ visible_window: true });
                box.add(label);
                const style = box.get_style_context();
                style.add_class('md-table-cell');
                if (r === 0) style.add_class('md-table-head');
                // Hitung baris saat klik karena grid dipakai ulang setelah teks bergeser.
                // Baris pemisah dilewati saat memilih baris isi.
                box.connect('button-press-event', () => {
                    this.onActivate(block.start + (r === 0 ? 0 : r + 1), c);
                    return true;
                });
                grid.attach(box, c, r, 1, 1);
                labels[r].push(label);
                boxes[r].push(box);
            });
        });

        // GTK melaporkan ukuran 0 untuk widget yang belum ditampilkan, jadi tampilkan dulu.
        grid.show_all();

        // Lebar kolom: sebesar teks terpanjang, dipersempit jika melebihi lebar kolom teks.
        const natural = Array.from({ length: columns }, (_, c) =>
            Math.max(...boxes.map(row => row[c].get_preferred_width()[1])) + BORDER);
        const widths = fitColumns(natural, this.maxWidth - BORDER);
        labels.forEach((row, r) => row.forEach((label, c) => {
            // Anak TextView hanya diberi ukuran minimumnya, jadi lebar harus dipaksa.
            label.set_size_request(Math.max(1, widths[c] - 2 * TABLE_CELL_PAD_X - BORDER), -1);
            if (widths[c] < natural[c]) boxes[r][c].set_tooltip_text(allRows[r][c]);  // teks yang terpotong
        }));

        const widget = new Gtk.EventBox({ visible_window: false });
        widget.add(grid);
        this.view.add_child_in_window(widget, Gtk.TextWindowType.TEXT, 0, 0);
        widget.show_all();
        block.widget = widget;
        block.height = grid.get_preferred_height()[1];
        block.x = block.y = -1;
    }

    // ---------- Posisi widget ----------

    queueRelayout(): void {
        if (this.relayoutQueued) return;
        this.relayoutQueued = true;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.relayoutQueued = false;
            this.relayout();
            return GLib.SOURCE_REMOVE;
        });
    }

    relayout(): void {
        const x = this.view.get_left_margin();
        for (const block of this.blocks) {
            if (!block.widget || !block.collapsed || block.end >= this.buffer.get_line_count()) continue;
            const [lineY, lineHeight] = this.view.get_line_yrange(this.buffer.get_iter_at_line(block.end));
            const y = lineY + lineHeight - block.height - GAP;
            // Hanya pindahkan jika berubah, supaya tidak memicu resize berulang.
            if (x === block.x && y === block.y) continue;
            block.x = x;
            block.y = y;
            this.view.move_child(block.widget, x, y);
        }
    }
}
