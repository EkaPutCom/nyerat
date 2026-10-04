// Bilah pencarian (Ctrl+F) memakai GtkSource.SearchContext, yang juga menyorot
// semua hasil di editor.

import Gtk from 'gi://Gtk?version=4.0';
import GtkSource from 'gi://GtkSource?version=5';

export class FindBar {
    buffer: GtkSource.Buffer;
    view: Gtk.TextView;
    readonly settings: GtkSource.SearchSettings;
    context: GtkSource.SearchContext;
    readonly entry: Gtk.SearchEntry;
    readonly widget: Gtk.SearchBar;

    constructor(buffer: GtkSource.Buffer, view: Gtk.TextView) {
        this.buffer = buffer;
        this.view = view;
        this.settings = new GtkSource.SearchSettings({ wrap_around: true, case_sensitive: false });
        this.context = new GtkSource.SearchContext({ buffer, settings: this.settings });

        this.entry = new Gtk.SearchEntry({ width_chars: 32 });
        this.entry.connect('search-changed', () => {
            this.settings.search_text = this.entry.text || null;
            this.findNext(true);
        });
        this.entry.connect('activate', () => this.findNext());
        this.entry.connect('next-match', () => this.findNext());
        this.entry.connect('previous-match', () => this.findPrevious());
        this.entry.connect('stop-search', () => this.close());

        const prev = Gtk.Button.new_from_icon_name('go-up-symbolic');
        prev.connect('clicked', () => this.findPrevious());
        const next = Gtk.Button.new_from_icon_name('go-down-symbolic');
        next.connect('clicked', () => this.findNext());

        const box = new Gtk.Box({ spacing: 6 });
        box.append(this.entry);
        box.append(prev);
        box.append(next);

        this.widget = new Gtk.SearchBar({ show_close_button: true });
        this.widget.set_child(box);
        this.widget.connect_entry(this.entry);
        // Sorotan hasil hilang saat bilah ditutup.
        this.widget.connect('notify::search-mode-enabled', () => {
            this.settings.search_text = this.widget.search_mode_enabled ? (this.entry.text || null) : null;
        });
    }

    // Pindah ke editor lain (berganti tab). Teks pencarian tetap; sorotan hasil di buffer lama dilepas.
    setTarget(buffer: GtkSource.Buffer, view: Gtk.TextView): void {
        if (buffer === this.buffer) return;
        this.buffer = buffer;
        this.view = view;
        this.context = new GtkSource.SearchContext({ buffer, settings: this.settings });
    }

    open(): void {
        this.widget.search_mode_enabled = true;
        this.entry.grab_focus();
    }

    close(): void {
        this.widget.search_mode_enabled = false;
        this.view.grab_focus();
    }

    // fromSelectionStart: saat teks pencarian berubah, cari mulai dari awal seleksi
    // supaya hasil yang sedang terpilih tetap dipakai jika masih cocok.
    findNext(fromSelectionStart = false): void {
        if (!this.settings.search_text) return;
        const [has, s, e] = this.buffer.get_selection_bounds();
        const from = has ? (fromSelectionStart ? s : e) : this.buffer.get_iter_at_mark(this.buffer.get_insert());
        this.select(this.context.forward(from));
    }

    findPrevious(): void {
        if (!this.settings.search_text) return;
        const [has, s] = this.buffer.get_selection_bounds();
        this.select(this.context.backward(has ? s : this.buffer.get_iter_at_mark(this.buffer.get_insert())));
    }

    private select([found, start, end]: [boolean, Gtk.TextIter | null, Gtk.TextIter | null, boolean]): void {
        if (!found || !start || !end) return;
        this.buffer.select_range(start, end);
        this.view.scroll_to_iter(start, 0.1, false, 0, 0);
    }
}
