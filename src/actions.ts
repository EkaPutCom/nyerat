// Semua aksi aplikasi beserta shortcut-nya, di satu tempat.
//
// Aksi (Gio.SimpleAction) dipicu oleh tombol header bar, item menu, atau shortcut.
// Aksi "toggle" punya status on/off yang otomatis tampil sebagai centang di menu.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { wrapSelection, insertLink, insertBlock, togglePrefix, setHeading } from './editor/editing.js';
import { showAbout } from './ui/dialogs.js';
import type Gtk from 'gi://Gtk?version=3.0';
import type { TableCommand } from './editor/tableedit.js';
import type { MainWindow, Option } from './window.js';

const TABLE_TEMPLATE: [before: string, after: string] = ['| Kolom 1 | Kolom 2 | Kolom 3 |\n| ------- | ------- | ------- |\n| ', ' |  |  |\n'];

// Aksi yang menyunting teks dokumen. Saat papan kanban tampil, teksnya tersembunyi, jadi
// aksi ini ditolak dengan pesan alih-alih mengubah teks yang tidak terlihat.
const TEXT_ACTIONS = new Set([
    'find', 'bold', 'italic', 'strike', 'inline-code', 'highlight', 'link', 'image', 'zoom-image', 'codeblock', 'table',
    'quote', 'ulist', 'olist', 'heading0', 'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6',
    'table-row-below', 'table-row-above', 'table-delete-row', 'table-col-right', 'table-col-left', 'table-delete-col',
    'table-align-left', 'table-align-center', 'table-align-right', 'table-format',
]);

export function registerActions(app: Gtk.Application, w: MainWindow): void {
    const action = (name: string, accels: string[] | null, run: () => void) => {
        const a = new Gio.SimpleAction({ name });
        a.connect('activate', () => {
            if (w.boardMode && TEXT_ACTIONS.has(name)) w.statusBar.toast('Beralih ke tampilan teks (Ctrl+Shift+B) untuk menyunting');
            else run();
        });
        app.add_action(a);
        if (accels) app.set_accels_for_action(`app.${name}`, accels);
    };
    const toggle = (name: Option, accels: string[], initial: boolean) => {
        const a = Gio.SimpleAction.new_stateful(name, null, GLib.Variant.new_boolean(initial));
        a.connect('change-state', (act, value) => {
            if (!value) return;
            act.set_state(value);
            w.setOption(name, value.get_boolean());
        });
        app.add_action(a);
        if (accels) app.set_accels_for_action(`app.${name}`, accels);
    };

    // File
    action('new', ['<Control>n'], () => w.newDocument());
    action('close-tab', ['<Control>w'], () => w.closeTab());
    action('next-tab', ['<Control>Page_Down', '<Control>Tab'], () => w.switchTab(1));
    action('prev-tab', ['<Control>Page_Up', '<Control><Shift>Tab', '<Control><Shift>ISO_Left_Tab'], () => w.switchTab(-1));
    action('open', ['<Control>o'], () => w.open());
    action('open-folder', ['<Control><Shift>o'], () => w.chooseFolder());
    action('save', ['<Control>s'], () => w.save());

    // Undo/redo lewat aksi, supaya juga bekerja saat papan kanban tampil (editor teks tidak
    // berfokus). Di tampilan teks hasilnya sama dengan pintasan bawaan GtkSourceView.
    action('undo', ['<Control>z'], () => w.editor.buffer.undo());
    action('redo', ['<Control><Shift>z', '<Control>y'], () => w.editor.buffer.redo());

    // Papan kanban
    action('kanban-new', null, () => w.newBoardDocument());
    const view = Gio.SimpleAction.new_stateful('kanban-view', null, GLib.Variant.new_boolean(false));
    view.connect('change-state', (_a, value) => { if (value) w.toggleBoardView(value.get_boolean()); });
    app.add_action(view);
    app.set_accels_for_action('app.kanban-view', ['<Control><Shift>b']);
    action('save-as', ['<Control><Shift>s'], () => w.saveAs());
    action('export-html', ['<Control><Shift>e'], () => w.exportHtml());
    action('quit', ['<Control>q'], () => w.win.close());
    action('about', null, () => showAbout(w.win));
    action('find', ['<Control>f'], () => w.findBar.open());

    // Format inline
    action('bold', ['<Control>b'], () => wrapSelection(w.editor.buffer, '**'));
    action('italic', ['<Control>i'], () => wrapSelection(w.editor.buffer, '*'));
    action('strike', ['<Alt><Shift>5', '<Control><Shift>x'], () => wrapSelection(w.editor.buffer, '~~'));
    action('inline-code', ['<Control>grave'], () => wrapSelection(w.editor.buffer, '`'));
    action('highlight', ['<Control><Shift>h'], () => wrapSelection(w.editor.buffer, '=='));
    action('link', ['<Control>k'], () => insertLink(w.editor.buffer));
    action('image', ['<Control><Shift>i'], () => w.insertImage());
    action('zoom-image', null, () => w.editor.zoomImage());

    // Blok
    action('codeblock', ['<Control><Shift>k'], () => insertBlock(w.editor.buffer, '```\n', '\n```'));
    action('table', ['<Control>t'], () => insertBlock(w.editor.buffer, ...TABLE_TEMPLATE));

    // Edit tabel di posisi kursor
    const tableActions: [string, TableCommand, string[] | null][] = [
        ['table-row-below', 'row-below', null], ['table-row-above', 'row-above', null], ['table-delete-row', 'delete-row', null],
        ['table-col-right', 'col-right', null], ['table-col-left', 'col-left', null], ['table-delete-col', 'delete-col', null],
        ['table-align-left', 'align-left', null], ['table-align-center', 'align-center', null], ['table-align-right', 'align-right', null],
        ['table-format', 'format', ['<Control><Shift>t']],
    ];
    for (const [name, command, accels] of tableActions) action(name, accels, () => w.editor.tableCommand(command));
    action('quote', ['<Control><Shift>q'], () => togglePrefix(w.editor.buffer, /^>\s?/, '> '));
    action('ulist', ['<Control><Shift>bracketright'], () => togglePrefix(w.editor.buffer, /^[-*+]\s+/, '- '));
    action('olist', ['<Control><Shift>bracketleft'], () => togglePrefix(w.editor.buffer, /^\d+[.)]\s+/, '1. '));
    for (let n = 0; n <= 6; n++)
        action(`heading${n}`, [`<Control>${n}`], () => setHeading(w.editor.buffer, n));

    // Tampilan
    const s = w.settings;
    toggle('sidebar', ['<Control>backslash', '<Control><Shift>1'], s.sidebar);
    toggle('chat', ['<Control><Shift>a'], s.chat);
    toggle('source', ['<Control>slash'], false);
    toggle('focus', ['F8'], s.focus);
    toggle('typewriter', ['F9'], s.typewriter);
    toggle('dark', ['<Control><Shift>d'], w.dark);
    toggle('autosave', [], s.autosave);
}
