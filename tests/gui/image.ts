// GUI tests: Images.

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import { section, test, eq, ok, tmp } from '../framework.js';
import type { GuiContext } from './context.js';
import { iterAtLine } from '../../src/gtkutil.js';

export function imageTests(c: GuiContext): void {
    const { w, ed, buf, pump, text, setText, cursorTo, hidden, action, imgDir, images, waitImages } = c;

    section('Images');
    // A 300×100 test image in a temporary folder.
    GLib.mkdir_with_parents(imgDir, 0o755);
    const pb = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 300, 100);
    pb.fill(0x4183c4ff);
    pb.savev(GLib.build_filenamev([imgDir, 'test.png']), 'png', [], []);
    const hasGap = (line: number) => iterAtLine(buf, line).get_tags().some(t => t.name?.startsWith('image-gap-'));

    test('a local image is loaded and shown below its line', () => {
        w.file = GLib.build_filenamev([tmp, 'dok.md']);
        setText('title\n\n![test](images/test.png)\n\nend');
        waitImages();
        eq(images().length, 1, 'number of image blocks');
        const block = images()[0];
        eq(block.items[0].entry?.status, 'ok', 'load status');
        ok(block.box.get_visible(), 'the image widget is not visible');
        ok(hasGap(2), 'no space was reserved below the image line');
        const [lineY] = ed.view.get_line_yrange(iterAtLine(buf, 2));
        ok(block.y > lineY, `the image (y=${block.y}) is not below its line (y=${lineY})`);
    });
    test('an image below a long document is shown in place after scrolling', () => {
        try {
            setText(`${'paragraph\n\n'.repeat(80)}![test](images/test.png)\n\nend`);
            waitImages();
            const block = images()[0];
            ed.view.scroll_to_iter(iterAtLine(buf, block.line), 0, true, 0, 0.5);
            for (let i = 0; i < 30; i++) { pump(); GLib.usleep(10000); }
            ok(ed.view.get_vadjustment()!.get_value() > 500, 'the document did not scroll');
            const [, gx, gy] = block.box.translate_coordinates(ed.view, 0, 0);
            eq([gx, gy], ed.view.buffer_to_window_coords(Gtk.TextWindowType.WIDGET, block.x, block.y), 'image position');
            ok(gy >= 0 && gy < ed.view.get_height(), `the image is off screen (y=${gy})`);
        } finally {
            // The next tests use this short document.
            setText('title\n\n![test](images/test.png)\n\nend');
            waitImages();
        }
    });
    test('the document contents do not change because of the image', () => {
        eq(text(), 'title\n\n![test](images/test.png)\n\nend');
    });
    test('the image syntax is hidden on other lines and visible on the active line', () => {
        cursorTo(0);
        ok(hidden(9) && hidden(15), '![test](...) should be hidden');
        cursorTo(2);
        ok(!hidden(9) && !hidden(15), '![test](...) should be visible');
    });
    test('the widget is reused when lines shift', () => {
        const before = images()[0];
        buf.insert(buf.get_start_iter(), 'new line\n', -1);
        pump();
        eq(images().length, 1, 'number of image blocks');
        ok(images()[0] === before, 'the widget was recreated');
        eq(images()[0].line, 3, 'image line');
        ok(hasGap(3) && !hasGap(2), 'the empty space did not move along');
    });
    test('a missing image shows a message', () => {
        setText('![missing](images/not-there.png)');
        waitImages();
        eq(images()[0].items[0].entry?.status, 'error', 'load status');
        const label = images()[0].content.get_first_child();
        ok(label instanceof Gtk.Label && label.label.includes('missing'), 'the error label is not shown');
    });
    test('images in table rows and code blocks are ignored', () => {
        setText('| ![a](images/test.png) |\n| --- |\n\n```\n![b](images/test.png)\n```');
        eq(images().length, 0, 'number of image blocks');
    });
    test('source mode hides images', () => {
        setText('![test](images/test.png)\ntext');
        waitImages();
        action('source');
        ok(!images()[0].box.get_visible() && !hasGap(0), 'the image is still shown in source mode');
        action('source');
        ok(images()[0].box.get_visible() && hasGap(0), 'the image did not appear again');
    });
    test('clicking the image moves the cursor to its line', () => {
        cursorTo(1);
        ed.images.onActivate(images()[0].line);
        pump();
        eq(buf.get_iter_at_mark(buf.get_insert()).get_line(), 0, 'cursor line');
    });
    test('deleting the image syntax deletes its widget', () => {
        setText('text only');
        eq(images().length, 0, 'number of image blocks');
    });
}
