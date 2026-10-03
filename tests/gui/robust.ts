// Tes GUI: Ketahanan (mencari crash).

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=3.0';
import Gdk from 'gi://Gdk?version=3.0';
import { WELCOME } from '../../src/welcome.js';
import { section, test, ok, tmp, opt, DIM, RESET } from '../framework.js';
import type { GuiContext } from './context.js';

export function robustnessTests(c: GuiContext): void {
    const { w, ed, buf, pump, setText, cursorTo, action, waitImages } = c;

    section('Ketahanan (mencari crash)');
    test('kursor menyapu setiap baris dokumen contoh', () => {
        setText(WELCOME);
        const n = buf.get_line_count();
        for (let i = 0; i < n; i++) { cursorTo(i); cursorTo(i, -1); }
        for (let i = n - 1; i >= 0; i--) cursorTo(i);
    });
    test('mengetik di setiap baris dokumen contoh', () => {
        const n = buf.get_line_count();
        for (let i = 0; i < n; i++) { cursorTo(i); buf.insert_at_cursor('x', -1); pump(); }
    });
    test('menghapus seluruh dokumen sedikit demi sedikit', () => {
        setText(WELCOME);
        while (buf.get_char_count() > 0) {
            const e = buf.get_end_iter(), s = e.copy();
            s.backward_chars(7);
            buf.delete(s, e);
            pump();
        }
    });
    test('mode fokus dan typewriter aktif bersamaan', () => {
        setText(WELCOME);
        action('focus'); action('typewriter');
        for (let i = 0; i < buf.get_line_count(); i++) cursorTo(i);
        action('focus'); action('typewriter');
    });

    if (opt('mouse')) {
        section('Klik mouse sungguhan (XTest)');
        const tw = ed.view.get_window(Gtk.TextWindowType.TEXT)!;
        const xtest = (window: Gdk.Window, x: number, y: number) => {
            Gdk.test_simulate_button(window, x, y, 1, 0 as Gdk.ModifierType, Gdk.EventType.BUTTON_PRESS);
            Gdk.test_simulate_button(window, x, y, 1, 0 as Gdk.ModifierType, Gdk.EventType.BUTTON_RELEASE);
            for (let k = 0; k < 8; k++) { pump(); GLib.usleep(15000); }
        };

        // Pemeriksaan awal: di sebagian lingkungan (diuji di sini: XFCE/X11) gerak pointer XTest
        // sampai, tetapi tombol mouse tidak pernah diterima GTK. Tes klik di bawah ini tidak ada
        // artinya jika klik tidak sampai, jadi dilewati dengan keterangan, bukan lulus palsu.
        setText('baris satu\n\nbaris dua'); cursorTo(0);
        w.win.present_with_time(Gdk.CURRENT_TIME);
        for (let k = 0; k < 20; k++) { pump(); GLib.usleep(15000); }
        let delivered = 0;
        const probe = ed.view.connect('button-press-event', () => { delivered++; return false; });
        xtest(tw, 200, 140);
        ed.view.disconnect(probe);

        if (!delivered) {
            print(`  ${DIM}- dilewati: XTest tidak mengirim tombol mouse ke jendela di lingkungan ini${RESET}`);
        } else {
            test('klik ganda pada gambar di editor membuka penampil', () => {
                w.file = GLib.build_filenamev([tmp, 'dok.md']);
                setText('teks\n\n![uji](gambar/uji.png)\n\nakhir'); waitImages(); cursorTo(0);
                for (let i = 0; i < 30; i++) { pump(); GLib.usleep(10000); }
                let opened = false;
                const keep = ed.onViewImage;
                ed.onViewImage = () => { opened = true; };
                // Titik 60 px di bawah tepi atas gambar (tingginya 100): tetap di dalam gambar walau klik
                // pertama menggesernya ke bawah karena sintaks gambar muncul. Posisinya diambil dari
                // widget gambarnya, bukan dari rumus, supaya tidak bergantung pada margin editor.
                const widgetWindow = ed.view.get_window(Gtk.TextWindowType.WIDGET)!;
                const picture = ed.images.blocks[0].content.get_children()[0];
                const [, px, py] = picture.translate_coordinates(ed.view, 40, 60);
                xtest(widgetWindow, px, py);
                xtest(widgetWindow, px, py);
                ed.onViewImage = keep;
                w.file = null;
                ok(opened, 'klik ganda dengan mouse tidak membuka penampil');
            });
            test('klik di seluruh area teks tidak membuat editor error', () => {
                setText(WELCOME);
                for (let y = 20; y < tw.get_height(); y += 23)
                    for (const x of [20, 250, 600]) xtest(tw, x, y);
            });
        }
    }
}
