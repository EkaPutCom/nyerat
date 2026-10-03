// MarkdownView: widget editor ala Typora.
//
// Menyatukan GtkSourceView dengan modul-modul di folder ini:
//   tags.ts         gaya teks
//   highlighter.ts  dijalankan setiap teks berubah
//   decorations.ts  dijalankan setiap kursor pindah baris
//   lists.ts        Enter dan Tab
//   clicks.ts       klik kotak tugas dan Ctrl+klik tautan
//   images.ts       gambar ditampilkan di bawah barisnya
//   codehighlight.ts  isi blok kode diwarnai sesuai bahasanya
//   tablelayer.ts   tabel dirender sebagai grid, tableedit.ts menyuntingnya
//   mermaid.ts      blok ```mermaid dirender sebagai diagram (mermaidrender.ts)
//
// Widget ini tidak tahu apa-apa soal file, menu, atau sidebar. Ia memberi kabar
// lewat callback yang dipasang oleh jendela (window.ts):
//   onHighlighted({ text, headings })   setelah penyorotan
//   onCursorMoved(line, column)         setelah kursor pindah
//   onMessage(text)                     pesan singkat untuk pengguna
//   onViewImage(pixbuf, title)          gambar diminta diperbesar (klik ganda / perintah menu)
//   getBaseDir()                        folder untuk tautan relatif

import Gtk from 'gi://Gtk?version=3.0';
import Gdk from 'gi://Gdk?version=3.0';
import GtkSource from 'gi://GtkSource?version=4';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import type GdkPixbuf from 'gi://GdkPixbuf';

import { createTags, paintTags, setTagMargins } from './tags.js';
import { highlight } from './highlighter.js';
import { concealMarkers, dimOutsideParagraph } from './decorations.js';
import { continueBlock, indentListItem, isInCodeBlock } from './lists.js';
import { toggleTaskAt, linkAt } from './clicks.js';
import { ImageLayer } from './images.js';
import { CodeHighlighter } from './codehighlight.js';
import { TableLayer } from './tablelayer.js';
import { MermaidLayer } from './mermaid.js';
import { cellStart, type TableRange } from '../markdown/table.js';
import { enterInTable, tabInTable, runTableCommand, type TableCommand } from './tableedit.js';
import { cpLength } from './offsets.js';
import type { Tags } from './tags.js';
import type { HighlightResult, Heading, Marker } from './highlighter.js';
import type { Palette } from '../ui/theme.js';

const TEXT_WIDTH = 780;  // lebar kolom teks maksimum, dalam piksel

export type Mode = 'source' | 'focus' | 'typewriter';

// Bagian dari Gdk.Event yang dipakai onKey/onClick (memudahkan tes membuat event tiruan).
export type KeyEvent = Pick<Gdk.Event, 'get_keyval' | 'get_state'>;
export type ButtonEvent = Pick<Gdk.Event, 'get_button' | 'get_event_type' | 'get_coords' | 'get_state'>;

export class MarkdownView {
    readonly buffer: GtkSource.Buffer;
    readonly view: GtkSource.View;
    readonly widget: Gtk.ScrolledWindow;
    readonly tags: Tags;
    readonly images: ImageLayer;
    readonly code: CodeHighlighter;
    readonly tableLayer: TableLayer;
    readonly mermaid: MermaidLayer;

    markers: Marker[] = [];
    headings: Heading[] = [];
    lines: string[] = [];
    tables: TableRange[] = [];
    modes: Record<Mode, boolean> = { source: false, focus: false, typewriter: false };

    onHighlighted: (result: HighlightResult) => void = () => {};
    onCursorMoved: (line: number, column: number) => void = () => {};
    onMessage: (text: string) => void = () => {};
    onViewImage: (pixbuf: GdkPixbuf.Pixbuf, title: string) => void = () => {};  // gambar diminta diperbesar
    getBaseDir: () => string = () => GLib.get_home_dir();

    private margin = -1;
    private width = -1;
    private cursorKey = '';
    private highlightQueued = false;
    private cursorQueued = 0;
    private destroyed = false;
    private cursorForce = false;

