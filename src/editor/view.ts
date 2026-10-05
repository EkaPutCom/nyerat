// MarkdownView: widget editor Markdown yang langsung terformat.
//
// Menyatukan GtkSourceView dengan modul-modul di folder ini:
//   tags.ts         gaya teks
//   highlighter.ts  dijalankan setiap teks berubah
//   decorations.ts  dijalankan setiap kursor pindah baris
//   lists.ts        Enter dan Tab
//   clicks.ts       klik kotak tugas dan Ctrl+klik tautan
//   wikicomplete.ts saran nama catatan saat mengetik [[
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
//   onOpenNote(link)                    Ctrl+klik [[catatan]]
//   onOpenDocument(path)                Ctrl+klik tautan ke berkas Markdown; false = buka dengan aplikasi lain
//   listNotes()                         berkas Markdown di proyek, untuk saran [[

import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import GtkSource from 'gi://GtkSource?version=5';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import type GdkPixbuf from 'gi://GdkPixbuf';
import { onClick, onKeyPress } from '../gtkutil.js';

import { createTags, paintTags, setTagMargins, SYNTAX_TAGS } from './tags.js';
import { LineTagger } from './tagsync.js';
import { highlight, HighlightCache } from './highlighter.js';
import { MarkerConcealer, dimOutsideParagraph } from './decorations.js';
import { continueBlock, indentListItem, isInCodeBlock } from './lists.js';
import { toggleTaskAt, linkAt, wikiLinkAt } from './clicks.js';
import { WikiCompleter } from './wikicomplete.js';
import type { WikiLink } from '../markdown/wikilink.js';
import { ImageLayer } from './images.js';
import { CodeHighlighter } from './codehighlight.js';
import { TableLayer } from './tablelayer.js';
import { MermaidLayer } from './mermaid.js';
import { cellStart, type TableRange } from '../markdown/table.js';
import { enterInTable, tabInTable, runTableCommand, type TableCommand } from './tableedit.js';
import { cpLength } from './offsets.js';
import type { Tags } from './tags.js';
import type { LineSpan } from './tagsync.js';
import type { HighlightResult, Heading, Marker } from './highlighter.js';
import type { Palette } from '../ui/theme.js';
import { iterAtLine } from '../gtkutil.js';

const TEXT_WIDTH = 780;  // lebar kolom teks maksimum, dalam piksel

// Penyorotan bertahap saat membuka dokumen (lihat setText()): sebanyak ini baris dari awal
// diberi tag langsung, sisanya dicicil per FILL_BUDGET_MS di idle. Prioritasnya di atas
// penataan latar GtkTextView (GTK_TEXT_VIEW_PRIORITY_VALIDATE = 125) supaya baris ditata
// sekali dengan tag akhirnya, dan di bawah menggambar (GDK_PRIORITY_REDRAW = 120) supaya
// layar tetap diperbarui selama cicilan berjalan.
const FILL_FIRST_LINES = 200;
const FILL_CHUNK_LINES = 100;
const FILL_BUDGET_MS = 8;
const FILL_PRIORITY = GLib.PRIORITY_HIGH_IDLE + 22;

export type Mode = 'source' | 'focus' | 'typewriter';

