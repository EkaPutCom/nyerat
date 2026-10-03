// Sidebar outline: daftar heading dokumen. Klik heading untuk melompat ke sana.

import Gtk from 'gi://Gtk?version=3.0';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

export class Outline {
    constructor() {
        this.onJump = () => {};  // dipanggil dengan nomor baris heading
        this._signature = '';

        this.list = new Gtk.ListBox({ activate_on_single_click: true });
        this.list.set_selection_mode(Gtk.SelectionMode.NONE);
        this.list.connect('row-activated', (_, row) => this.onJump(row._line));
        const placeholder = new Gtk.Label({ label: 'Belum ada heading', margin: 16 });
        placeholder.get_style_context().add_class('dim-label');
        placeholder.show();
        this.list.set_placeholder(placeholder);

        const title = new Gtk.Label({ label: 'OUTLINE', xalign: 0, margin_start: 16, margin_top: 14, margin_bottom: 8 });
        title.get_style_context().add_class('side-title');
        const scroll = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true });
        scroll.add(this.list);

        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, width_request: 230 });
        box.get_style_context().add_class('sidebar');
        box.pack_start(title, false, false, 0);
        box.pack_start(scroll, true, true, 0);
        const wrap = new Gtk.Box();
        wrap.pack_start(box, true, true, 0);
        wrap.pack_start(new Gtk.Separator({ orientation: Gtk.Orientation.VERTICAL }), false, false, 0);

        this.widget = new Gtk.Revealer({ transition_type: Gtk.RevealerTransitionType.SLIDE_RIGHT, transition_duration: 150 });
        this.widget.add(wrap);
    }

    setVisible(visible) {
        this.widget.set_reveal_child(visible);
    }

    // headings: [{ level, text, line }] dari editor/highlighter.js
    update(headings) {
        // Daftar dibangun ulang hanya jika heading benar-benar berubah.
        const signature = JSON.stringify(headings);
        if (signature === this._signature) return;
        this._signature = signature;

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
            row._line = h.line;
            row.show_all();
            this.list.add(row);
        }
    }
}
