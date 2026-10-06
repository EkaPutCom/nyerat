// Tes GUI: dialog libadwaita sungguhan (Adw.Dialog dan Adw.AlertDialog), bukan tiruan.
// Dialog bersifat blocking, jadi interaksinya dijadwalkan dari timer selagi main loop bersarang berjalan.

import GLib from 'gi://GLib';
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Gio from 'gi://Gio';
import { descendants } from '../widgets.js';
import { section, test, eq, ok } from '../framework.js';
import { PreferencesDialog } from '../../src/ui/preferences.js';
import { CommandPalette } from '../../src/ui/palette.js';
import { confirmDialog, findDialog, promptDialog } from '../../src/ui/dialogs.js';
import type { GuiContext } from './context.js';

export function dialogTests(c: GuiContext): void {
    const { w } = c;
    section('Dialog libadwaita');

    // Jalankan `act` setelah dialog `title` tampil (dicoba berulang), lalu kembalikan hasil `open`.
    const drive = <T>(title: string, open: () => T, act: (dialog: Adw.Dialog) => void): T => {
        let tries = 0;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            const dialog = findDialog(title);
            if (dialog) { act(dialog); return GLib.SOURCE_REMOVE; }
            return ++tries < 100 ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
        });
        return open();
    };
    // close() selama animasi buka diabaikan Adw.Dialog; ulangi sampai dialog benar-benar tertutup.
    const closeWhenReady = (dialog: Adw.Dialog): void => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            if (!dialog.get_mapped()) return GLib.SOURCE_REMOVE;
            dialog.close();
            return GLib.SOURCE_CONTINUE;
        });
    };
    const button = (root: Gtk.Widget, label: string) => descendants(root).find(x => x instanceof Gtk.Button && x.label === label) as Gtk.Button;

    test('prompt: tombol OK mengembalikan isian, Enter di isian juga menerima', () => {
        eq(drive('Nama', () => promptDialog(w.win, { title: 'Nama', label: 'Nama baru', value: 'a' }), d => {
            const entry = descendants(d).find(x => x instanceof Gtk.Entry) as Gtk.Entry;
            entry.set_text('baru');
            button(d, 'OK').emit('clicked');
        }), 'baru');
        eq(drive('Nama', () => promptDialog(w.win, { title: 'Nama', label: 'Nama baru', value: 'lewat enter' }), d => {
            (descendants(d).find(x => x instanceof Gtk.Entry) as Gtk.Entry).emit('activate');
        }), 'lewat enter', 'Enter menjalankan tombol bawaan');
    });

    test('prompt: Batal dan Escape (close) mengembalikan null', () => {
        eq(drive('Nama', () => promptDialog(w.win, { title: 'Nama', label: 'x', value: 'a' }), d => button(d, 'Batal').emit('clicked')), null);
        eq(drive('Nama', () => promptDialog(w.win, { title: 'Nama', label: 'x', value: 'a' }), closeWhenReady), null);
    });

    // Dialog yang baru dijawab masih terlihat selama animasi tutup; jangan dijawab dua kali.
    let answered: Adw.Dialog | null = null;
    test('konfirmasi: tombol Hapus bertanda destruktif; Batal dan menutup = false', () => {
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
            return confirmDialog(w.win, 'Hapus kartu ini?', 'Tidak bisa dikembalikan.');
        };
        eq(pick('Hapus'), true, 'Hapus');
        eq(pick('Batal'), false, 'Batal');
        eq(pick('close'), false, 'ditutup');
    });

    test('preferensi: switch terikat ke GSettings dan jendela menerapkannya, juga sebaliknya', () => {
        const settleP = () => { for (let i = 0; i < 20; i++) { c.pump(); GLib.usleep(10000); } };
        const wasFocus = w.settings.focus, wasDark = w.dark;
        c.action('preferences'); settleP();
        const dialog = w.win.get_visible_dialog();
        ok(dialog instanceof PreferencesDialog, 'dialog preferensi tidak tampil');
        const rows = descendants(dialog as Adw.Dialog);
        const switchRow = (title: string) => rows.find(x => x instanceof Adw.SwitchRow && x.title === title) as Adw.SwitchRow;
        const comboRow = (title: string) => rows.find(x => x instanceof Adw.ComboRow && x.title === title) as Adw.ComboRow;

        switchRow('Mode fokus').active = true; settleP();
        eq(w.settings.focus, true, 'GSettings mengikuti switch');
        eq(w.editor.modes.focus, true, 'editor mengikuti GSettings');
        w.settings.focus = false; settleP();
        eq(switchRow('Mode fokus').active, false, 'switch mengikuti GSettings');
        eq(w.editor.modes.focus, false, 'editor mengikuti GSettings (arah sebaliknya)');

        comboRow('Tema warna').selected = 2; settleP();
        eq(w.settings.dark, true, 'tema gelap tersimpan');
        eq(w.dark, true, 'jendela memakai tema gelap');
        comboRow('Tema warna').selected = 1; settleP();
        eq(w.dark, false, 'jendela kembali terang');

        comboRow('Model').selected = 1; settleP();
        eq(w.settings.chatModel, 'deepseek-v4-pro', 'model asisten tersimpan');
        eq(w.chat.model, 'deepseek-v4-pro', 'panel asisten mengikuti');
        w.settings.chatModel = 'deepseek-flash'; settleP();

        (dialog as Adw.Dialog).force_close();
        for (let i = 0; i < 100 && w.win.get_visible_dialog(); i++) { c.pump(); GLib.usleep(20000); }
        w.settings.focus = wasFocus;
        w.setDark(wasDark);
    });

    test('palet perintah: daftar aksi bisa disaring, dan Enter menjalankan Gio.Action yang sama', () => {
        const settleP = () => { for (let i = 0; i < 20; i++) { c.pump(); GLib.usleep(10000); } };
        const wasBoard = w.boardMode;
        if (wasBoard) w.toggleBoardView(false);   // di papan kanban aksi penyunting teks mati dan tidak tampil
        c.action('command-palette'); settleP();
        const palette = w.win.get_visible_dialog() as CommandPalette;
        ok(palette instanceof CommandPalette, 'palet tidak tampil');
        const search = descendants(palette).find(x => x instanceof Gtk.SearchEntry) as Gtk.SearchEntry;
        const all = palette.visibleCount;
        ok(all > 30, `terlalu sedikit perintah: ${all}`);
        search.set_text('fokus'); settleP();
        eq(palette.visibleCount, 1, 'saringan "fokus"');
        search.set_text('tabel rata'); settleP();
        eq(palette.visibleCount, 3, 'semua kata harus cocok, urutan bebas');
        search.set_text('tidak-ada-perintah-ini'); settleP();
        eq(palette.visibleCount, 0, 'tanpa hasil');
        search.set_text('mode fokus'); settleP();
        const before = w.settings.focus;
        search.emit('activate'); settleP();
        eq(w.settings.focus, !before, 'aksi dijalankan');
        for (let i = 0; i < 100 && w.win.get_visible_dialog(); i++) { c.pump(); GLib.usleep(20000); }
        eq(w.win.get_visible_dialog(), null, 'palet tertutup setelah memilih');
        w.settings.focus = before; settleP();

        // Aksi yang dinonaktifkan tidak tampil di palet.
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
        eq(countInPalette(), enabledCount - 1, 'aksi nonaktif tidak tampil');
        bold.set_enabled(true);
        if (wasBoard) w.toggleBoardView(true);
        for (let i = 0; i < 100 && w.win.get_visible_dialog(); i++) { c.pump(); GLib.usleep(20000); }
    });

    // Tes sesudahnya (mouse) tidak boleh mulai selagi dialog masih beranimasi menutup dan menahan input.
    for (let i = 0; i < 100 && w.win.get_visible_dialog(); i++) { c.pump(); GLib.usleep(20000); }
}
