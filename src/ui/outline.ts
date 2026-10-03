// Tab Outline di sidebar: daftar heading dokumen. Klik heading untuk melompat ke sana.

import Gtk from 'gi://Gtk?version=3.0';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import type { Heading } from '../editor/highlighter.js';

export class Outline {
    readonly list: Gtk.ListBox;
    readonly widget: Gtk.Box;
    onJump: (line: number) => void = () => {};  // heading diklik

    private headings: Heading[] = [];
    private signature = '';

    constructor() {
        this.list = new Gtk.ListBox({ activate_on_single_click: true });
        this.list.set_selection_mode(Gtk.SelectionMode.NONE);
        this.list.connect('row-activated', (_list, row) => this.onJump(this.headings[row.get_index()].line));
        const placeholder = new Gtk.Label({ label: 'Belum ada heading', margin: 16 });
        placeholder.get_style_context().add_class('dim-label');
        placeholder.show();
        this.list.set_placeholder(placeholder);

        const title = new Gtk.Label({ label: 'OUTLINE', xalign: 0, margin_start: 16, margin_top: 4, margin_bottom: 8 });
        title.get_style_context().add_class('side-title');
        const scroll = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true });
        scroll.add(this.list);

        this.widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        this.widget.pack_start(title, false, false, 0);
        this.widget.pack_start(scroll, true, true, 0);
        this.widget.show_all();
    }

    // headings dari editor/highlighter.ts
    update(headings: Heading[]): void {
        // Daftar dibangun ulang hanya jika heading benar-benar berubah.
        const signature = JSON.stringify(headings);
        if (signature === this.signature) return;
        this.signature = signature;
        this.headings = headings;

        for (const child of this.list.get_children()) child.destroy();
        for (const h of headings) {
            const text = h.text || '(kosong)';
            const label = new Gtk.Label({
                label: text, xalign: 0, ellipsize: Pango.EllipsizeMode.END,
                margin_start: 16 + (h.level - 1) * 14, margin_end: 12,
            });
            if (h.level === 1) label.set_markup(`<b>${GLib.markup_escape_text(text, -1)}</b>`);
            const row = new Gtk.ListBoxRow();
            row.add(label);
            row.show_all();
            this.list.add(row);
        }
    }
}