// Ganti seluruh isi TextView (lewat `replace`), lalu tampilkan dari awal.
//
// GTK memberi tinggi 0 pada baris yang belum ditata. Jika gambar pertama mencakup area di
// bawah baris yang sudah ditata, GTK bisa menata semua baris sampai akhir dokumen sekaligus
// di thread utama (di GTK 3 membuka naskah 650 KB membeku ±0,6 detik). Karena itu posisi
// gulir lama dinolkan dulu, dan gulir ke kursor diantre: GTK lalu menata layar di sekitar
// kursor sebelum menggambar dan sisanya sedikit demi sedikit di latar.
//
// Gulir ke kursor hanya jika TextView sudah punya ukuran. Sebelum itu (jendela belum tampil,
// atau tab baru di Stack) GTK 4 menyimpan gulirnya lalu menjalankannya dengan geometri yang
// belum ada, sehingga dokumen terbuka di tengah atau akhir, bukan di awal.
export function replaceAllText(view: Gtk.TextView, replace: () => void): void {
    view.get_vadjustment()?.set_value(0);
    replace();
    const buf = view.buffer;
    buf.place_cursor(buf.get_start_iter());
    if (view.get_height() > 0) view.scroll_to_mark(buf.get_insert(), 0, false, 0, 0);
}

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
    starts: number[] = [];
    spans: LineSpan[][] = [];
    modes: Record<Mode, boolean> = { source: false, focus: false, typewriter: false };

    onHighlighted: (result: HighlightResult) => void = () => {};
    onCursorMoved: (line: number, column: number) => void = () => {};
    onMessage: (text: string) => void = () => {};
    onViewImage: (pixbuf: GdkPixbuf.Pixbuf, title: string) => void = () => {};  // gambar diminta diperbesar
    getBaseDir: () => string = () => GLib.get_home_dir();
    onOpenNote: (link: WikiLink) => void = () => {};
    onOpenDocument: (path: string) => boolean = () => false;
    listNotes: () => string[] = () => [];
    readonly completer: WikiCompleter;

    private margin = -1;
    private width = -1;
    private cursorKey = '';
    private highlightQueued = 0;
    private resetHighlight = false;
    private highlightCache = new HighlightCache();
    private cursorQueued = 0;
    private fillQueued = 0;
    private destroyed = false;
    private cursorForce = false;
    private syntaxTagger: LineTagger;
    private concealer: MarkerConcealer;
    // Rentang teks yang disunting sejak penyorotan terakhir. Memakai mark supaya ikut
    // bergeser jika ada suntingan lain sebelum penyorotan berjalan.
    private dirty = false;
    private dirtyStart: Gtk.TextMark;
    private dirtyEnd: Gtk.TextMark;

    constructor() {
        this.buffer = new GtkSource.Buffer();
        this.buffer.set_highlight_syntax(false);
        this.buffer.set_highlight_matching_brackets(false);
        this.view = new GtkSource.View({
            buffer: this.buffer, wrap_mode: Gtk.WrapMode.WORD_CHAR, auto_indent: true,
            pixels_above_lines: 3, pixels_below_lines: 3, pixels_inside_wrap: 4,
            top_margin: 48, bottom_margin: 240, tab_width: 4,
        });
        this.view.add_css_class('editor');
        this.tags = createTags(this.buffer);
        this.syntaxTagger = new LineTagger(this.buffer, SYNTAX_TAGS.map(n => this.tags[n]));
        this.concealer = new MarkerConcealer(new LineTagger(this.buffer, [this.tags.hidden]), this.tags.hidden);
        this.dirtyStart = this.buffer.create_mark(null, this.buffer.get_start_iter(), true);
        this.dirtyEnd = this.buffer.create_mark(null, this.buffer.get_start_iter(), false);

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
            const it = iterAtLine(this.buffer, line);
            it.forward_chars(cpLength(text.slice(0, cellStart(text, col))));
            this.buffer.place_cursor(it);
            this.view.grab_focus();
        };

        this.mermaid = new MermaidLayer(this.view, this.tags.mermaidhide);
        this.mermaid.onZoom = (pixbuf, title) => this.onViewImage(pixbuf, title);
        // Klik diagram → kursor ke baris kode terakhir, sehingga kodenya terbuka.
        this.mermaid.onActivate = line => {
            const it = iterAtLine(this.buffer, line);
            it.forward_to_line_end();
            this.buffer.place_cursor(it);
            this.view.grab_focus();
        };

        this.images = new ImageLayer(this.view);
        this.images.onZoom = (line, index) => this.zoomImage(line, index);
        this.images.getBaseDir = () => this.getBaseDir();
        // Klik gambar → kursor ke barisnya, sehingga sintaks ![alt](url) muncul.
        this.images.onActivate = line => {
            const it = iterAtLine(this.buffer, line);
            it.forward_to_line_end();
            this.buffer.place_cursor(it);
            this.view.grab_focus();
        };

        // EXTERNAL, bukan NEVER: dengan NEVER, lebar minimum TextView (= lebarnya saat
        // ini + margin) diteruskan ke jendela, sehingga jendela tidak bisa mengecil dan
        // terus membesar setiap margin dihitung ulang.
        this.widget = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.EXTERNAL, hexpand: true, vexpand: true });
        this.widget.set_child(this.view);

        this.completer = new WikiCompleter(this.view);
        this.completer.listNotes = () => this.listNotes();

        this.buffer.connect_after('insert-text', (_b, end, text) => {
            this.completer.queue(true);
            const start = end.copy();
            start.backward_chars(cpLength(text));
            this.markDirty(start, end);
        });
        this.buffer.connect_after('delete-range', (_b, start) => {
            this.completer.queue(false);
            this.markDirty(start, start);
        });
        this.buffer.connect('changed', () => this.queueHighlight());
        this.buffer.connect('mark-set', (_b, _i, mark) => {
            if (mark === this.buffer.get_insert() || mark === this.buffer.get_selection_bound()) {
                this.queueCursorUpdate();
                this.completer.queue(false);
            }
        });
        // Margin dihitung dari lebar area yang terlihat (page_size adjustment horizontal,
        // diisi TextView saat dialokasikan), bukan dari lebar TextView yang ikut ditentukan
        // margin itu sendiri. GTK 4 tidak punya sinyal size-allocate.
        const hadj = this.widget.get_hadjustment();
        hadj.connect('changed', () => this.updateMargins(hadj.get_page_size()));
        // Fase CAPTURE: berjalan sebelum penanganan tombol/klik bawaan GtkSourceView
        // (indentasi otomatis, Tab, menaruh kursor), sama seperti handler GTK 3 yang mendahuluinya.
        onKeyPress(this.view, (keyval, state) => this.onKey(keyval, state), Gtk.PropagationPhase.CAPTURE);
        onClick(this.view, (count, x, y, state) => this.onClick(count, x, y, state))
            .set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
    }

    // Hentikan semua pekerjaan tertunda. GTK 4 tidak lagi memancarkan "destroy" untuk widget
    // yang masih dipegang JavaScript, jadi pemilik editor (jendela) wajib memanggil ini saat
    // tab atau jendela ditutup. Melepas widget dari induknya urusan pemiliknya.
    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        if (this.highlightQueued) GLib.source_remove(this.highlightQueued);
        this.highlightQueued = 0;
        if (this.cursorQueued) GLib.source_remove(this.cursorQueued);
        this.cursorQueued = 0;
        if (this.fillQueued) GLib.source_remove(this.fillQueued);
        this.fillQueued = 0;
        this.images.destroy();
        this.tableLayer.destroy();
        this.mermaid.destroy();
        this.completer.destroy();
    }

    get isDestroyed(): boolean {
        return this.destroyed;
    }

    // ---------- Isi dan tampilan ----------

    getText(): string {
        const [s, e] = this.buffer.get_bounds();
        return this.buffer.get_text(s, e, true);
    }

    // Ganti seluruh isi tanpa masuk riwayat undo (dipakai saat membuka file).
    setText(text: string): void {
        const buf = this.buffer;
        this.resetHighlight = true;
        // Dokumen panjang: tag sintaks dan marker tersembunyi dipasang bertahap (queueFill()).
        // Penguraiannya tetap penuh karena struktur dokumen (baris, heading) dibutuhkan langsung.
        this.syntaxTagger.defer(FILL_FIRST_LINES);
        this.concealer.defer(FILL_FIRST_LINES);
        replaceAllText(this.view, () => {
            buf.begin_irreversible_action();
            buf.set_text(text, -1);
            buf.end_irreversible_action();
            buf.set_modified(false);
        });
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
        const it = iterAtLine(this.buffer, n);
        it.forward_to_line_end();
        this.buffer.place_cursor(it);
        this.view.grab_focus();
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (this.destroyed) return GLib.SOURCE_REMOVE;
            this.view.scroll_to_mark(this.buffer.get_insert(), 0, true, 0, 0.15);
            return GLib.SOURCE_REMOVE;
        });
    }

    // Posisi kursor dalam code point, untuk diingat lalu dipulihkan dengan restoreCursor().
    get cursorOffset(): number {
        return this.buffer.get_iter_at_mark(this.buffer.get_insert()).get_offset();
    }

    // Taruh kursor di offset (dipotong ke akhir dokumen jika file memendek) dan gulir ke sana.
    // Tanpa grab_focus(): editor tab latar tidak boleh merebut fokus. Gulir ditunda ke idle
    // supaya berlaku setelah editor mendapat ukuran, termasuk tab yang belum pernah tampil.
    restoreCursor(offset: number): void {
        this.buffer.place_cursor(this.buffer.get_iter_at_offset(Math.max(0, offset)));
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (this.destroyed) return GLib.SOURCE_REMOVE;
            this.view.scroll_to_mark(this.buffer.get_insert(), 0, true, 0, 0.3);
            return GLib.SOURCE_REMOVE;
        });
    }

    // Kolom teks di tengah: margin kiri/kanan mengikuti lebar jendela.
    private updateMargins(width: number): void {
        const m = Math.max(36, Math.floor((width - TEXT_WIDTH) / 2));
        if (m === this.margin && width === this.width) return;
        this.margin = m;
        this.width = width;
        // Jangan ubah ukuran selagi GTK mengalokasikan; tunda ke idle.
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (this.destroyed) return GLib.SOURCE_REMOVE;
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
        if (this.destroyed || this.highlightQueued) return;
        this.highlightQueued = GLib.idle_add(GLib.PRIORITY_HIGH_IDLE, () => {
            this.highlightQueued = 0;
            this.highlight();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Catat rentang yang disunting; dipakai highlight() untuk menentukan baris mana yang
    // tag-nya tidak bisa dipercaya lagi.
    private markDirty(start: Gtk.TextIter, end: Gtk.TextIter): void {
        const buf = this.buffer;
        if (!this.dirty || start.compare(buf.get_iter_at_mark(this.dirtyStart)) < 0) buf.move_mark(this.dirtyStart, start);
        if (!this.dirty || end.compare(buf.get_iter_at_mark(this.dirtyEnd)) > 0) buf.move_mark(this.dirtyEnd, end);
        this.dirty = true;
    }

    highlight(): void {
        if (this.destroyed) return;
        // setText() sorot langsung: batalkan callback yang dibuat sinyal changed.
        if (this.highlightQueued) GLib.source_remove(this.highlightQueued);
        this.highlightQueued = 0;
        const reset = this.resetHighlight;
        this.resetHighlight = false;
        let edited: [number, number] | null = null;
        if (this.dirty) {
            const buf = this.buffer;
            const first = buf.get_iter_at_mark(this.dirtyStart).get_line();
            const last = buf.get_iter_at_mark(this.dirtyEnd).get_line();
            edited = [first, last];
            this.dirty = false;
            const count = buf.get_line_count();
            this.syntaxTagger.edited(first, last, count);
            this.concealer.edited(first, last, count);
        }
        const result = highlight(this.buffer, this.tags, this.syntaxTagger, this.highlightCache, reset ? undefined : edited);
        // Tanpa suntingan, cache mengembalikan hasil yang sama: tidak ada baris yang diurai ulang.
        if (result.markers !== this.markers) this.concealer.reparsed(result.markers, ...result.reparsed);
        this.markers = result.markers;
        this.lines = result.lines;
        this.headings = result.headings;
        this.tables = result.tables;
        this.starts = result.starts;
        this.spans = result.spans;
        const touches = (first: number, last: number) => edited !== null && last >= edited[0] && first <= edited[1];
        this.tableLayer.update(result.tables, result.lines, reset || result.tables.some(t => touches(t.start, t.end)));
        this.code.apply(result.codeBlocks, reset || result.codeBlocks.some(b => touches(b.startLine, b.endLine)));
        this.mermaid.update(result.codeBlocks);
        this.images.update(result.images);
        this.onHighlighted(result);
        this.updateCursor(true);
        if (this.syntaxTagger.pending) this.queueFill();
        else if (!this.fillQueued) {
            // Dokumen pendek: tidak ada yang ditunda, jangan tunda baris yang ditambahkan nanti.
            this.syntaxTagger.defer(Infinity);
            this.concealer.defer(Infinity);
        }
    }

    // true = semua baris sudah diberi tag (tidak ada cicilan penyorotan yang tersisa).
    get highlightComplete(): boolean {
        return !this.fillQueued && !this.syntaxTagger.pending;
    }

    // Cicil tag baris yang ditunda setText(). Baris di sekitar kursor dan yang sedang terlihat
    // didahulukan, jadi melompat ke akhir dokumen sebelum cicilan selesai tetap menampilkan
    // teks terformat. (Sebelum GTK selesai menata, area terlihat belum bisa dipercaya: baris
    // yang belum ditata setinggi 0. Karena itu posisi kursor ikut dipakai.)
    private queueFill(): void {
        if (this.destroyed || this.fillQueued) return;
        this.fillQueued = GLib.idle_add(FILL_PRIORITY, () => {
            // Teks berubah tetapi belum disorot: offset baris basi. highlight() (HIGH_IDLE) dulu.
            if (this.dirty) return GLib.SOURCE_CONTINUE;
            const start = GLib.get_monotonic_time();
            let done = false;
            while (!done && GLib.get_monotonic_time() - start < FILL_BUDGET_MS * 1000) {
                const visible = this.priorityLines();
                const spans = this.spans;
                this.syntaxTagger.applyLines(visible, i => spans[i], this.starts);
                const syntaxDone = this.syntaxTagger.fill(FILL_CHUNK_LINES, i => spans[i], this.starts);
                done = this.concealer.fill(FILL_CHUNK_LINES, visible) && syntaxDone;
            }
            if (!done) return GLib.SOURCE_CONTINUE;
            this.fillQueued = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    // Baris yang sedang terlihat dan FILL_CHUNK_LINES baris di sekitar kursor, urut naik.
    private priorityLines(): number[] {
        const rect = this.view.get_visible_rect();
        const [top] = this.view.get_line_at_y(rect.y);
        const [bottom] = this.view.get_line_at_y(rect.y + rect.height);
        const cursor = this.buffer.get_iter_at_mark(this.buffer.get_insert()).get_line();
        const lines = new Set<number>();
        // Sebelum validasi GTK, ribuan baris setinggi 0 bisa dianggap terlihat.
        // Jangan memasangnya sekaligus dan mengalahkan batas waktu cicilan.
        if (bottom.get_line() - top.get_line() <= FILL_FIRST_LINES)
            for (let l = top.get_line(); l <= bottom.get_line(); l++) lines.add(l);
        for (let l = cursor - FILL_CHUNK_LINES; l <= cursor + FILL_CHUNK_LINES; l++) lines.add(l);
        return [...lines].filter(l => l >= 0 && l < this.starts.length).sort((a, b) => a - b);
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
        // Teks sudah berubah tetapi belum disorot: markers dan nomor baris masih milik teks
        // lama. highlight() yang sudah antre akan memanggil updateCursor(true).
        if (this.dirty) {
            this.onCursorMoved(ins.get_line(), ins.get_line_offset());
            return;
        }
        const sel = buf.get_iter_at_mark(buf.get_selection_bound());
        const l0 = Math.min(ins.get_line(), sel.get_line());
        const l1 = Math.max(ins.get_line(), sel.get_line());

        // Dekorasi hanya perlu dihitung ulang jika baris aktif berubah.
        const key = `${l0}:${l1}`;
        if (force || key !== this.cursorKey) {
            this.cursorKey = key;
            this.concealer.apply(this.starts, l0, l1, !this.modes.source);
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
    onKey(keyval: number, state: number): boolean {
        if (state & (Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK)) return false;
        if (this.completer.onKey(keyval)) return true;
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

    // Tombol kiri ditekan di (x, y), koordinat widget TextView. count = klik ke berapa
    // (2 = klik ganda, yang dibiarkan untuk GTK memilih kata).
    onClick(count: number, x: number, y: number, state: number): boolean {
        if (count !== 1) return false;
        const [bx, by] = this.view.window_to_buffer_coords(Gtk.TextWindowType.WIDGET, Math.round(x), Math.round(y));
        const [ok, iter] = this.view.get_iter_at_location(bx, by);
        if (!ok) return false;

        if (toggleTaskAt(this.buffer, iter, this.tags)) return true;

        if (state & Gdk.ModifierType.CONTROL_MASK) {
            const wiki = wikiLinkAt(this.buffer, iter, this.tags);
            if (wiki) {
                this.onOpenNote(wiki);
                return true;
            }
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
            const bare = url.replace(/[#?].*$/, '');
            const path = GLib.path_is_absolute(bare) ? bare : GLib.build_filenamev([this.getBaseDir(), decodeURI(bare)]);
            // Tautan ke catatan Markdown lain dibuka di Nyerat sendiri, seperti [[wikilink]].
            if (/\.(md|markdown|mdown|mkd)$/i.test(path) && this.onOpenDocument(path)) return;
            uri = Gio.File.new_for_path(path).get_uri();
        }
        const root = this.view.get_root();
        new Gtk.UriLauncher({ uri }).launch(root instanceof Gtk.Window ? root : null, null, (launcher, result) => {
            try {
                launcher!.launch_finish(result);
            } catch {
                if (!this.destroyed) this.onMessage(`Tidak bisa membuka ${url}`);
            }
        });
    }
}
