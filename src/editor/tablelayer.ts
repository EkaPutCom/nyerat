// Menampilkan tabel sebagai grid sungguhan.
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

import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import { TABLE_CELL_PAD_X, TABLE_CELL_PAD_Y } from '../config.js';
import { parseTable, type TableRange } from '../markdown/table.js';
import { cellMarkup, type MarkupColors } from '../markdown/pango.js';
import type { Palette } from '../ui/theme.js';
import { setTagGroup, setTagRanges, type Range } from './tagsync.js';
import { iterAtLine, onClick } from '../gtkutil.js';
import { OverlaySlots } from './overlays.js';

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
    widget: Gtk.Box | null;    // slot overlay berisi grid (lihat overlays.ts); dibuat saat pertama kali terlihat
    grid: Gtk.Grid | null;
    height: number;
    geometry: Geometry | null;  // tetap tersedia meski cache bersama sudah berganti
    collapsed: boolean;      // true = tampil sebagai grid
    x: number;
    y: number;
}

interface Geometry {
    table: ReturnType<typeof parseTable>;
    markup: string[][];
    natural: number[];
    height: number;
}

export class TableLayer {
    readonly view: Gtk.TextView;
    readonly buffer: Gtk.TextBuffer;
    enabled = true;
    maxWidth = 700;
    blocks: Block[] = [];

    onActivate: (line: number, col: number) => void = () => {};  // sel diklik

