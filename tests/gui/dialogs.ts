// Tes GUI: dialog libadwaita sungguhan (Adw.Dialog dan Adw.AlertDialog), bukan tiruan.
// Dialog bersifat blocking, jadi interaksinya dijadwalkan dari timer selagi main loop bersarang berjalan.

import GLib from 'gi://GLib';
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import { descendants } from '../widgets.js';
import { section, test, eq } from '../framework.js';
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

    // Tes sesudahnya (mouse) tidak boleh mulai selagi dialog masih beranimasi menutup dan menahan input.
    for (let i = 0; i < 100 && w.win.get_visible_dialog(); i++) { c.pump(); GLib.usleep(20000); }
}
