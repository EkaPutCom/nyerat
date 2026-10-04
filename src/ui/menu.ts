// Menu konteks (klik kanan / tombol ⋯) untuk GTK 4.
//
// Isi menu dinyatakan sebagai data (MenuEntry[]) supaya mudah diuji tanpa membuka popover:
// tes cukup mencari entri berdasarkan label lalu memanggil run(). popupMenu() mengubahnya
// menjadi Gtk.PopoverMenu, yang di GTK 4 hanya menerima Gio.MenuModel berisi nama aksi.

import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Satu item menu. Label kosong = pemisah bagian; submenu = item berisi menu turunan.
export interface MenuEntry {
    label: string;
    enabled?: boolean;   // default true
    run?: () => void;
    submenu?: MenuEntry[];
}

export const separator = (): MenuEntry => ({ label: '' });

// Cari entri berdasarkan label (juga di dalam submenu).
export function findEntry(entries: MenuEntry[], label: string): MenuEntry | undefined {
    for (const entry of entries) {
        if (entry.label === label) return entry;
        const inner = entry.submenu && findEntry(entry.submenu, label);
        if (inner) return inner;
    }
    return undefined;
}

// Bangun Gio.Menu dan aksinya (di grup `group`, awalan "menu.").
function buildModel(entries: MenuEntry[], group: Gio.SimpleActionGroup, counter: { n: number }): Gio.Menu {
    const model = new Gio.Menu();
    let section = new Gio.Menu();
    model.append_section(null, section);
    for (const entry of entries) {
        if (!entry.label) {
            section = new Gio.Menu();
            model.append_section(null, section);
            continue;
        }
        const name = `item${counter.n++}`;
        const enabled = entry.enabled !== false;
        if (entry.submenu) {
            const item = Gio.MenuItem.new_submenu(entry.label, buildModel(entry.submenu, group, counter));
            // Submenu yang tidak aktif: diberi aksi yang mati supaya tampil redup.
            if (!enabled) {
                group.add_action(new Gio.SimpleAction({ name, enabled: false }));
                item.set_attribute_value('submenu-action', GLib.Variant.new_string(`menu.${name}`));
            }
            section.append_item(item);
            continue;
        }
        const action = new Gio.SimpleAction({ name, enabled });
        const run = entry.run;
        // Ditunda ke idle: dialog yang dibuka dari aksi tidak boleh muncul selagi popover
        // masih menutup, dan aksi sering menggambar ulang widget pemilik popover.
        if (run) action.connect('activate', () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { run(); return GLib.SOURCE_REMOVE; }));
        group.add_action(action);
        section.append(entry.label, `menu.${name}`);
    }
    return model;
}

// Tampilkan menu di dekat `parent`. (x, y) = titik di koordinat parent (misalnya posisi
// klik kanan); tanpa itu menu menunjuk ke seluruh widget (tombol ⋯).
export function popupMenu(parent: Gtk.Widget, entries: MenuEntry[], x?: number, y?: number): Gtk.PopoverMenu {
    const group = new Gio.SimpleActionGroup();
    const model = buildModel(entries, group, { n: 0 });
    parent.insert_action_group('menu', group);
    const popover = Gtk.PopoverMenu.new_from_model(model);
    popover.set_has_arrow(x === undefined);
    if (x !== undefined && y !== undefined) {
        popover.set_halign(Gtk.Align.START);
        popover.set_pointing_to(new Gdk.Rectangle({ x: Math.round(x), y: Math.round(y), width: 1, height: 1 }));
    }
    popover.set_parent(parent);
    // Popover adalah anak widget pemiliknya; lepaskan setelah tertutup supaya tidak menumpuk.
    popover.connect('closed', () => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        if (popover.get_parent()) popover.unparent();
        return GLib.SOURCE_REMOVE;
    }));
    popover.popup();
    return popover;
}
