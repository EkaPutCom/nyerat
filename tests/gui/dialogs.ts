// GUI tests: real libadwaita dialogs (Adw.Dialog and Adw.AlertDialog), not fakes.
// Dialogs answer through a Promise; the interaction is scheduled from a timer while settle() waits for the answer.

import GLib from 'gi://GLib';
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Gio from 'gi://Gio';
import { descendants } from '../widgets.js';
import { section, test, eq, ok, settle } from '../framework.js';
import { PreferencesDialog } from '../../src/ui/preferences.js';
import { CommandPalette } from '../../src/ui/palette.js';
import { confirmDialog, findDialog, promptDialog } from '../../src/ui/dialogs.js';
import type { GuiContext } from './context.js';

export function dialogTests(c: GuiContext): void {
    const { w } = c;
    section('libadwaita dialogs');

    // Run `act` after the dialog `title` appears (retried repeatedly), then return the result of `open`.
    const drive = <T>(title: string, open: () => Promise<T>, act: (dialog: Adw.Dialog) => void): T => {
        let tries = 0;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            const dialog = findDialog(title);
            if (dialog) { act(dialog); return GLib.SOURCE_REMOVE; }
            return ++tries < 100 ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
        });
        return settle(open());
    };
    // close() during the open animation is ignored by Adw.Dialog; repeat until the dialog is really closed.
    const closeWhenReady = (dialog: Adw.Dialog): void => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            if (!dialog.get_mapped()) return GLib.SOURCE_REMOVE;
            dialog.close();
            return GLib.SOURCE_CONTINUE;
        });
    };
    const button = (root: Gtk.Widget, label: string) => descendants(root).find(x => x instanceof Gtk.Button && x.label === label) as Gtk.Button;

    test('prompt: the OK button returns the input, Enter in the entry also accepts', () => {
        eq(drive('Name',  () => promptDialog(w.win, { title: 'Name', label: 'New name', value: 'a' }), d => {
            const entry = descendants(d).find(x => x instanceof Gtk.Entry) as Gtk.Entry;
            entry.set_text('new');
            button(d, 'OK').emit('clicked');
        }), 'new');
        eq(drive('Name',  () => promptDialog(w.win, { title: 'Name', label: 'New name', value: 'via enter' }), d => {
            (descendants(d).find(x => x instanceof Gtk.Entry) as Gtk.Entry).emit('activate');
        }), 'via enter', 'Enter runs the default button');
    });

    test('prompt: Cancel and Escape (close) return null', () => {
        eq(drive('Name',  () => promptDialog(w.win, { title: 'Name', label: 'x', value: 'a' }), d => button(d, 'Cancel').emit('clicked')), null);
        eq(drive('Name',  () => promptDialog(w.win, { title: 'Name', label: 'x', value: 'a' }), closeWhenReady), null);
    });

    // A dialog that has just been answered is still visible during the close animation; do not answer it twice.
    let answered: Adw.Dialog | null = null;
    test('confirm: the Delete button is marked destructive; Cancel and closing = false', () => {
        const pick = (response: string): boolean => {
            let tries = 0;
            let target: Adw.AlertDialog | null = null;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                const dialog = w.win.get_visible_dialog();
                if (!target && dialog instanceof Adw.AlertDialog && dialog !== answered) answered = target = dialog;
                if (target) {
                    if (response !== 'close') {
                        button(target, response).emit('clicked');
                        return GLib.SOURCE_REMOVE;
                    }
                    closeWhenReady(target);
                    return GLib.SOURCE_REMOVE;
                }
                return ++tries < 100 ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
            });
            return settle(confirmDialog(w.win, 'Delete this card?', 'This cannot be undone.'));
        };
        eq(pick('Delete'), true, 'Delete');
        eq(pick('Cancel'), false, 'Cancel');
        eq(pick('close'), false, 'closed');
    });

    test('preferences: the switch is bound to GSettings and the window applies it, and vice versa', () => {
        const settleP = () => { for (let i = 0; i < 20; i++) { c.pump(); GLib.usleep(10000); } };
        const wasFocus = w.settings.focus, wasDark = w.dark;
        c.action('preferences'); settleP();
        const dialog = w.win.get_visible_dialog();
        ok(dialog instanceof PreferencesDialog, 'the preferences dialog is not shown');
        const rows = descendants(dialog as Adw.Dialog);
        const switchRow = (title: string) => rows.find(x => x instanceof Adw.SwitchRow && x.title === title) as Adw.SwitchRow;
        const comboRow = (title: string) => rows.find(x => x instanceof Adw.ComboRow && x.title === title) as Adw.ComboRow;

        switchRow('Focus mode').active = true; settleP();
        eq(w.settings.focus, true, 'GSettings follows the switch');
        eq(w.editor.modes.focus, true, 'the editor follows GSettings');
        w.settings.focus = false; settleP();
        eq(switchRow('Focus mode').active, false, 'the switch follows GSettings');
        eq(w.editor.modes.focus, false, 'the editor follows GSettings (reverse direction)');

        comboRow('Color scheme').selected = 2; settleP();
        eq(w.settings.dark, true, 'the dark theme is saved');
        eq(w.dark, true, 'the window uses the dark theme');
        comboRow('Color scheme').selected = 1; settleP();
        eq(w.dark, false, 'the window went back to light');

        comboRow('Model').selected = 1; settleP();
        eq(w.settings.chatModel, 'deepseek-v4-pro', 'the assistant model is saved');
        eq(w.chat.model, 'deepseek-v4-pro', 'the assistant panel follows');
        w.settings.chatModel = 'deepseek-flash'; settleP();

        (dialog as Adw.Dialog).force_close();
        for (let i = 0; i < 100 && w.win.get_visible_dialog(); i++) { c.pump(); GLib.usleep(20000); }
        w.settings.focus = wasFocus;
        w.setDark(wasDark);
    });

    test('command palette: the action list can be filtered, and Enter runs the same Gio.Action', () => {
        const settleP = () => { for (let i = 0; i < 20; i++) { c.pump(); GLib.usleep(10000); } };
        const wasBoard = w.boardMode;
        if (wasBoard) w.toggleBoardView(false);   // on the kanban board the text editor actions are disabled and not shown
        c.action('command-palette'); settleP();
        const palette = w.win.get_visible_dialog() as CommandPalette;
        ok(palette instanceof CommandPalette, 'the palette is not shown');
        const search = descendants(palette).find(x => x instanceof Gtk.SearchEntry) as Gtk.SearchEntry;
        const all = palette.visibleCount;
        ok(all > 30, `too few commands: ${all}`);
        search.set_text('focus'); settleP();
        eq(palette.visibleCount, 1, 'filter "focus"');
        search.set_text('table align'); settleP();
        eq(palette.visibleCount, 3, 'all words must match, in any order');
        search.set_text('no-such-command'); settleP();
        eq(palette.visibleCount, 0, 'no results');
        search.set_text('focus mode'); settleP();
        const before = w.settings.focus;
        search.emit('activate'); settleP();
        eq(w.settings.focus, !before, 'the action ran');
        for (let i = 0; i < 100 && w.win.get_visible_dialog(); i++) { c.pump(); GLib.usleep(20000); }
        eq(w.win.get_visible_dialog(), null, 'the palette closed after choosing');
        w.settings.focus = before; settleP();

        // A disabled action is not shown in the palette.
        const countInPalette = (): number => {
            c.action('command-palette'); settleP();
            const p = w.win.get_visible_dialog() as CommandPalette;
            const count = p.visibleCount;
            p.force_close(); settleP();
            return count;
        };
        const bold = w.app.lookup_action('bold') as Gio.SimpleAction;
        const enabledCount = countInPalette();
        bold.set_enabled(false);
        eq(countInPalette(), enabledCount - 1, 'the disabled action is not shown');
        bold.set_enabled(true);
        if (wasBoard) w.toggleBoardView(true);
        for (let i = 0; i < 100 && w.win.get_visible_dialog(); i++) { c.pump(); GLib.usleep(20000); }
    });

    // The tests after this (mouse) must not start while a dialog is still animating closed and holding the input.
    for (let i = 0; i < 100 && w.win.get_visible_dialog(); i++) { c.pump(); GLib.usleep(20000); }
}
