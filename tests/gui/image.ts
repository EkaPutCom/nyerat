// Tes GUI: Gambar.

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import { section, test, eq, ok, tmp } from '../framework.js';
import type { GuiContext } from './context.js';
import { iterAtLine } from '../../src/gtkutil.js';

export function imageTests(c: GuiContext): void {
    const { w, ed, buf, pump, text, setText, cursorTo, hidden, action, imgDir, images, waitImages } = c;

    section('Gambar');
    // Gambar uji 300×100 di folder sementara.
    GLib.mkdir_with_parents(imgDir, 0o755);
    const pb = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 300, 100);
    pb.fill(0x4183c4ff);
    pb.savev(GLib.build_filenamev([imgDir, 'uji.png']), 'png', [], []);
    const hasGap = (line: number) => iterAtLine(buf, line).get_tags().some(t => t.name?.startsWith('image-gap-'));

    test('gambar lokal dimuat dan ditampilkan di bawah barisnya', () => {
        w.file = GLib.build_filenamev([tmp, 'dok.md']);
        setText('judul\n\n![uji](gambar/uji.png)\n\nakhir');
        waitImages();
        eq(images().length, 1, 'jumlah blok gambar');
        const block = images()[0];
        eq(block.items[0].entry?.status, 'ok', 'status muat');
        ok(block.box.get_visible(), 'widget gambar tidak terlihat');
        ok(hasGap(2), 'ruang di bawah baris gambar tidak disediakan');
        const [lineY] = ed.view.get_line_yrange(iterAtLine(buf, 2));
        ok(block.y > lineY, `gambar (y=${block.y}) tidak di bawah barisnya (y=${lineY})`);
    });
    test('gambar di bawah dokumen panjang tampil di tempatnya setelah digulir', () => {
        try {
            setText(`${'paragraf\n\n'.repeat(80)}![uji](gambar/uji.png)\n\nakhir`);
            waitImages();
            const block = images()[0];
            ed.view.scroll_to_iter(iterAtLine(buf, block.line), 0, true, 0, 0.5);
            for (let i = 0; i < 30; i++) { pump(); GLib.usleep(10000); }
            ok(ed.view.get_vadjustment()!.get_value() > 500, 'dokumen tidak tergulir');
            const [, gx, gy] = block.box.translate_coordinates(ed.view, 0, 0);
            eq([gx, gy], ed.view.buffer_to_window_coords(Gtk.TextWindowType.WIDGET, block.x, block.y), 'letak gambar');
            ok(gy >= 0 && gy < ed.view.get_height(), `gambar di luar layar (y=${gy})`);
        } finally {
            // Tes berikutnya memakai dokumen pendek ini.
            setText('judul\n\n![uji](gambar/uji.png)\n\nakhir');
            waitImages();
        }
    });
    test('isi dokumen tidak berubah karena gambar', () => {
        eq(text(), 'judul\n\n![uji](gambar/uji.png)\n\nakhir');
    });
    test('sintaks gambar tersembunyi di baris lain, terlihat di baris aktif', () => {
        cursorTo(0);
        ok(hidden(9) && hidden(15), '![uji](...) seharusnya tersembunyi');
        cursorTo(2);
        ok(!hidden(9) && !hidden(15), '![uji](...) seharusnya terlihat');
    });
    test('widget dipakai ulang saat baris bergeser', () => {
        const before = images()[0];
        buf.insert(buf.get_start_iter(), 'baris baru\n', -1);
        pump();
        eq(images().length, 1, 'jumlah blok gambar');
        ok(images()[0] === before, 'widget dibuat ulang');
        eq(images()[0].line, 3, 'baris gambar');
        ok(hasGap(3) && !hasGap(2), 'ruang kosong tidak ikut pindah');
    });
    test('gambar yang tidak ada menampilkan pesan', () => {
        setText('![hilang](gambar/tidak-ada.png)');
        waitImages();
        eq(images()[0].items[0].entry?.status, 'error', 'status muat');
        const label = images()[0].content.get_first_child();
        ok(label instanceof Gtk.Label && label.label.includes('hilang'), 'label error tidak tampil');
    });
    test('gambar di baris tabel dan blok kode diabaikan', () => {
        setText('| ![a](gambar/uji.png) |\n| --- |\n\n```\n![b](gambar/uji.png)\n```');
        eq(images().length, 0, 'jumlah blok gambar');
    });
    test('mode source menyembunyikan gambar', () => {
        setText('![uji](gambar/uji.png)\nteks');
        waitImages();
        action('source');
        ok(!images()[0].box.get_visible() && !hasGap(0), 'gambar masih tampil di mode source');
        action('source');
        ok(images()[0].box.get_visible() && hasGap(0), 'gambar tidak muncul lagi');
    });
    test('klik gambar memindahkan kursor ke barisnya', () => {
        cursorTo(1);
        ed.images.onActivate(images()[0].line);
        pump();
        eq(buf.get_iter_at_mark(buf.get_insert()).get_line(), 0, 'baris kursor');
    });
    test('menghapus sintaks gambar menghapus widgetnya', () => {
        setText('teks saja');
        eq(images().length, 0, 'jumlah blok gambar');
    });
}
