// Tab Outline di sidebar: daftar heading dokumen. Klik heading untuk melompat ke sana.
//
// Heading disimpan di Gio.ListStore dan ditampilkan Gtk.ListView, yang hanya membuat widget untuk
// baris yang terlihat. Dokumen dengan ribuan heading tidak perlu dicicil.

import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import type { Heading } from '../editor/highlighter.js';
import { _ } from '../i18n.js';

// Satu baris outline: hanya yang memengaruhi tampilannya. Nomor baris tujuan klik dibaca dari daftar heading terbaru.
export class HeadingItem extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: 'NyeratHeadingItem',
            Properties: {
                level: GObject.ParamSpec.int('level', null, null, GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY, 1, 6, 1),
                text: GObject.ParamSpec.string('text', null, null, GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY, ''),
            },
        }, this);
    }
    declare level: number;
    declare text: string;
}

const SMALL = 8;    // perubahan sebesar ini (mis. menyunting satu heading) langsung diterapkan
const CHUNK = 25;   // item outline baru per giliran saat dicicil

interface Shown { level: number; text: string }

export class Outline {
    readonly store = new Gio.ListStore({ item_type: HeadingItem.$gtype });
    readonly list: Gtk.ListView;
    readonly widget: Gtk.Box;
    onJump: (line: number) => void = () => {};  // heading diklik

    private headings: Heading[] = [];
    private shown: Shown[] = [];   // isi store saat ini (bisa tertinggal dari headings selagi dicicil)
    private filling = 0;

    constructor() {
        const factory = new Gtk.SignalListItemFactory();
        factory.connect('setup', (_f, item) => {
            (item as Gtk.ListItem).child = new Gtk.Label({ xalign: 0, ellipsize: Pango.EllipsizeMode.END, margin_end: 12 });
        });
        factory.connect('bind', (_f, item) => {
            const listItem = item as Gtk.ListItem;
            const heading = listItem.item as HeadingItem;
            const label = listItem.child as Gtk.Label;
            const text = heading.text || '(kosong)';
            label.margin_start = 16 + (heading.level - 1) * 14;
            if (heading.level === 1) label.set_markup(`<b>${GLib.markup_escape_text(text, -1)}</b>`);
            else label.set_label(text);
        });
        this.list = new Gtk.ListView({ model: new Gtk.NoSelection({ model: this.store }), factory, single_click_activate: true });
        this.list.add_css_class('navigation-sidebar');
        this.list.connect('activate', (_list, position) => {
            const heading = this.headings[position];
            if (heading) this.onJump(heading.line);
        });

        const placeholder = new Gtk.Label({ label: _('Belum ada heading'), margin_top: 16, margin_bottom: 16, margin_start: 16, margin_end: 16, valign: Gtk.Align.START });
        placeholder.add_css_class('dim-label');
        const scroll = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true, child: this.list });
        const pages = new Gtk.Stack();
        pages.add_named(scroll, 'list');
        pages.add_named(placeholder, 'empty');
        pages.visible_child_name = 'empty';
        this.store.connect('items-changed', () => { pages.visible_child_name = this.store.n_items ? 'list' : 'empty'; });

        const title = new Gtk.Label({ label: _('OUTLINE'), xalign: 0, margin_start: 16, margin_top: 4, margin_bottom: 8 });
        title.add_css_class('side-title');
        this.widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        this.widget.append(title);
        this.widget.append(pages);
    }

    get count(): number {
        return this.store.n_items;
    }

    // headings dari editor/highlighter.ts
    update(headings: Heading[]): void {
        // Pergeseran baris mengubah tujuan klik, bukan tampilan label.
        this.headings = headings;
        if (this.filling || this.step(SMALL)) return;
        // Membuka dokumen lain: membuat semua item sekaligus menahan main loop (±0,1 ms per item,
        // ±20 ms untuk 440 heading). Perubahan besar dicicil di idle setelah frame digambar
        // (GDK_PRIORITY_REDRAW = HIGH_IDLE + 20), tetapi sebelum cicilan tag editor (+22).
        this.filling = GLib.idle_add(GLib.PRIORITY_HIGH_IDLE + 21, () => {
            if (!this.step(CHUNK)) return GLib.SOURCE_CONTINUE;
            this.filling = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    // Samakan store dengan heading terbaru, paling banyak `limit` item baru (tanpa menyentuh store
    // bila perubahannya lebih besar dari itu dan limit = SMALL). true = sudah sama.
    // Awalan dan akhiran yang sama dipertahankan: mengedit satu heading hanya mengganti satu item,
    // jadi baris lain tidak digambar ulang.
    private step(limit: number): boolean {
        const shown = this.shown, headings = this.headings;
        const same = (a: Shown, b: Heading) => a.level === b.level && a.text === b.text;
        let first = 0, oldEnd = shown.length, newEnd = headings.length;
        while (first < oldEnd && first < newEnd && same(shown[first], headings[first])) first++;
        while (oldEnd > first && newEnd > first && same(shown[oldEnd - 1], headings[newEnd - 1])) { oldEnd--; newEnd--; }
        if (first === oldEnd && first === newEnd) return true;
        if (limit === SMALL && newEnd - first > SMALL) return false;
        const added = headings.slice(first, Math.min(newEnd, first + limit)).map(({ level, text }) => ({ level, text }));
        this.shown.splice(first, oldEnd - first, ...added);
        this.store.splice(first, oldEnd - first, added.map(({ level, text }) => new HeadingItem({ level, text })));
        return first + added.length === newEnd;
    }
}
