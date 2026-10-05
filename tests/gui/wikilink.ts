// Tes GUI: tautan [[catatan]] (penyorotan, Ctrl+klik membuka/membuat catatan, saran saat mengetik [[).

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Graphene from 'gi://Graphene';
import GdkPixbuf from 'gi://GdkPixbuf';
import { widgetPixbuf } from '../widgets.js';
import { section, test, eq, ok, tmp, optVal } from '../framework.js';
import type { GuiContext } from './context.js';

export function wikiLinkGuiTests(c: GuiContext): void {
    const { w, ed, buf, pump, setText, offsetIn, hidden, tagAt, text } = c;

    section('Tautan [[catatan]]');
    const proj = GLib.build_filenamev([tmp, 'wiki']);
    const abs = (...parts: string[]) => GLib.build_filenamev([proj, ...parts]);
    const write = (rel: string, content: string) => {
        GLib.mkdir_with_parents(GLib.path_get_dirname(abs(rel)), 0o755);
        GLib.file_set_contents(abs(rel), content);
    };
    write('Ide.md', '# Ide\n\nisi\n\n## Bagian Dua\n\nlanjutan\n');
    write('Jurnal/Catatan Harian.md', 'awal\n');
    write('Jurnal/Rencana.md', '# Rencana\n');
    write('proyek/Catatan Rapat.md', '# Rapat\n');
    w.openFolder(proj);
    pump();
    ok(w.load(abs('Jurnal', 'Catatan Harian.md')), 'load');
    pump();

    const ctrlClick = (off: number) => {
        const rect = ed.view.get_iter_location(buf.get_iter_at_offset(off));
        const [x, y] = ed.view.buffer_to_window_coords(Gtk.TextWindowType.WIDGET, rect.x + 2, rect.y + rect.height / 2);
        const handled = ed.onClick(1, x, y, Gdk.ModifierType.CONTROL_MASK);
        pump();
        return handled;
    };
    const backToFirstTab = () => { while (w.editor !== ed) ok(w.closeTab(), 'closeTab() gagal'); };
    const type = (s: string) => {
        for (const ch of s) { buf.insert_at_cursor(ch, -1); pump(); }
    };
    const placeAtEnd = () => { buf.place_cursor(buf.get_end_iter()); pump(); };

    test('[[catatan]] tampil sebagai tautan, kurungnya tersembunyi di baris lain', () => {
        const s = 'lihat [[Ide]] dan [[Jurnal/Rencana|rencana]]\n\nbaris lain';
        setText(s);
        placeAtEnd();
        ok(tagAt(offsetIn(s, 'Ide]]'), 'link'), 'nama bukan tautan');
        ok(hidden(offsetIn(s, '[[Ide')), 'kurung buka terlihat');
        ok(hidden(offsetIn(s, 'Jurnal/')), 'target alias terlihat');
        ok(tagAt(offsetIn(s, 'rencana]]'), 'link'), 'alias bukan tautan');
        ok(!hidden(offsetIn(s, 'rencana]]')), 'alias tersembunyi');
    });
    test('Ctrl+klik [[catatan]] membuka berkasnya di tab baru dan melompat ke bagian', () => {
        const s = 'lihat [[ide#bagian dua]]\n\nx';
        setText(s);
        placeAtEnd();
        ok(ctrlClick(offsetIn(s, 'ide#')), 'klik tidak ditangani');
        eq(w.file, abs('Ide.md'), 'berkas yang terbuka');
        const cursor = w.editor.buffer.get_iter_at_mark(w.editor.buffer.get_insert());
        eq(cursor.get_line(), 4, 'baris kursor (heading Bagian Dua)');
        backToFirstTab();
    });
    test('Ctrl+klik catatan yang belum ada membuka dokumen kosong tanpa menulis ke disk', () => {
        const s = 'lanjut ke [[Catatan Baru]]\n\nx';
        setText(s);
        placeAtEnd();
        ok(ctrlClick(offsetIn(s, 'Catatan Baru')), 'klik tidak ditangani');
        eq(w.file, abs('Jurnal', 'Catatan Baru.md'), 'path catatan baru di samping dokumen asal');
        eq(w.editor.getText(), '', 'isi');
        ok(!GLib.file_test(abs('Jurnal', 'Catatan Baru.md'), GLib.FileTest.EXISTS), 'berkas sudah tertulis');
        backToFirstTab();
    });
    test('Ctrl+klik tautan Markdown relatif ke berkas .md dibuka di Nyerat', () => {
        const s = 'lihat [rencana](Rencana.md)\n\nx';
        setText(s);
        placeAtEnd();
        ok(ctrlClick(offsetIn(s, 'rencana]')), 'klik tidak ditangani');
        eq(w.file, abs('Jurnal', 'Rencana.md'), 'berkas yang terbuka');
        backToFirstTab();
    });
    test('mengetik [[ memunculkan saran; panah dan Enter menyisipkan nama lalu menutup ]]', () => {
        setText('');
        type('baca [[cat');
        ok(ed.completer.visible, 'saran tidak muncul');
        eq(ed.completer.items, ['Jurnal/Catatan Harian.md', 'proyek/Catatan Rapat.md'], 'isi saran');
        ok(ed.onKey(Gdk.KEY_Down, 0), 'panah bawah tidak ditangani');
        ok(ed.onKey(Gdk.KEY_Return, 0), 'Enter tidak ditangani');
        pump();
        eq(text(), 'baca [[Catatan Rapat]]', 'teks');
        ok(!ed.completer.visible, 'saran masih terbuka');
        eq(buf.get_iter_at_mark(buf.get_insert()).get_offset(), 22, 'kursor setelah ]]');
    });
    test('saran: Esc menutup, teks tanpa kecocokan menutup, ]] yang sudah ada tidak digandakan', () => {
        setText('');
        type('[[re');
        ok(ed.completer.visible, 'saran tidak muncul');
        ok(ed.onKey(Gdk.KEY_Escape, 0), 'Esc tidak ditangani');
        ok(!ed.completer.visible, 'Esc tidak menutup');
        ok(!ed.onKey(Gdk.KEY_Return, 0), 'Enter tertahan setelah saran ditutup');
        setText('');
        type('[[zzz');
        ok(!ed.completer.visible, 'saran muncul tanpa kecocokan');
        setText('[[]]');
        buf.place_cursor(buf.get_iter_at_offset(2));
        type('Ren');
        ok(ed.completer.visible, 'saran tidak muncul di dalam [[]]');
        ed.onKey(Gdk.KEY_Tab, 0);
        pump();
        eq(text(), '[[Rencana]]', 'teks');
        eq(buf.get_iter_at_mark(buf.get_insert()).get_offset(), 11, 'kursor setelah ]]');
    });
    test('memindah kursor ke [[ lama tidak memunculkan saran', () => {
        setText('[[Ide\n\nx');
        placeAtEnd();
        buf.place_cursor(buf.get_iter_at_offset(4));
        pump();
        ok(!ed.completer.visible, 'saran muncul');
    });

    // --shot-wikilink=<prefix>: simpan tangkapan saran [[ di tema terang dan gelap (<prefix>-terang.png, -gelap.png).
    // Popover punya permukaan sendiri, jadi digambar terpisah lalu ditempel di bawah kursor seperti di layar.
    const shot = optVal('shot-wikilink');
    if (shot) {
        const oldDark = w.dark;
        for (const [dark, name] of [[false, 'terang'], [true, 'gelap']] as const) {
            w.setDark(dark);
            setText('# Catatan Harian\n\nHari ini membahas [[Ide]] dan [[Jurnal/Rencana|rencana minggu depan]].\n\nTindak lanjut: ');
            placeAtEnd();
            type('[[ca');
            for (let i = 0; i < 20; i++) { pump(); GLib.usleep(10000); }
            const page = widgetPixbuf(w.win);
            const pop = widgetPixbuf(ed.completer.popover);
            ok(page && pop, 'tangkapan gagal');
            if (!page || !pop) continue;
            const rect = ed.view.get_iter_location(buf.get_iter_at_mark(buf.get_insert()));
            const [bx, by] = ed.view.buffer_to_window_coords(Gtk.TextWindowType.WIDGET, rect.x, rect.y + rect.height);
            const point = ed.view.compute_point(w.win, new Graphene.Point({ x: bx, y: by }));
            const [px, py] = point[0] ? [Math.round(point[1].x), Math.round(point[1].y)] : [0, 0];
            const width = Math.min(pop.get_width(), page.get_width() - px), height = Math.min(pop.get_height(), page.get_height() - py);
            pop.composite(page, px, py, width, height, px, py, 1, 1, GdkPixbuf.InterpType.NEAREST, 255);
            page.savev(`${shot}-${name}.png`, 'png', [], []);
            ed.completer.hide();
        }
        w.setDark(oldDark);
    }

    ed.completer.hide();
    setText('');
    buf.set_modified(false);
    w.file = null;
    w.fileTree.setRoot(null);
    pump();
}
