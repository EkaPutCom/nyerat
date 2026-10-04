// Tes GUI: Ukuran jendela.

import GLib from 'gi://GLib';
import { section, test, eq, ok, ROOT } from '../framework.js';
import type { GuiContext } from './context.js';

export function windowSizeTests(c: GuiContext): void {
    const { w, ed, buf, pump, samplePath, images, waitImages } = c;

    section('Ukuran jendela');
    const settle = () => { for (let i = 0; i < 40; i++) { pump(); GLib.usleep(15000); } };
    const winWidth = () => w.win.get_width();
    test('membuka file kedua tidak memperbesar jendela', () => {
        w.win.set_default_size(1100, 700); settle();
        const before = winWidth();
        ok(w.load(samplePath), 'load() file pertama gagal'); waitImages(); settle();
        ok(w.load(GLib.build_filenamev([ROOT, 'README.md'])), 'load() file kedua gagal');
        settle();
        eq(winWidth(), before, 'lebar jendela');
    });
    test('jendela bisa diperbesar lalu diperkecil lagi', () => {
        // Lebih kecil dari layar Xvfb (1280): GTK 4 tidak membesarkan jendela melewati monitor.
        // Lebar widget jendela bisa beberapa piksel lebih kecil dari ukuran default (bingkai CSD).
        w.win.set_default_size(1240, 700); settle();
        ok(Math.abs(winWidth() - 1240) <= 16, `setelah diperbesar: ${winWidth()}`);
        w.win.set_default_size(800, 700); settle();
        ok(Math.abs(winWidth() - 800) <= 16, `setelah diperkecil: ${winWidth()}`);
        ok(ed.view.get_left_margin() < 100, `margin tidak ikut mengecil (${ed.view.get_left_margin()})`);
    });
    test('gambar tidak lebih lebar dari kolom teks', () => {
        ok(w.load(samplePath), 'load() gagal'); waitImages(); settle();
        const column = ed.widget.get_allocated_width() - 2 * ed.view.get_left_margin();
        for (const block of images())
            ok(block.box.get_allocated_width() <= column, `gambar ${block.box.get_allocated_width()}px > kolom ${column}px`);
        w.win.set_default_size(1100, 700); settle();
    });
    buf.set_modified(false);
    w.file = null;
}
