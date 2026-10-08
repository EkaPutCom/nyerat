// Tes GUI: Ukuran jendela.

import GLib from 'gi://GLib';
import { section, test, eq, ok, ROOT } from '../framework.js';
import type { GuiContext } from './context.js';

export function windowSizeTests(c: GuiContext): void {
    const { w, ed, buf, pump, samplePath, images, waitImages } = c;

    section('Ukuran jendela');
    const settle = () => { for (let i = 0; i < 40; i++) { pump(); GLib.usleep(15000); } };
    const winWidth = () => w.win.get_width();
    test('opening a second file does not enlarge the window', () => {
        w.win.set_default_size(1100, 700); settle();
        const before = winWidth();
        ok(w.load(samplePath), 'load() of the first file failed'); waitImages(); settle();
        ok(w.load(GLib.build_filenamev([ROOT, 'README.md'])), 'load() of the second file failed');
        settle();
        eq(winWidth(), before, 'lebar jendela');
    });
    test('the window can be enlarged and then shrunk again', () => {
        // Smaller than the Xvfb screen (1280): GTK 4 does not enlarge a window past the monitor.
        // The window widget width can be a few pixels smaller than the default size (the CSD frame).
        w.win.set_default_size(1240, 700); settle();
        ok(Math.abs(winWidth() - 1240) <= 16, `after enlarging: ${winWidth()}`);
        w.win.set_default_size(800, 700); settle();
        ok(Math.abs(winWidth() - 800) <= 16, `setelah diperkecil: ${winWidth()}`);
        ok(ed.view.get_left_margin() < 100, `the margin did not shrink along (${ed.view.get_left_margin()})`);
    });
    test('an image is not wider than the text column', () => {
        ok(w.load(samplePath), 'load() failed'); waitImages(); settle();
        const column = ed.widget.get_allocated_width() - 2 * ed.view.get_left_margin();
        for (const block of images())
            ok(block.box.get_allocated_width() <= column, `image ${block.box.get_allocated_width()}px > column ${column}px`);
        w.win.set_default_size(1100, 700); settle();
    });
    buf.set_modified(false);
    w.file = null;
}
