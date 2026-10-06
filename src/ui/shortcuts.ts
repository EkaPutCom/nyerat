// Dialog daftar pintasan keyboard (Ctrl+?), disusun dari aksi yang terdaftar di actions.ts:
// label dari COMMAND_LABELS, tombol dari accel yang benar-benar dipasang, jadi daftar ini
// tidak bisa berbeda dari pintasan yang berlaku.
//
// libadwaita ≥ 1.8 (GNOME 49+) punya Adw.ShortcutsDialog, pengganti Gtk.ShortcutsWindow yang
// usang sejak GTK 4.18. Di libadwaita yang lebih tua (mis. 1.5 di Ubuntu 24.04) isinya ditampilkan
// sebagai Adw.Dialog berisi daftar baris dengan Gtk.ShortcutLabel. Gtk.ShortcutsWindow tidak dipakai:
// selain usang, di GTK 4.14 label internalnya memicu Gtk-WARNING "reported min width -4".

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import { COMMAND_LABELS } from '../commands.js';
import { _ } from '../i18n.js';

// Bagian dialog dan aksi di dalamnya, urut seperti yang tampil.
export const SHORTCUT_SECTIONS = (): [title: string, actions: string[]][] => [
    [_('Berkas'), ['new', 'open', 'open-folder', 'save', 'save-as', 'export-html']],
    [_('Tab'), ['next-tab', 'prev-tab', 'close-tab']],
    [_('Penyuntingan'), ['undo', 'redo', 'find']],
    [_('Format'), ['bold', 'italic', 'strike', 'inline-code', 'highlight', 'link', 'image', 'codeblock', 'table', 'quote', 'ulist', 'olist']],
    [_('Tabel'), ['table-row-below', 'table-row-above', 'table-delete-row', 'table-col-right', 'table-col-left', 'table-delete-col', 'table-format']],
    [_('Tampilan'), ['sidebar', 'chat', 'kanban-view', 'source', 'focus', 'typewriter', 'dark']],
    [_('Umum'), ['command-palette', 'preferences', 'shortcuts', 'quit']],
];

// Aksi yang punya accel, per bagian; bagian tanpa pintasan dilewati.
export function shortcutEntries(app: Gtk.Application): [title: string, items: [label: string, accel: string][]][] {
    return SHORTCUT_SECTIONS()
        .map(([title, actions]) => [title, actions.flatMap(name => {
            const accel = app.get_accels_for_action(`app.${name}`)[0];
            return accel ? [[COMMAND_LABELS[name] ?? name, accel] as [string, string]] : [];
        })] as [string, [string, string][]])
        .filter(([, items]) => items.length > 0);
}

// Adw.ShortcutsDialog ada sejak libadwaita 1.8.
export const hasAdwShortcutsDialog = (): boolean => 'ShortcutsDialog' in Adw;

export const SHORTCUTS_TITLE = (): string => _('Pintasan Keyboard');

export function showShortcuts(app: Gtk.Application, parent: Gtk.Window): Adw.Dialog {
    const entries = shortcutEntries(app);
    if (hasAdwShortcutsDialog()) {
        const dialog = new Adw.ShortcutsDialog({ title: SHORTCUTS_TITLE() });
        for (const [title, items] of entries) {
            const section = new Adw.ShortcutsSection({ title });
            for (const [label, accelerator] of items) section.add(new Adw.ShortcutsItem({ title: label, accelerator }));
            dialog.add(section);
        }
        dialog.present(parent);
        return dialog;
    }
    const page = new Adw.PreferencesPage();
    for (const [title, items] of entries) {
        const group = new Adw.PreferencesGroup({ title });
        for (const [label, accelerator] of items) {
            const row = new Adw.ActionRow({ title: label });
            row.add_suffix(new Gtk.ShortcutLabel({ accelerator, valign: Gtk.Align.CENTER }));
            group.add(row);
        }
        page.add(group);
    }
    const view = new Adw.ToolbarView({ content: page });
    view.add_top_bar(new Adw.HeaderBar());
    const dialog = new Adw.Dialog({ title: SHORTCUTS_TITLE(), content_width: 520, content_height: 640 });
    dialog.set_child(view);
    dialog.present(parent);
    return dialog;
}
