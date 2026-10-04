// Tes GUI: Zoom gambar.

import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import { clampZoom, fitZoom, ImageViewer, MAX_ZOOM, MIN_ZOOM } from '../../src/ui/imageviewer.js';
import { section, test, eq, ok, tmp } from '../framework.js';
import type { GuiContext } from './context.js';
import { emitClick } from '../widgets.js';

export function imageZoomTests(c: GuiContext): void {
    const { w, ed, buf, pump, setText, cursorTo, action, imgDir, waitImages } = c;

    section('Zoom gambar');
    const makePixbuf = (width: number, height: number) => {
        const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, width, height);
        pixbuf.fill(0x4183c4ff);
        return pixbuf;
    };
    makePixbuf(50, 50).savev(GLib.build_filenamev([imgDir, 'kecil.png']), 'png', [], []);
    const settleV = () => { for (let i = 0; i < 30; i++) { pump(); GLib.usleep(10000); } };
    const openViewer = (pixbuf: GdkPixbuf.Pixbuf, title = 'uji') => {
        const viewer = new ImageViewer(w.win, pixbuf, title);
        viewer.show();
        settleV();
        return viewer;
    };
    const message = () => w.statusBar.left.label;
    const cursorLineNow = () => buf.get_iter_at_mark(buf.get_insert()).get_line();
    const originalOnView = ed.onViewImage;
    let viewed: { pixbuf: GdkPixbuf.Pixbuf; title: string } | null = null;
    ed.onViewImage = (pixbuf, title) => { viewed = { pixbuf, title }; };

    test('imageAt memberi gambar ukuran penuh, bukan yang diperkecil untuk tampilan', () => {
        w.file = GLib.build_filenamev([tmp, 'dok.md']);
        setText('![uji](gambar/uji.png)\n\nteks'); waitImages();
        const found = ed.images.imageAt(0);
        ok(found.ok, 'gambar tidak ditemukan');
        eq([found.pixbuf.get_width(), found.pixbuf.get_height(), found.title], [300, 100, 'uji']);
    });
    test('judul penampil: teks alt, atau nama file jika alt kosong', () => {
        setText('![](gambar/uji.png)'); waitImages();
        const found = ed.images.imageAt(0);
        ok(found.ok && found.title === 'uji.png', 'judul dari nama file');
    });
    test('imageAt menolak baris tanpa gambar dan gambar yang gagal dimuat', () => {
        setText('![x](gambar/tidak-ada.png)\n\nteks'); waitImages();
        const missing = ed.images.imageAt(0), none = ed.images.imageAt(2);
        ok(!missing.ok && missing.reason === 'Gambar tidak bisa dimuat', 'gambar hilang');
        ok(!none.ok && none.reason === 'Tidak ada gambar di baris ini', 'baris tanpa gambar');
    });
    test('klik sekali memindahkan kursor ke gambar; klik ganda memperbesarnya', () => {
        setText('teks\n\n![uji](gambar/uji.png)'); waitImages(); cursorTo(0);
        viewed = null;
        ed.images.press(2, 0, false); pump();
        eq(cursorLineNow(), 2, 'kursor setelah klik sekali');
        eq(viewed, null, 'klik sekali tidak membuka penampil');
        ed.images.press(2, 0, true);
        ok(viewed !== null && (viewed as { pixbuf: GdkPixbuf.Pixbuf }).pixbuf.get_width() === 300, 'klik ganda tidak membuka penampil');
    });
    test('klik ganda memilih gambar yang tepat jika satu baris memuat beberapa gambar', () => {
        setText('![a](gambar/uji.png) ![b](gambar/kecil.png)'); waitImages();
        viewed = null;
        ed.images.press(0, 1, true);
        const v = viewed as unknown as { pixbuf: GdkPixbuf.Pixbuf; title: string };
        eq([v.pixbuf.get_width(), v.title], [50, 'b']);
    });
    test('zoomImage memakai baris kursor; tanpa gambar menampilkan pesan', () => {
        setText('teks\n\n![uji](gambar/uji.png)'); waitImages();
        cursorTo(2); viewed = null; ed.zoomImage();
        ok(viewed !== null, 'gambar di baris kursor tidak dibuka');
        cursorTo(0); viewed = null; ed.zoomImage();
        eq([viewed, message()], [null, 'Tidak ada gambar di baris ini']);
    });
    test('perintah menu Perbesar Gambar', () => {
        cursorTo(2); viewed = null;
        action('zoom-image');
        ok(viewed !== null, 'aksi tidak membuka penampil');
    });
    ed.onViewImage = originalOnView;

    test('penampil: gambar kecil dibuka 100%, gambar besar dipas ke jendela', () => {
        const small = openViewer(makePixbuf(100, 80));
        eq(small.zoom, 1, 'gambar kecil tidak diperbesar');
        const big = openViewer(makePixbuf(3000, 2000));
        ok(big.zoom < 0.5 && big.zoom > MIN_ZOOM, `zoom awal gambar besar ${big.zoom}`);
        ok(big.area.get_size_request()[0] <= big.window.get_allocated_width(), 'gambar lebih lebar dari jendela');
        small.close(); big.close();
    });
    test('zoom masuk/keluar mengalikan 1,25 dan dibatasi 5%–800%', () => {
        const v = openViewer(makePixbuf(100, 80));
        v.zoomIn(); eq(Math.round(v.zoom * 1000) / 1000, 1.25, 'zoom masuk');
        v.zoomOut(); v.zoomOut(); eq(Math.round(v.zoom * 1000) / 1000, 0.8, 'zoom keluar');
        for (let i = 0; i < 40; i++) v.zoomIn();
        eq(v.zoom, MAX_ZOOM, 'batas atas');
        for (let i = 0; i < 80; i++) v.zoomOut();
        eq(v.zoom, MIN_ZOOM, 'batas bawah');
        v.actual(); eq(v.zoom, 1, 'ukuran asli');
        v.close();
    });
    test('ukuran area gambar mengikuti zoom', () => {
        const v = openViewer(makePixbuf(400, 200));
        v.actual(); eq(v.area.get_size_request(), [400, 200], '100%');
        v.zoomIn(); eq(v.area.get_size_request(), [500, 250], '125%');
        v.close();
    });
    test('Pas memperbesar gambar kecil, 0 mengembalikan 100%', () => {
        const v = openViewer(makePixbuf(100, 80));
        v.fit(); settleV();
        ok(v.zoom > 1, `pas layar gambar kecil ${v.zoom}`);
        v.handleKey(Gdk.KEY_0); eq(v.zoom, 1, 'ukuran asli');
        v.close();
    });
    test('tombol: + − 0 F Esc; tombol lain tidak ditangani', () => {
        const v = openViewer(makePixbuf(100, 80));
        ok(v.handleKey(Gdk.KEY_plus) && Math.abs(v.zoom - 1.25) < 1e-9, '+');
        ok(v.handleKey(Gdk.KEY_minus) && Math.abs(v.zoom - 1) < 1e-9, '−');
        ok(v.handleKey(Gdk.KEY_f), 'F'); settleV(); ok(v.zoom > 1, 'F memperbesar gambar kecil');
        ok(v.handleKey(Gdk.KEY_0) && v.zoom === 1, '0');
        ok(!v.handleKey(Gdk.KEY_a), 'tombol lain');
        ok(v.handleKey(Gdk.KEY_Escape) && v.closed, 'Esc menutup');
    });
    test('zoom di titik penunjuk: titik gambar di bawah penunjuk tidak bergeser', () => {
        const v = openViewer(makePixbuf(2000, 1500));
        v.actual(); settleV();
        const scroller = v['scroller'];
        scroller.get_hadjustment().set_value(0); scroller.get_vadjustment().set_value(0);
        // Roda ke atas di titik (400, 300) pada gambar yang tergulir ke (0, 0).
        v.scrollZoom(-1, true, [400, 300]); settleV();
        // Titik gambar (400, 300) kini di 500 × 375; agar tetap di (400, 300) layar, gulir (100, 75).
        const [h, vv] = [scroller.get_hadjustment().get_value(), scroller.get_vadjustment().get_value()];
        ok(Math.abs(h - 100) < 1.5 && Math.abs(vv - 75) < 1.5, `gulir (${h}, ${vv}), seharusnya (100, 75)`);
        v.close();
    });
    test('drag menggeser gambar', () => {
        const v = openViewer(makePixbuf(2000, 1500));
        v.actual(); settleV();
        const scroller = v['scroller'];
        scroller.get_hadjustment().set_value(0); scroller.get_vadjustment().set_value(0);
        v.beginDrag();
        v.dragBy(-50, -30);   // digeser ke kiri-atas = melihat bagian kanan-bawah
        eq([scroller.get_hadjustment().get_value(), scroller.get_vadjustment().get_value()], [50, 30], 'gulir');
        v.endDrag(); ok(!v.dragBy(-500, -500), 'setelah lepas tombol, gerak tidak menggeser');
        v.close();
    });
    test('klik ganda di penampil: bergantian pas layar dan 100%', () => {
        const v = openViewer(makePixbuf(3000, 2000));
        const fitted = v.zoom;
        emitClick(v.area, 2); eq(v.zoom, 1, 'ke 100%');
        emitClick(v.area, 2); settleV();
        ok(Math.abs(v.zoom - fitted) < 0.02, `kembali ke pas layar (${v.zoom} vs ${fitted})`);
        v.close();
    });
    test('fungsi bantu zoom', () => {
        eq([clampZoom(100), clampZoom(0), clampZoom(2)], [MAX_ZOOM, MIN_ZOOM, 2], 'clampZoom');
        eq(fitZoom(1000, 500, 500, 500), 0.5, 'fitZoom mengikuti sisi yang lebih sempit');
    });
    test('menggambar dengan zoom besar tidak memicu peringatan GTK/cairo', () => {
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
        eq(warnings, [], 'peringatan');
    });
    w.file = null;
}
