// MarkdownView: widget editor ala Typora.
//
// Menyatukan GtkSourceView dengan modul-modul di folder ini:
//   tags.js         gaya teks
//   highlighter.js  dijalankan setiap teks berubah
//   decorations.js  dijalankan setiap kursor pindah baris
//   lists.js        Enter dan Tab
//   clicks.js       klik kotak tugas dan Ctrl+klik tautan
//   images.js       gambar ditampilkan di bawah barisnya
//
// Widget ini tidak tahu apa-apa soal file, menu, atau sidebar. Ia memberi kabar
// lewat callback yang dipasang oleh jendela (window.js):
//   onHighlighted({ text, headings })   setelah penyorotan
//   onCursorMoved(line, column)         setelah kursor pindah
//   onMessage(text)                     pesan singkat untuk pengguna
//   getBaseDir()                        folder untuk tautan relatif

import Gtk from 'gi://Gtk?version=3.0';
import Gdk from 'gi://Gdk?version=3.0';
import GtkSource from 'gi://GtkSource?version=4';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { createTags, paintTags, setTagMargins } from './tags.js';
import { highlight } from './highlighter.js';
import { concealMarkers, dimOutsideParagraph } from './decorations.js';
import { continueBlock, indentListItem, isInCodeBlock } from './lists.js';
import { toggleTaskAt, linkAt } from './clicks.js';
import { ImageLayer } from './images.js';

const TEXT_WIDTH = 780;  // lebar kolom teks maksimum, dalam piksel

export class MarkdownView {
    constructor() {
        this.markers = [];
        this.headings = [];
        this.lines = [];
        this.modes = { source: false, focus: false, typewriter: false };

        this.onHighlighted = () => {};
        this.onCursorMoved = () => {};
        this.onMessage = () => {};
        this.getBaseDir = () => GLib.get_home_dir();

        this._margin = -1;
        this._cursorKey = '';
        this._highlightQueued = false;
        this._cursorQueued = false;
        this._cursorForce = false;

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

        this.images = new ImageLayer(this.view);
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
        this.widget.connect('size-allocate', (_w, alloc) => this._updateMargins(alloc.width));
        this.view.connect('key-press-event', (_w, ev) => this.onKey(ev));
        this.view.connect('button-press-event', (_w, ev) => this.onClick(ev));
    }

    // ---------- Isi dan tampilan ----------

    getText() {
        const [s, e] = this.buffer.get_bounds();
        return this.buffer.get_text(s, e, true);
    }

    // Ganti seluruh isi tanpa masuk riwayat undo (dipakai saat membuka file).
    setText(text) {
        const buf = this.buffer;
        buf.begin_not_undoable_action();
        buf.set_text(text, -1);
        buf.end_not_undoable_action();
        buf.set_modified(false);
        buf.place_cursor(buf.get_start_iter());
        this.highlight();
    }

    setPalette(palette) {
        paintTags(this.tags, palette);
    }

    // name: 'source' | 'focus' | 'typewriter'
    setMode(name, enabled) {
        this.modes[name] = enabled;
        if (name === 'source') this.images.setEnabled(!enabled);
        this.queueCursorUpdate(true);
    }

    jumpToLine(n) {
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
    _updateMargins(width) {
        const m = Math.max(36, Math.floor((width - TEXT_WIDTH) / 2));
        if (m === this._margin && width === this._width) return;
        this._margin = m;
        this._width = width;
        // Jangan ubah ukuran di dalam size-allocate; tunda ke idle.
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.view.set_left_margin(m);
            this.view.set_right_margin(m);
            setTagMargins(this.tags, m);
            this.images.setMaxWidth(width - 2 * m);
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

    queueHighlight() {
        if (this._highlightQueued) return;
        this._highlightQueued = true;
        GLib.idle_add(GLib.PRIORITY_HIGH_IDLE, () => {
            this._highlightQueued = false;
            this.highlight();
            return GLib.SOURCE_REMOVE;
        });
    }

    highlight() {
        const result = highlight(this.buffer, this.tags);
        this.markers = result.markers;
        this.lines = result.lines;
        this.headings = result.headings;
        this.images.update(result.images);
        this.onHighlighted(result);
        this.updateCursor(true);
    }

    queueCursorUpdate(force = false) {
        this._cursorForce ||= force;
        if (this._cursorQueued) return;
        this._cursorQueued = true;
        GLib.idle_add(GLib.PRIORITY_HIGH_IDLE, () => {
            this._cursorQueued = false;
            this.updateCursor(this._cursorForce);
            this._cursorForce = false;
            return GLib.SOURCE_REMOVE;
        });
    }

    updateCursor(force = false) {
        const buf = this.buffer;
        const ins = buf.get_iter_at_mark(buf.get_insert());
        const sel = buf.get_iter_at_mark(buf.get_selection_bound());
        const l0 = Math.min(ins.get_line(), sel.get_line());
        const l1 = Math.max(ins.get_line(), sel.get_line());

        // Dekorasi hanya perlu dihitung ulang jika baris aktif berubah.
        const key = `${l0}:${l1}`;
        if (force || key !== this._cursorKey) {
            this._cursorKey = key;
            concealMarkers(buf, this.tags.hidden, this.markers, l0, l1, !this.modes.source);
            dimOutsideParagraph(buf, this.tags.dim, this.lines, l0, l1, this.modes.focus);
            if (this.modes.typewriter)
                this.view.scroll_to_mark(buf.get_insert(), 0, true, 0, 0.5);
        }
        this.onCursorMoved(ins.get_line(), ins.get_line_offset());
    }

    // ---------- Input ----------

    // Dipanggil untuk setiap tombol. true = sudah ditangani, GTK tidak memprosesnya lagi.
    onKey(ev) {
        const [, keyval] = ev.get_keyval();
        const [, state] = ev.get_state();
        if (state & (Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.MOD1_MASK)) return false;
        if (this.buffer.get_has_selection()) return false;
        const shift = (state & Gdk.ModifierType.SHIFT_MASK) !== 0;

        if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) {
            if (shift) return false;
            const line = this.buffer.get_iter_at_mark(this.buffer.get_insert()).get_line();
            if (isInCodeBlock(this.lines, line)) return false;
            if (!continueBlock(this.buffer)) return false;
            this.view.scroll_mark_onscreen(this.buffer.get_insert());
            return true;
        }
        if (keyval === Gdk.KEY_Tab || keyval === Gdk.KEY_ISO_Left_Tab)
            return indentListItem(this.buffer, shift || keyval === Gdk.KEY_ISO_Left_Tab);
        return false;
    }

    onClick(ev) {
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

    openUrl(url) {
        let uri = url;
        if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) {
            const path = GLib.path_is_absolute(url) ? url : GLib.build_filenamev([this.getBaseDir(), decodeURI(url)]);
            uri = Gio.File.new_for_path(path).get_uri();
        }
        try {
            Gtk.show_uri_on_window(this.view.get_toplevel(), uri, Gdk.CURRENT_TIME);
        } catch (e) {
            this.onMessage(`Tidak bisa membuka ${url}`);
        }
    }
}