    constructor() {
        this.buffer = new GtkSource.Buffer();
        this.buffer.set_highlight_syntax(false);
        this.buffer.set_highlight_matching_brackets(false);
        this.view = new GtkSource.View({
            buffer: this.buffer, wrap_mode: Gtk.WrapMode.WORD_CHAR, auto_indent: true,
            pixels_above_lines: 3, pixels_below_lines: 3, pixels_inside_wrap: 4,
            top_margin: 48, bottom_margin: 240, tab_width: 4,
        });
        this.view.get_style_context().add_class('editor');
        this.tags = createTags(this.buffer);

        // Tag warna kode dibuat belakangan, jadi prioritasnya otomatis di atas 'codeblock'.
        // 'dim' (mode fokus) dan 'hidden' harus tetap paling atas.
        this.code = new CodeHighlighter(this.buffer);
        this.code.onTagAdded = () => {
            const top = this.buffer.get_tag_table().get_size() - 1;
            this.tags.dim.set_priority(top);
            this.tags.hidden.set_priority(top);
        };

        this.tableLayer = new TableLayer(this.view, this.tags.tablehide);
        // Klik sel di grid → kursor ke sel itu di teks mentah (yang membuka tabelnya).
        this.tableLayer.onActivate = (line, col) => {
            const text = this.lines[line] ?? '';
            const it = this.buffer.get_iter_at_line(line);
            it.forward_chars(cpLength(text.slice(0, cellStart(text, col))));
            this.buffer.place_cursor(it);
            this.view.grab_focus();
        };

        this.mermaid = new MermaidLayer(this.view, this.tags.mermaidhide);
        this.mermaid.onZoom = (pixbuf, title) => this.onViewImage(pixbuf, title);
        // Klik diagram → kursor ke baris kode terakhir, sehingga kodenya terbuka.
        this.mermaid.onActivate = line => {
            const it = this.buffer.get_iter_at_line(line);
            it.forward_to_line_end();
            this.buffer.place_cursor(it);
            this.view.grab_focus();
        };

        this.images = new ImageLayer(this.view);
        this.images.onZoom = (line, index) => this.zoomImage(line, index);
        this.images.getBaseDir = () => this.getBaseDir();
        // Klik gambar → kursor ke barisnya, sehingga sintaks ![alt](url) muncul.
        this.images.onActivate = line => {
            const it = this.buffer.get_iter_at_line(line);
            it.forward_to_line_end();
            this.buffer.place_cursor(it);
            this.view.grab_focus();
        };

        // EXTERNAL, bukan NEVER: dengan NEVER, lebar minimum TextView (= lebarnya saat
        // ini + margin) diteruskan ke jendela, sehingga jendela tidak bisa mengecil dan
        // terus membesar setiap margin dihitung ulang.
        this.widget = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.EXTERNAL, hexpand: true, vexpand: true });
        this.widget.add(this.view);

        this.buffer.connect('changed', () => this.queueHighlight());
        this.buffer.connect('mark-set', (_b, _i, mark) => {
            if (mark === this.buffer.get_insert() || mark === this.buffer.get_selection_bound()) this.queueCursorUpdate();
        });
        // Margin dihitung dari lebar ScrolledWindow (area yang terlihat), bukan dari
        // TextView, supaya margin tidak ikut menentukan lebarnya sendiri.
        this.widget.connect('size-allocate', (_w, alloc) => this.updateMargins(alloc.width));
        // Tipe @girs menyebut EventKey/EventButton (struct tanpa method), tapi saat
        // runtime GJS memberikan Gdk.Event yang punya get_keyval(), get_coords(), dst.
        this.view.connect('key-press-event', (_w, ev) => this.onKey(ev as unknown as Gdk.Event));
        this.view.connect('button-press-event', (_w, ev) => this.onClick(ev as unknown as Gdk.Event));
        this.view.connect('destroy', () => {
            this.destroyed = true;
            if (this.cursorQueued) GLib.source_remove(this.cursorQueued);
            this.cursorQueued = 0;
        });
    }

    // ---------- Isi dan tampilan ----------

    getText(): string {
        const [s, e] = this.buffer.get_bounds();
        return this.buffer.get_text(s, e, true);
    }

    // Ganti seluruh isi tanpa masuk riwayat undo (dipakai saat membuka file).
    setText(text: string): void {
        const buf = this.buffer;
        buf.begin_not_undoable_action();
        buf.set_text(text, -1);
        buf.end_not_undoable_action();
        buf.set_modified(false);
        buf.place_cursor(buf.get_start_iter());
        this.highlight();
    }

    // Ganti isi dokumen dengan suntingan sekecil mungkin (hanya bagian tengah yang berbeda),
    // dalam satu langkah undo. Dipakai papan kanban untuk menulis perubahannya ke teks.
    replaceText(text: string): void {
        const old = this.getText();
        let head = 0;
        const max = Math.min(old.length, text.length);
        while (head < max && old[head] === text[head]) head++;
        let tail = 0;
        while (tail < max - head && old[old.length - 1 - tail] === text[text.length - 1 - tail]) tail++;
        if (head === old.length && head === text.length) return;   // tidak ada perubahan

        // Batas potongan tidak boleh membelah pasangan surrogat (emoji): mundurkan awal, majukan akhir.
        const isLow = (c: number) => c >= 0xDC00 && c <= 0xDFFF;
        if (head < old.length && isLow(old.charCodeAt(head))) head--;
        if (tail > 0 && isLow(old.charCodeAt(old.length - tail))) tail--;

        const buf = this.buffer;
        const cp = (n: number) => Array.from(old.slice(0, n)).length;
        const from = buf.get_iter_at_offset(cp(head));
        const to = buf.get_iter_at_offset(cp(old.length - tail));
        buf.begin_user_action();
        buf.delete(from, to);
        buf.insert(from, text.slice(head, text.length - tail), -1);
        buf.end_user_action();
    }

    setPalette(palette: Palette): void {
        paintTags(this.tags, palette);
        this.code.setScheme(palette.codeScheme);
        this.tableLayer.setPalette(palette);
        this.mermaid.setTheme({ dark: palette.dark, bg: palette.bg, fg: palette.fg, accent: palette.accent, node: palette.codeBg });
        this.highlight();  // warnai ulang blok kode dengan skema baru
    }

    // name: 'source' | 'focus' | 'typewriter'
    setMode(name: Mode, enabled: boolean): void {
        this.modes[name] = enabled;
        if (name === 'source') {
            this.images.setEnabled(!enabled);
            this.tableLayer.setEnabled(!enabled);
            this.mermaid.setEnabled(!enabled);
        }
        this.queueCursorUpdate(true);
    }

    jumpToLine(n: number): void {
        const it = this.buffer.get_iter_at_line(n);
        it.forward_to_line_end();
        this.buffer.place_cursor(it);
        this.view.grab_focus();
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.view.scroll_to_mark(this.buffer.get_insert(), 0, true, 0, 0.15);
            return GLib.SOURCE_REMOVE;
        });
    }

    // Kolom teks di tengah: margin kiri/kanan mengikuti lebar jendela.
    private updateMargins(width: number): void {
        const m = Math.max(36, Math.floor((width - TEXT_WIDTH) / 2));
        if (m === this.margin && width === this.width) return;
        this.margin = m;
        this.width = width;
        // Jangan ubah ukuran di dalam size-allocate; tunda ke idle.
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.view.set_left_margin(m);
            this.view.set_right_margin(m);
            setTagMargins(this.tags, m);
            this.images.setMaxWidth(width - 2 * m);
            this.tableLayer.setMaxWidth(width - 2 * m);
            this.mermaid.setMaxWidth(width - 2 * m);
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---------- Siklus penyorotan ----------
    //
    // Teks berubah    → queueHighlight()    → highlight()  → updateCursor(true)
    // Kursor berpindah → queueCursorUpdate() → updateCursor()
    //
    // Keduanya ditunda ke PRIORITY_HIGH_IDLE: beberapa perubahan beruntun digabung
    // jadi satu proses, dan prosesnya selesai sebelum GTK menggambar ulang layar
    // sehingga tidak berkedip.

    queueHighlight(): void {
        if (this.highlightQueued) return;
        this.highlightQueued = true;
        GLib.idle_add(GLib.PRIORITY_HIGH_IDLE, () => {
            this.highlightQueued = false;
            this.highlight();
            return GLib.SOURCE_REMOVE;
        });
    }

    highlight(): void {
        const result = highlight(this.buffer, this.tags);
        this.markers = result.markers;
        this.lines = result.lines;
        this.headings = result.headings;
        this.tables = result.tables;
        this.tableLayer.update(result.tables, result.lines);
        this.code.apply(result.codeBlocks);
        this.mermaid.update(result.codeBlocks);
        this.images.update(result.images);
        this.onHighlighted(result);
        this.updateCursor(true);
    }

    queueCursorUpdate(force = false): void {
        this.cursorForce ||= force;
        if (this.destroyed || this.cursorQueued) return;
        this.cursorQueued = GLib.idle_add(GLib.PRIORITY_HIGH_IDLE, () => {
            this.cursorQueued = 0;
            this.updateCursor(this.cursorForce);
            this.cursorForce = false;
            return GLib.SOURCE_REMOVE;
        });
    }

    updateCursor(force = false): void {
        const buf = this.buffer;
        const ins = buf.get_iter_at_mark(buf.get_insert());
        const sel = buf.get_iter_at_mark(buf.get_selection_bound());
        const l0 = Math.min(ins.get_line(), sel.get_line());
        const l1 = Math.max(ins.get_line(), sel.get_line());

        // Dekorasi hanya perlu dihitung ulang jika baris aktif berubah.
        const key = `${l0}:${l1}`;
        if (force || key !== this.cursorKey) {
            this.cursorKey = key;
            concealMarkers(buf, this.tags.hidden, this.markers, l0, l1, !this.modes.source);
            dimOutsideParagraph(buf, this.tags.dim, this.lines, l0, l1, this.modes.focus);
            this.tableLayer.setCursor(l0, l1);
            this.mermaid.setCursor(l0, l1);
            if (this.modes.typewriter)
                this.view.scroll_to_mark(buf.get_insert(), 0, true, 0, 0.5);
        }
        this.onCursorMoved(ins.get_line(), ins.get_line_offset());
    }

    // ---------- Input ----------

    // Dipanggil untuk setiap tombol. true = sudah ditangani, GTK tidak memprosesnya lagi.
    onKey(ev: KeyEvent): boolean {
        const [, keyval] = ev.get_keyval();
        const [, state] = ev.get_state();
        if (state & (Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.MOD1_MASK)) return false;
        if (this.buffer.get_has_selection()) return false;
        const shift = (state & Gdk.ModifierType.SHIFT_MASK) !== 0;

        // Di dalam tabel: Tab/Shift+Tab pindah sel, Enter pindah baris.
        const line = this.buffer.get_iter_at_mark(this.buffer.get_insert()).get_line();
        if (this.tables.some(t => line >= t.start && line <= t.end)) {
            if (keyval === Gdk.KEY_Tab || keyval === Gdk.KEY_ISO_Left_Tab)
                return tabInTable(this.buffer, shift || keyval === Gdk.KEY_ISO_Left_Tab);
            if ((keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) && !shift) return enterInTable(this.buffer);
        }

        if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) {
            if (shift) return false;
            if (isInCodeBlock(this.lines, line)) return false;
            if (!continueBlock(this.buffer)) return false;
            this.view.scroll_mark_onscreen(this.buffer.get_insert());
            return true;
        }
        if (keyval === Gdk.KEY_Tab || keyval === Gdk.KEY_ISO_Left_Tab)
            return indentListItem(this.buffer, shift || keyval === Gdk.KEY_ISO_Left_Tab);
        return false;
    }

    onClick(ev: ButtonEvent): boolean {
        const [, button] = ev.get_button();
        if (button !== 1 || ev.get_event_type() !== Gdk.EventType.BUTTON_PRESS) return false;
        const [, x, y] = ev.get_coords();
        const [bx, by] = this.view.window_to_buffer_coords(Gtk.TextWindowType.TEXT, x, y);
        const [ok, iter] = this.view.get_iter_at_location(bx, by);
        if (!ok) return false;

        if (toggleTaskAt(this.buffer, iter, this.tags)) return true;

        const [, state] = ev.get_state();
        if (state & Gdk.ModifierType.CONTROL_MASK) {
            const url = linkAt(this.buffer, iter, this.tags);
            if (url) {
                this.openUrl(url);
                return true;
            }
        }
        return false;
    }

    // Perbesar gambar di baris `line` (default: baris kursor).
    zoomImage(line?: number, index = 0): void {
        const target = line ?? this.buffer.get_iter_at_mark(this.buffer.get_insert()).get_line();
        const found = this.images.imageAt(target, index);
        if (found.ok) this.onViewImage(found.pixbuf, found.title);
        else this.onMessage(found.reason);
    }

    // Perintah tabel dari menu/shortcut. Pesan kegagalan ditampilkan lewat onMessage.
    tableCommand(command: TableCommand): void {
        const result = runTableCommand(this.buffer, command);
        if (!result.ok) this.onMessage(result.reason);
        this.view.grab_focus();
    }

    openUrl(url: string): void {
        let uri = url;
        if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) {
            const path = GLib.path_is_absolute(url) ? url : GLib.build_filenamev([this.getBaseDir(), decodeURI(url)]);
            uri = Gio.File.new_for_path(path).get_uri();
        }
        try {
            Gtk.show_uri_on_window(this.view.get_toplevel() as Gtk.Window, uri, Gdk.CURRENT_TIME);
        } catch {
            this.onMessage(`Tidak bisa membuka ${url}`);
        }
    }
}