    private cursor: [number, number] = [-1, -1];
    private colors: MarkupColors = { code: '#c7254e', codeBg: '#f3f4f4', link: '#1c71d8', mark: '#fff3a3' };
    private gapTags = new Map<number, Gtk.TextTag>();   // tinggi → tag
    private relayoutQueued = false;
    private destroyed = false;
    private adjustment: Gtk.Adjustment | null = null;
    private geometry = new Map<string, Geometry>();
    private geometryUnits = 0;
    private cellSizes = new Map<string, [number, number]>();
    private cellUnits = 0;
    private probe: Gtk.Grid | null = null;
    private probeCells: { label: Gtk.Label; box: Gtk.Box }[] = [];
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
        this.probe = null;
        this.probeCells = [];
    }

    private watchAdjustment(): void {
        const adj = this.view.get_vadjustment();
        if (!adj || adj === this.adjustment) return;
        this.adjustment = adj;
        adj.connect('changed', () => this.queueRelayout());
        adj.connect('value-changed', () => this.queueRelayout());
    }

    setPalette(palette: Palette): void {
        this.colors = { code: palette.codeFg, codeBg: palette.codeBg, link: palette.accent, mark: palette.markBg };
        this.geometry.clear();
        this.geometryUnits = 0;
        this.cellSizes.clear();
        this.cellUnits = 0;
        for (const block of this.blocks) block.geometry = null;
        this.rebuildAll();
    }

    // Lebar kolom teks berubah → hitung ulang lebar kolom tabel.
    setMaxWidth(width: number): void {
        width = Math.max(200, Math.floor(width));
        if (width === this.maxWidth) return;
        this.maxWidth = width;
        // Sel memakai ellipsize, bukan wrap: tinggi tidak berubah saat lebar berubah.
        // Pakai ulang widget serta ruang tabel, termasuk tabel yang belum terlihat.
        for (const block of this.blocks) if (block.widget) this.resize(block);
        this.queueRelayout();
    }

    setEnabled(enabled: boolean): void {
        if (enabled === this.enabled) return;
        this.enabled = enabled;
        this.sync();
    }

    // tables dari highlighter.ts; lines = isi dokumen per baris.
    update(tables: TableRange[], lines: string[], force = false): void {
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
                next.push({ start: t.start, end: t.end, key, widget: null, grid: null, height: 0, geometry: null, collapsed: false, x: -1, y: -1 });
            }
        }
        changed ||= unused.length > 0;
        for (const block of unused) this.destroyWidget(block);
        this.blocks = next;
        if (!changed && this.blocks.every(b => b.collapsed === this.isCollapsed(b))) {
            // Rentang tag ikut bergeser di GTK; cukup pindahkan widgetnya.
            if (moved) this.queueRelayout();
            return;
        }
        this.sync();
    }

    // Kursor (atau seleksi) berada di baris first..last.
    setCursor(first: number, last: number): void {
        this.cursor = [first, last];
        let changed = false;
        for (const block of this.blocks) {
            const collapsed = this.isCollapsed(block);
            if (collapsed === block.collapsed) continue;
            changed = true;
            block.collapsed = collapsed;
            if (collapsed) block.height = this.measure(block).height;
            if (!collapsed) block.widget?.set_visible(false);

            // Kursor tidak mengubah teks: tag tabel lain tetap benar. Jangan menelusuri
            // seluruh buffer untuk mencari selisih tag setiap masuk/keluar satu tabel.
            const start = iterAtLine(this.buffer, block.start);
            const lastLine = iterAtLine(this.buffer, block.end);
            const end = lastLine.copy();
            end.forward_to_line_end();
            const gap = this.gapTag(block.height + 2 * GAP);
            if (collapsed) {
                this.buffer.apply_tag(this.hideTag, start, end);
                this.buffer.apply_tag(gap, lastLine, end);
            } else {
                this.buffer.remove_tag(this.hideTag, start, end);
                this.buffer.remove_tag(gap, lastLine, end);
            }
        }
        if (changed) this.queueRelayout();
    }

    // ---------- Keadaan ----------

    private isCollapsed(block: Block): boolean {
        const [first, last] = this.cursor;
        return this.enabled && !(block.end >= first && block.start <= last);
    }

    private rebuildAll(): void {
        for (const block of this.blocks) this.destroyWidget(block);
        this.sync();
    }

    private destroyWidget(block: Block): void {
        if (block.widget) this.slots.release(block.widget);
        block.widget = null;
        block.grid = null;
    }

    // Samakan teks, ruang kosong, dan widget dengan keadaan sekarang.
    private sync(): void {
        const hide: Range[] = [];
        const gaps = new Map<Gtk.TextTag, Range[]>();
        for (const block of this.blocks) {
            block.collapsed = this.isCollapsed(block);
            if (!block.collapsed) { block.widget?.set_visible(false); continue; }
            block.height = this.measure(block).height;

            const first = iterAtLine(this.buffer, block.start).get_offset();
            const lastLine = iterAtLine(this.buffer, block.end);
            const afterLast = lastLine.copy();
            afterLast.forward_to_line_end();
            hide.push([first, afterLast.get_offset()]);

            const gap = this.gapTag(block.height + 2 * GAP);
            if (!gaps.has(gap)) gaps.set(gap, []);
            gaps.get(gap)!.push([lastLine.get_offset(), afterLast.get_offset()]);
        }
        setTagRanges(this.buffer, this.hideTag, hide);
        setTagGroup(this.buffer, this.gapTags.values(), gaps);
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

    private label(): Gtk.Label {
        return new Gtk.Label({
            use_markup: true, ellipsize: Pango.EllipsizeMode.END, hexpand: true,
            margin_start: TABLE_CELL_PAD_X, margin_end: TABLE_CELL_PAD_X,
            margin_top: TABLE_CELL_PAD_Y, margin_bottom: TABLE_CELL_PAD_Y,
        });
    }

    // Dua sel pengukur memakai CSS yang sama dengan grid. Sel tidak membungkus teks,
    // jadi tinggi baris cukup maksimum tinggi selnya, tanpa membuat seluruh grid.
    private measure(block: Block): Geometry {
        if (block.geometry) return block.geometry;
        const cached = this.geometry.get(block.key);
        if (cached) return block.geometry = cached;
        if (!this.probe) {
            this.probe = new Gtk.Grid();
            this.probe.add_css_class('md-table');
            for (let r = 0; r < 2; r++) {
                const label = this.label();
                const box = new Gtk.Box();
                box.add_css_class('md-table-cell');
                if (r === 0) box.add_css_class('md-table-head');
                box.append(label);
                this.probe.attach(box, 0, r, 1, 1);
                this.probeCells.push({ label, box });
            }
        }
        const table = parseTable(block.key.split('\n'));
        const natural = table.header.map(() => 0);
        let height = BORDER;
        const markup = [table.header, ...table.rows].map((row, r) => {
            let rowHeight = 0;
            const result = row.map((text, c) => {
                const m = cellMarkup(text, this.colors);
                const value = r === 0 ? `<b>${m}</b>` : m;
                const [width, cellHeight] = this.measureCell(value, r === 0);
                natural[c] = Math.max(natural[c], width + BORDER);
                rowHeight = Math.max(rowHeight, cellHeight);
                return value;
            });
            height += rowHeight;
            return result;
        });
        const result = { table, markup, natural, height };
        // Boros bila naskah terus diganti: batasi cache isi tabel, bukan hanya jumlahnya.
        if (block.key.length <= 1024 * 1024) {
            while (this.geometry.size >= 256 || this.geometryUnits + block.key.length > 1024 * 1024) {
                const key = this.geometry.keys().next().value!;
                this.geometryUnits -= key.length;
                this.geometry.delete(key);
            }
            this.geometry.set(block.key, result);
            this.geometryUnits += block.key.length;
        }
        return block.geometry = result;
    }

    private measureCell(markup: string, header: boolean): [number, number] {
        const key = (header ? 'h:' : 'b:') + markup;
        const cached = this.cellSizes.get(key);
        if (cached) return cached;
        const cell = this.probeCells[header ? 0 : 1];
        cell.label.set_markup(markup);
        const size: [number, number] = [cell.box.measure(Gtk.Orientation.HORIZONTAL, -1)[1], cell.box.measure(Gtk.Orientation.VERTICAL, -1)[1]];
        if (key.length <= 1024 * 1024) {
            while (this.cellSizes.size >= 1024 || this.cellUnits + key.length > 1024 * 1024) {
                const old = this.cellSizes.keys().next().value!;
                this.cellUnits -= old.length;
                this.cellSizes.delete(old);
            }
            this.cellSizes.set(key, size);
            this.cellUnits += key.length;
        }
        return size;
    }

    private resize(block: Block): void {
        const { table, natural } = this.measure(block);
        const widths = fitColumns(natural, this.maxWidth - BORDER);
        const grid = block.grid!;
        [table.header, ...table.rows].forEach((row, r) => row.forEach((text, c) => {
            const box = grid.get_child_at(c, r)!;
            const label = box.get_first_child() as Gtk.Label;
            label.set_size_request(Math.max(1, widths[c] - 2 * TABLE_CELL_PAD_X - BORDER), -1);
            box.set_tooltip_text(widths[c] < natural[c] ? text : null);
        }));
    }

    private build(block: Block): void {
        const { table, markup } = this.measure(block);
        const grid = new Gtk.Grid();
        grid.add_css_class('md-table');
        markup.forEach((row, r) => row.forEach((text, c) => {
            const align = table.aligns[c];
            const label = this.label();
            label.xalign = align === 'right' ? 1 : align === 'center' ? 0.5 : 0;
            label.set_markup(text);
            const box = new Gtk.Box();
            box.append(label);
            box.add_css_class('md-table-cell');
            if (r === 0) box.add_css_class('md-table-head');
            onClick(box, () => {
                this.onActivate(block.start + (r === 0 ? 0 : r + 1), c);
                return true;
            });
            grid.attach(box, c, r, 1, 1);
        }));
        block.grid = grid;
        block.widget = this.slots.acquire();
        block.widget.append(grid);
        this.resize(block);
        block.x = block.y = -1;
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
        if (!this.blocks.length) return;
        const x = this.view.get_left_margin();
        const rect = this.view.get_visible_rect();
        const [top] = this.view.get_line_at_y(rect.y);
        const [bottom] = this.view.get_line_at_y(rect.y + rect.height);
        const first = top.get_line(), last = bottom.get_line();
        for (const block of this.blocks) {
            // get_line_yrange() untuk semua tabel memaksa GTK menata sampai akhir
            // dokumen tiap kursor berpindah. Grid di luar layar menyimpan ruangnya
            // lewat tag, tetapi baru diposisikan saat digulir ke layar.
            const visible = block.collapsed && block.end >= first && block.start <= last;
            if (visible && !block.widget) this.build(block);
            block.widget?.set_visible(visible);
            if (!visible || block.end >= this.buffer.get_line_count()) continue;
            const [lineY, lineHeight] = this.view.get_line_yrange(iterAtLine(this.buffer, block.end));
            const y = lineY + lineHeight - block.height - GAP;
            // Hanya pindahkan jika berubah, supaya tidak memicu resize berulang.
            if (x === block.x && y === block.y) continue;
            block.x = x;
            block.y = y;
            this.slots.place(block.widget!, x, y);
        }
    }
}
