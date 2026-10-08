// GUI tests: Image zoom.

import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import { clampZoom, fitZoom, ImageViewer, MAX_ZOOM, MIN_ZOOM } from '../../src/ui/imageviewer.js';
import { section, test, eq, ok, tmp } from '../framework.js';
import type { GuiContext } from './context.js';
import { emitClick } from '../widgets.js';

export function imageZoomTests(c: GuiContext): void {
    const { w, ed, buf, pump, setText, cursorTo, action, imgDir, waitImages } = c;

    section('Image zoom');
    const makePixbuf = (width: number, height: number) => {
        const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, width, height);
        pixbuf.fill(0x4183c4ff);
        return pixbuf;
    };
    makePixbuf(50, 50).savev(GLib.build_filenamev([imgDir, 'small.png']), 'png', [], []);
    const settleV = () => { for (let i = 0; i < 30; i++) { pump(); GLib.usleep(10000); } };
    const openViewer = (pixbuf: GdkPixbuf.Pixbuf, title = 'test') => {
        const viewer = new ImageViewer(w.win, pixbuf, title);
        viewer.show();
        settleV();
        return viewer;
    };
    const message = () => w.lastToast;
    const cursorLineNow = () => buf.get_iter_at_mark(buf.get_insert()).get_line();
    const originalOnView = ed.onViewImage;
    let viewed: { pixbuf: GdkPixbuf.Pixbuf; title: string } | null = null;
    ed.onViewImage = (pixbuf, title) => { viewed = { pixbuf, title }; };

    test('imageAt gives the image at full size, not the one shrunk for display', () => {
        w.file = GLib.build_filenamev([tmp, 'dok.md']);
        setText('![test](images/test.png)\n\ntext'); waitImages();
        const found = ed.images.imageAt(0);
        ok(found.ok, 'the image was not found');
        eq([found.pixbuf.get_width(), found.pixbuf.get_height(), found.title], [300, 100, 'test']);
    });
    test('viewer title: the alt text, or the file name if the alt is empty', () => {
        setText('![](images/test.png)'); waitImages();
        const found = ed.images.imageAt(0);
        ok(found.ok && found.title === 'test.png', 'title from the file name');
    });
    test('imageAt refuses a line without an image and an image that failed to load', () => {
        setText('![x](images/not-there.png)\n\ntext'); waitImages();
        const missing = ed.images.imageAt(0), none = ed.images.imageAt(2);
        ok(!missing.ok && missing.reason === 'The image could not be loaded', 'missing image');
        ok(!none.ok && none.reason === 'There is no image on this line', 'line without an image');
    });
    test('a single click moves the cursor to the image; a double click enlarges it', () => {
        setText('text\n\n![test](images/test.png)'); waitImages(); cursorTo(0);
        viewed = null;
        ed.images.press(2, 0, false); pump();
        eq(cursorLineNow(), 2, 'cursor after a single click');
        eq(viewed, null, 'a single click did not open the viewer');
        ed.images.press(2, 0, true);
        ok(viewed !== null && (viewed as { pixbuf: GdkPixbuf.Pixbuf }).pixbuf.get_width() === 300, 'a double click did not open the viewer');
    });
    test('a double click picks the right image when one line holds several images', () => {
        setText('![a](images/test.png) ![b](images/small.png)'); waitImages();
        viewed = null;
        ed.images.press(0, 1, true);
        const v = viewed as unknown as { pixbuf: GdkPixbuf.Pixbuf; title: string };
        eq([v.pixbuf.get_width(), v.title], [50, 'b']);
    });
    test('zoomImage uses the cursor line; without an image it shows a message', () => {
        setText('text\n\n![test](images/test.png)'); waitImages();
        cursorTo(2); viewed = null; ed.zoomImage();
        ok(viewed !== null, 'the image on the cursor line was not opened');
        cursorTo(0); viewed = null; ed.zoomImage();
        eq([viewed, message()], [null, 'There is no image on this line']);
    });
    test('the Zoom Image menu command', () => {
        cursorTo(2); viewed = null;
        action('zoom-image');
        ok(viewed !== null, 'the action did not open the viewer');
    });
    ed.onViewImage = originalOnView;

    test('viewer: a small image opens at 100%, a large image is fitted to the window', () => {
        const small = openViewer(makePixbuf(100, 80));
        eq(small.zoom, 1, 'the small image was not enlarged');
        const big = openViewer(makePixbuf(3000, 2000));
        ok(big.zoom < 0.5 && big.zoom > MIN_ZOOM, `initial zoom of the large image  ${big.zoom}`);
        ok(big.area.get_size_request()[0] <= big.window.get_allocated_width(), 'the image is wider than the window');
        small.close(); big.close();
    });
    test('zooming in/out multiplies by 1.25 and is limited to 5%–800%', () => {
        const v = openViewer(makePixbuf(100, 80));
        v.zoomIn(); eq(Math.round(v.zoom * 1000) / 1000, 1.25, 'zoom in');
        v.zoomOut(); v.zoomOut(); eq(Math.round(v.zoom * 1000) / 1000, 0.8, 'zoom out');
        for (let i = 0; i < 40; i++) v.zoomIn();
        eq(v.zoom, MAX_ZOOM, 'upper limit');
        for (let i = 0; i < 80; i++) v.zoomOut();
        eq(v.zoom, MIN_ZOOM, 'lower limit');
        v.actual(); eq(v.zoom, 1, 'actual size');
        v.close();
    });
    test('the size of the image area follows the zoom', () => {
        const v = openViewer(makePixbuf(400, 200));
        v.actual(); eq(v.area.get_size_request(), [400, 200], '100%');
        v.zoomIn(); eq(v.area.get_size_request(), [500, 250], '125%');
        v.close();
    });
    test('Fit enlarges a small image, 0 restores 100%', () => {
        const v = openViewer(makePixbuf(100, 80));
        v.fit(); settleV();
        ok(v.zoom > 1, `fit-to-screen of the small image  ${v.zoom}`);
        v.handleKey(Gdk.KEY_0); eq(v.zoom, 1, 'actual size');
        v.close();
    });
    test('keys: + − 0 F Esc; other keys are not handled', () => {
        const v = openViewer(makePixbuf(100, 80));
        ok(v.handleKey(Gdk.KEY_plus) && Math.abs(v.zoom - 1.25) < 1e-9, '+');
        ok(v.handleKey(Gdk.KEY_minus) && Math.abs(v.zoom - 1) < 1e-9, '−');
        ok(v.handleKey(Gdk.KEY_f), 'F'); settleV(); ok(v.zoom > 1, 'F enlarges the small image');
        ok(v.handleKey(Gdk.KEY_0) && v.zoom === 1, '0');
        ok(!v.handleKey(Gdk.KEY_a), 'other key');
        ok(v.handleKey(Gdk.KEY_Escape) && v.closed, 'Esc closes');
    });
    test('zoom at the pointer: the image point under the pointer does not shift', () => {
        const v = openViewer(makePixbuf(2000, 1500));
        v.actual(); settleV();
        const scroller = v['scroller'];
        scroller.get_hadjustment().set_value(0); scroller.get_vadjustment().set_value(0);
        // Wheel up at the point (400, 300) on an image scrolled to (0, 0).
        v.scrollZoom(-1, true, [400, 300]); settleV();
        // The image point (400, 300) is now at 500 × 375; to stay at (400, 300) on screen, scroll (100, 75).
        const [h, vv] = [scroller.get_hadjustment().get_value(), scroller.get_vadjustment().get_value()];
        ok(Math.abs(h - 100) < 1.5 && Math.abs(vv - 75) < 1.5, `scroll (${h}, ${vv}), should be (100, 75)`);
        v.close();
    });
    test('dragging shifts the image', () => {
        const v = openViewer(makePixbuf(2000, 1500));
        v.actual(); settleV();
        const scroller = v['scroller'];
        scroller.get_hadjustment().set_value(0); scroller.get_vadjustment().set_value(0);
        v.beginDrag();
        v.dragBy(-50, -30);   // moved to the top-left = seeing the bottom-right part
        eq([scroller.get_hadjustment().get_value(), scroller.get_vadjustment().get_value()], [50, 30], 'scroll');
        v.endDrag(); ok(!v.dragBy(-500, -500), 'after the button is released, movement does not shift');
        v.close();
    });
    test('a double click in the viewer: alternates between fit-to-screen and 100%', () => {
        const v = openViewer(makePixbuf(3000, 2000));
        const fitted = v.zoom;
        emitClick(v.area, 2); eq(v.zoom, 1, 'to 100%');
        emitClick(v.area, 2); settleV();
        ok(Math.abs(v.zoom - fitted) < 0.02, `back to fit-to-screen  (${v.zoom} vs ${fitted})`);
        v.close();
    });
    test('zoom helper functions', () => {
        eq([clampZoom(100), clampZoom(0), clampZoom(2)], [MAX_ZOOM, MIN_ZOOM, 2], 'clampZoom');
        eq(fitZoom(1000, 500, 500, 500), 0.5, 'fitZoom follows the narrower side');
    });
    test('drawing at a large zoom does not trigger GTK/cairo warnings', () => {
        const warnings: string[] = [];
        const flags = GLib.LogLevelFlags.LEVEL_WARNING | GLib.LogLevelFlags.LEVEL_CRITICAL;
        const handlers = ['Gtk', 'Gdk', 'GLib-GObject'].map(domain =>
            [domain, GLib.log_set_handler(domain, flags, (_d, _l, m) => { warnings.push(`${domain}: ${m}`); })] as const);
        try {
            const v = openViewer(makePixbuf(3000, 2000));
            for (let i = 0; i < 10; i++) { v.zoomIn(); settleV(); }
            v.zoomOut(); settleV();
            v.close(); settleV();
        } finally {
            for (const [domain, id] of handlers) GLib.log_remove_handler(domain, id);
        }
        eq(warnings, [], 'warnings');
    });
    w.file = null;
}
