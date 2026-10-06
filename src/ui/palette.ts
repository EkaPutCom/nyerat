// Palet perintah (Ctrl+Shift+P): daftar semua aksi aplikasi yang bisa dicari lalu dijalankan.
//
// Daftarnya Gio.ListStore → Gtk.FilterListModel → Gtk.SingleSelection → Gtk.ListView; mengetik
// hanya mengubah filter, tidak ada widget baris yang dibuat atau dibuang manual. Yang dijalankan
// adalah Gio.Action yang sama dengan tombol, menu, dan pintasan.

import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import { COMMAND_LABELS } from '../commands.js';
import { uiTemplate } from '../gtkutil.js';
import template from './palette.ui?raw';

// Satu baris palet: nama aksi (tanpa awalan "app."), label, dan pintasannya.
export class Command extends GObject.Object {
    static {
        GObject.registerClass({
            GTypeName: 'NyeratCommand',
            Properties: {
                name: GObject.ParamSpec.string('name', null, null, GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY, ''),
                label: GObject.ParamSpec.string('label', null, null, GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY, ''),
                accel: GObject.ParamSpec.string('accel', null, null, GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY, ''),
            },
        }, this);
    }
    declare name: string;
    declare label: string;
    declare accel: string;
}

// Aksi aplikasi yang aktif dan punya label, sebagai model daftar.
export function commandStore(app: Gtk.Application): Gio.ListStore {
    const store = new Gio.ListStore({ item_type: Command.$gtype });
    for (const [name, label] of Object.entries(COMMAND_LABELS)) {
        if (name === 'command-palette' || !app.lookup_action(name)?.enabled) continue;
        const [accel] = app.get_accels_for_action(`app.${name}`);
        const parsed = accel ? Gtk.accelerator_parse(accel) : null;
        store.append(new Command({ name, label, accel: parsed?.[0] ? Gtk.accelerator_get_label(parsed[1], parsed[2]!) : '' }));
    }
    return store;
}

export class CommandPalette extends Adw.Dialog {
    static {
        GObject.registerClass({
            GTypeName: 'NyeratCommandPalette',
            Template: uiTemplate(template),
            InternalChildren: ['search', 'list'],
        }, this);
    }
    declare _search: Gtk.SearchEntry;
    declare _list: Gtk.ListView;

    private readonly selection: Gtk.SingleSelection;

    constructor(private readonly app: Gtk.Application) {
        super();
        const filter = Gtk.CustomFilter.new(item => {
            const query = this._search.text.trim().toLowerCase();
            const label = (item as Command).label.toLowerCase();
            // Setiap kata yang diketik harus ada di label, urutan bebas.
            return query.split(/\s+/).every(word => label.includes(word));
        });
        this.selection = new Gtk.SingleSelection({ model: new Gtk.FilterListModel({ model: commandStore(app), filter }) });
        this._list.model = this.selection;
        this._list.factory = this.createFactory();

        this._search.connect('search-changed', () => filter.changed(Gtk.FilterChange.DIFFERENT));
        this._search.connect('activate', () => this.run(this.selection.selected));
        this._search.connect('next-match', () => this.move(1));
        this._search.connect('previous-match', () => this.move(-1));
        this._list.connect('activate', (_list, position) => this.run(position));
    }

    // Jumlah perintah yang lolos filter (untuk tes).
    get visibleCount(): number {
        return this.selection.get_n_items();
    }

    private move(step: number): void {
        const count = this.selection.get_n_items();
        if (count) this.selection.selected = Math.max(0, Math.min(count - 1, this.selection.selected + step));
        this._list.scroll_to(this.selection.selected, Gtk.ListScrollFlags.NONE, null);
    }

    private run(position: number): void {
        const command = this.selection.get_item(position) as Command | null;
        if (!command) return;
        this.close();
        // Setelah dialog tertutup: aksi bisa membuka dialog lain atau memindahkan fokus.
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { this.app.activate_action(command.name, null); return GLib.SOURCE_REMOVE; });
    }

    private createFactory(): Gtk.SignalListItemFactory {
        const factory = new Gtk.SignalListItemFactory();
        factory.connect('setup', (_f, item) => {
            const row = new Gtk.Box({ spacing: 12 });
            row.append(new Gtk.Label({ xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END }));
            const accel = new Gtk.Label({ xalign: 1 });
            accel.add_css_class('dim-label');
            row.append(accel);
            (item as Gtk.ListItem).child = row;
        });
        factory.connect('bind', (_f, item) => {
            const listItem = item as Gtk.ListItem;
            const command = listItem.item as Command;
            const row = listItem.child as Gtk.Box;
            (row.get_first_child() as Gtk.Label).label = command.label;
            (row.get_last_child() as Gtk.Label).label = command.accel;
        });
        return factory;
    }
}
