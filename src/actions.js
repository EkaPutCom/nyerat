// Semua aksi aplikasi beserta shortcut-nya, di satu tempat.
//
// Aksi (Gio.SimpleAction) dipicu oleh tombol header bar, item menu, atau shortcut.
// Aksi "toggle" punya status on/off yang otomatis tampil sebagai centang di menu.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { wrapSelection, insertLink, insertBlock, togglePrefix, setHeading } from './editor/editing.js';
import { showAbout } from './ui/dialogs.js';

const TABLE_TEMPLATE = ['| Kolom 1 | Kolom 2 | Kolom 3 |\n| ------- | ------- | ------- |\n| ', ' |  |  |\n'];

export function registerActions(app, w) {
    const buf = w.editor.buffer;

    const action = (name, accels, run) => {
        const a = new Gio.SimpleAction({ name });
        a.connect('activate', () => run());
        app.add_action(a);
        if (accels) app.set_accels_for_action(`app.${name}`, accels);
    };
    const toggle = (name, accels, initial, run) => {
        const a = Gio.SimpleAction.new_stateful(name, null, GLib.Variant.new_boolean(initial));
        a.connect('change-state', (act, value) => { act.set_state(value); run(value.get_boolean()); });
        app.add_action(a);
        if (accels) app.set_accels_for_action(`app.${name}`, accels);
    };

    // File
    action('new', ['<Control>n'], () => w.newDocument());
    action('open', ['<Control>o'], () => w.open());
    action('save', ['<Control>s'], () => w.save());
    action('save-as', ['<Control><Shift>s'], () => w.saveAs());
    action('export-html', ['<Control><Shift>e'], () => w.exportHtml());
    action('quit', ['<Control>q'], () => w.win.close());
    action('about', null, () => showAbout(w.win));
    action('find', ['<Control>f'], () => w.findBar.open());

    // Format inline
    action('bold', ['<Control>b'], () => wrapSelection(buf, '**'));
    action('italic', ['<Control>i'], () => wrapSelection(buf, '*'));
    action('strike', ['<Alt><Shift>5', '<Control><Shift>x'], () => wrapSelection(buf, '~~'));
    action('inline-code', ['<Control>grave'], () => wrapSelection(buf, '`'));
    action('highlight', ['<Control><Shift>h'], () => wrapSelection(buf, '=='));
    action('link', ['<Control>k'], () => insertLink(buf));
    action('image', ['<Control><Shift>i'], () => w.insertImage());

    // Blok
    action('codeblock', ['<Control><Shift>k'], () => insertBlock(buf, '```\n', '\n```'));
    action('table', ['<Control>t'], () => insertBlock(buf, ...TABLE_TEMPLATE));
    action('quote', ['<Control><Shift>q'], () => togglePrefix(buf, /^>\s?/, '> '));
    action('ulist', ['<Control><Shift>bracketright'], () => togglePrefix(buf, /^[-*+]\s+/, '- '));
    action('olist', ['<Control><Shift>bracketleft'], () => togglePrefix(buf, /^\d+[.)]\s+/, '1. '));
    for (let n = 0; n <= 6; n++)
        action(`heading${n}`, [`<Control>${n}`], () => setHeading(buf, n));

    // Tampilan
    const s = w.settings;
    toggle('sidebar', ['<Control>backslash', '<Control><Shift>1'], s.sidebar, v => w.setOption('sidebar', v));
    toggle('source', ['<Control>slash'], false, v => w.setOption('source', v));
    toggle('focus', ['F8'], s.focus, v => w.setOption('focus', v));
    toggle('typewriter', ['F9'], s.typewriter, v => w.setOption('typewriter', v));
    toggle('dark', ['<Control><Shift>d'], w.dark, v => w.setOption('dark', v));
}
