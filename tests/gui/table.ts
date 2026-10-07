// Tes GUI: Tabel (grid dan penyuntingan).

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import { cellIndexAt } from '../../src/markdown/table.js';
import { section, test, eq, ok } from '../framework.js';
import type { GuiContext } from './context.js';
import { iterAtLine } from '../../src/gtkutil.js';
import { emitClick } from '../widgets.js';

export function tableGridTests(c: GuiContext): void {
    const { w, ed, buf, pump, text, setText, cursorTo, key, action } = c;

    section('Tabel (grid dan penyuntingan)');
    //  0 atas | 1 (kosong) | 2 judul | 3 pemisah | 4 satu | 5 dua | 6 (kosong) | 7 bawah
    const DOC = 'atas\n\n| Nama | Nilai |\n| :--- | ---: |\n| satu | 1 |\n| dua | 2 |\n\nbawah';
    const settleT = () => { for (let i = 0; i < 30; i++) { pump(); GLib.usleep(10000); } };
    const tBlock = () => ed.tableLayer.blocks[0];
    const tableTag = (line: number) => iterAtLine(buf, line).has_tag(ed.tags.tablehide);
    const lineAt = (n: number) => text().split('\n')[n];
    const curLine = () => buf.get_iter_at_mark(buf.get_insert()).get_line();
    const curCol = () => cellIndexAt(lineAt(curLine()), buf.get_iter_at_mark(buf.get_insert()).get_line_offset());
    const tableLines = (from: number, to: number) => text().split('\n').slice(from, to + 1);
    const tableMessage = () => w.lastToast;

    test('tabel di luar kursor dirender sebagai grid', () => {
        setText(DOC); cursorTo(0); settleT();
        const b = tBlock();
        ok(b.collapsed && b.widget && b.widget.get_visible(), 'grid tidak tampil');
        ok([2, 3, 4, 5].every(tableTag), 'baris tabel tidak dikecilkan');
        ok(!tableTag(1) && !tableTag(6) && !tableTag(0), 'teks di luar tabel ikut dikecilkan');
    });
    test('isi dokumen tidak berubah karena grid', () => eq(text(), DOC));
    test('grid berada di antara paragraf di atas dan di bawahnya', () => {
        const [prevY, prevH] = ed.view.get_line_yrange(iterAtLine(buf, 1));
        const [nextY] = ed.view.get_line_yrange(iterAtLine(buf, 6));
        const b = tBlock();
        ok(b.height > 0, 'tinggi grid 0');
        ok(b.y >= prevY + prevH, `grid (y=${b.y}) menimpa paragraf di atasnya (bawah=${prevY + prevH})`);
        ok(b.y + b.height <= nextY, `grid (bawah=${b.y + b.height}) menimpa paragraf di bawahnya (atas=${nextY})`);
    });
    test('kursor masuk ke tabel: teks mentah tampil, grid hilang', () => {
        cursorTo(4); settleT();
        const b = tBlock();
        ok(!b.collapsed && !b.widget?.get_visible(), 'grid masih tampil');
        ok(![2, 3, 4, 5].some(tableTag), 'baris tabel masih dikecilkan');
    });
    test('kursor keluar lagi: grid kembali', () => {
        cursorTo(7); settleT();
        ok(tBlock().collapsed && tBlock().widget?.get_visible(), 'grid tidak kembali');
    });
    test('klik sel menaruh kursor di sel itu pada teks mentah', () => {
        cursorTo(0); settleT();
        ed.tableLayer.onActivate(5, 1);
        pump();
        eq([curLine(), curCol()], [5, 1], 'sel baris "dua" kolom 2');
        ok(!tBlock().collapsed, 'tabel tidak terbuka');
        cursorTo(0); ed.tableLayer.onActivate(2, 0); pump();
        eq([curLine(), curCol()], [2, 0], 'sel judul kolom 1');
    });
    test('grid yang dipakai ulang mengarahkan klik ke baris baru setelah teks bergeser', () => {
        setText(DOC); cursorTo(0); settleT();
        const widget = tBlock().widget!;
        buf.insert(buf.get_start_iter(), 'tambahan\n', -1); pump(); settleT();
        ok(tBlock().widget === widget, 'grid dibangun ulang saat hanya baris bergeser');
        emitClick(tBlock().grid!.get_child_at(0, 0)!);
        pump();
        eq(curLine(), 3, 'klik judul memakai baris tabel yang sudah bergeser');
    });
    test('kursor dan seleksi hanya mengubah tag tabel yang berganti keadaan', () => {
        setText(`${DOC}\n\n${DOC}\n\n${DOC}`); cursorTo(0); settleT();
        const blocks = ed.tableLayer.blocks;
        eq(blocks.length, 3);
        const widgets = blocks.map(b => b.widget);
        const touched: number[] = [];
        const record = (_buf: Gtk.TextBuffer, tag: Gtk.TextTag, start: Gtk.TextIter) => {
            if (tag === ed.tags.tablehide || tag.name?.startsWith('table-gap-')) touched.push(start.get_line());
        };
        const applied = buf.connect('apply-tag', record);
        const removed = buf.connect('remove-tag', record);
        try {
            cursorTo(blocks[1].start);
            ok(touched.length > 0 && touched.every(l => l >= blocks[1].start && l <= blocks[1].end), 'tag tabel lain disentuh');
            eq(blocks.map(b => b.collapsed), [true, false, true]);
            touched.length = 0;
            cursorTo(blocks[1].end);
            eq(touched.length, 0, 'perpindahan dalam tabel memasang ulang tag');
            buf.select_range(iterAtLine(buf, blocks[0].start), iterAtLine(buf, blocks[2].end));
            pump(); settleT();
            eq(blocks.map(b => b.collapsed), [false, false, false]);
            ok(blocks.every(b => !tableTag(b.start)), 'seleksi lintas tabel masih menyembunyikan teks');
            cursorTo(0); settleT();
            ok(blocks.every((b, i) => b.collapsed && b.widget === widgets[i] && b.widget?.get_visible()), 'grid tidak dipakai ulang');
            ok(blocks.every(b => tableTag(b.start)), 'tag tidak kembali setelah seleksi dilepas');
        } finally {
            buf.disconnect(applied);
            buf.disconnect(removed);
        }
    });
    test('grid di luar layar diposisikan saat digulir tanpa mengubah ruang tabel', () => {
        setText(`${DOC}\n\n`.repeat(40)); cursorTo(0); settleT();
        const first = ed.tableLayer.blocks[0];
        const last = ed.tableLayer.blocks[39];
        ok(first.widget?.get_visible(), 'grid awal tidak tampil');
        eq(last.widget, null, 'grid di luar layar dibuat sebelum diperlukan');
        ok(ed.tableLayer.blocks.filter(b => b.widget).length < 10, 'terlalu banyak grid dibuat saat membuka');
        const height = ed.view.get_vadjustment()!.upper;
        ed.view.scroll_to_iter(iterAtLine(buf, last.end), 0, true, 0, 0.5);
        settleT();
        ok(last.widget?.get_visible(), 'grid akhir tidak tampil setelah digulir');
        // Letak widget sebenarnya (bukan angka yang disimpan lapisan) harus ikut bergulir.
        const [, gx, gy] = last.widget!.translate_coordinates(ed.view, 0, 0);
        eq([gx, gy], ed.view.buffer_to_window_coords(Gtk.TextWindowType.WIDGET, last.x, last.y), 'letak grid setelah digulir');
        eq(last.widget!.measure(Gtk.Orientation.VERTICAL, -1)[1], last.height, 'tinggi cadangan berbeda dari grid sebenarnya');
        ok(!first.widget?.get_visible(), 'grid awal tidak disembunyikan setelah digulir');
        const [lineY, lineHeight] = ed.view.get_line_yrange(iterAtLine(buf, last.end));
        eq(last.y, lineY + lineHeight - last.height - 12, 'posisi grid akhir salah');
        eq(ed.view.get_vadjustment()!.upper, height, 'menyembunyikan grid mengubah tinggi dokumen');
        ed.view.scroll_to_iter(buf.get_start_iter(), 0, true, 0, 0);
        settleT();
        ok(first.widget?.get_visible(), 'grid awal tidak kembali');
    });
    test('tinggi tabel di luar layar tepat untuk isi berbeda, Unicode, dan pergantian tema', () => {
        const docs = Array.from({ length: 30 }, (_, i) =>
            `atas ${i}\n\n| **Judul ${i}** | Nilai |\n| --- | --- |\n| 🎉 ${i} | \`kode\` |\n` +
            (i % 2 ? '| baris tambahan | ==sorot== |\n' : '') + '\nbawah\n\n');
        setText(docs.join('')); cursorTo(0); settleT();
        const last = ed.tableLayer.blocks[29];
        eq(last.widget, null, 'tabel berbeda di luar layar sudah dibuat');
        const height = ed.view.get_vadjustment()!.upper;
        ed.view.scroll_to_iter(iterAtLine(buf, last.end), 0, true, 0, 0.5); settleT();
        ok(last.widget?.get_visible(), 'grid akhir tidak muncul');
        eq(last.widget!.measure(Gtk.Orientation.VERTICAL, -1)[1], last.height, 'tinggi pengukur salah');
        eq(ed.view.get_vadjustment()!.upper, height, 'membuat grid menggeser tinggi dokumen');
        w.setDark(true); settleT();
        ok(last.widget?.get_visible(), 'grid hilang saat tema berubah');
        eq(last.widget!.measure(Gtk.Orientation.VERTICAL, -1)[1], last.height, 'tinggi tema gelap salah');
        w.setDark(false); settleT();
    });
    test('Tab pindah ke sel berikutnya, lalu ke baris berikutnya', () => {
        setText(DOC); cursorTo(4, 2);
        key(Gdk.KEY_Tab); eq([curLine(), curCol()], [4, 1], 'sel kedua');
        key(Gdk.KEY_Tab); eq([curLine(), curCol()], [5, 0], 'baris berikutnya');
    });
    test('Tab di sel terakhir menambah baris baru', () => {
        cursorTo(5, 9);
        key(Gdk.KEY_Tab);
        eq(text().split('\n').length, DOC.split('\n').length + 1, 'jumlah baris');
        eq(lineAt(6), '|  |  |', 'baris baru');
        eq([curLine(), curCol()], [6, 0], 'kursor di sel pertama baris baru');
    });
    test('Shift+Tab mundur, dan berhenti di sel pertama', () => {
        setText(DOC); cursorTo(5, 2);
        key(Gdk.KEY_ISO_Left_Tab, Gdk.ModifierType.SHIFT_MASK); eq([curLine(), curCol()], [4, 1], 'ke baris sebelumnya');
        cursorTo(2, 2);
        key(Gdk.KEY_ISO_Left_Tab, Gdk.ModifierType.SHIFT_MASK); eq([curLine(), curCol()], [2, 0], 'tetap di sel pertama');
    });
    test('Enter pindah ke sel yang sama di baris berikutnya, melewati baris pemisah', () => {
        setText(DOC); cursorTo(2, 9);
        key(Gdk.KEY_Return); eq([curLine(), curCol()], [4, 1], 'dari judul ke baris isi pertama');
        key(Gdk.KEY_Return); eq([curLine(), curCol()], [5, 1], 'ke baris berikutnya');
    });
    test('Enter di baris terakhir menambah baris; di baris kosong terakhir keluar dari tabel', () => {
        key(Gdk.KEY_Return);
        eq(lineAt(6), '|  |  |', 'baris baru');
        eq([curLine(), curCol()], [6, 1], 'kursor di sel yang sama');
        key(Gdk.KEY_Return);
        eq(lineAt(6), '', 'baris kosong dihapus');
        eq(text(), DOC, 'dokumen kembali seperti semula');
        eq(curLine(), 6, 'kursor di luar tabel');
    });
    test('Enter di luar tabel tidak ditangani tabel', () => {
        setText('teks\n\n| a |\n| - |\n| 1 |'); cursorTo(0, 4);
        ok(!ed.onKey(Gdk.KEY_Return, 0), 'Enter di paragraf biasa ditangani');
    });
    test('tabel hanya judul: Tab di sel terakhir menambah baris isi', () => {
        setText('| a | b |\n| --- | --- |\n\nx'); cursorTo(0, 6);
        key(Gdk.KEY_Tab);
        eq(tableLines(0, 3), ['| a | b |', '| --- | --- |', '|  |  |', ''], 'baris baru');
        eq([curLine(), curCol()], [2, 0], 'kursor');
    });

    test('perintah: tambah baris di bawah (kolom dirapikan)', () => {
        setText(DOC); cursorTo(4, 2);
        ed.tableCommand('row-below');
        eq(tableLines(2, 6), ['| Nama | Nilai |', '| :--- | ----: |', '| satu |     1 |', '|      |       |', '| dua  |     2 |']);
        eq([curLine(), curCol()], [5, 0], 'kursor di baris baru');
    });
    test('perintah: tambah baris di atas dan hapus baris', () => {
        setText(DOC); cursorTo(5, 2);
        ed.tableCommand('row-above');
        eq(tableLines(4, 6).map(l => l.trim()), ['| satu |     1 |', '|      |       |', '| dua  |     2 |'], 'sisip di atas "dua"');
        eq(curLine(), 5, 'kursor di baris baru');
        ed.tableCommand('delete-row');
        eq(tableLines(2, 5), ['| Nama | Nilai |', '| :--- | ----: |', '| satu |     1 |', '| dua  |     2 |'], 'baris dihapus');
    });
    test('perintah: tambah dan hapus kolom', () => {
        setText(DOC); cursorTo(4, 2);
        ed.tableCommand('col-right');   // kursor di kolom 1, jadi kolom baru di kanannya
        eq(tableLines(2, 5), ['| Nama |     | Nilai |', '| :--- | --- | ----: |', '| satu |     |     1 |', '| dua  |     |     2 |'], 'kolom baru');
        eq([curLine(), curCol()], [4, 1], 'kursor di kolom baru');
        ed.tableCommand('delete-col');
        eq(tableLines(2, 5), ['| Nama | Nilai |', '| :--- | ----: |', '| satu |     1 |', '| dua  |     2 |'], 'kolom baru dihapus; kolom lain utuh');
        ed.tableCommand('col-left');    // kursor sekarang di kolom "Nilai" (menggantikan kolom yang dihapus)
        eq(lineAt(2), '| Nama |     | Nilai |', 'kolom baru di kiri "Nilai"');
    });
    test('perintah: rata tengah dan rapikan', () => {
        setText('| a | b |\n| --- | --- |\n| panjang | 1 |'); cursorTo(0, 2);
        ed.tableCommand('align-center');
        eq(tableLines(0, 2), ['| a       | b   |', '| :-----: | --- |', '| panjang | 1   |'].map((l, i) => i === 0 ? '|    a    | b   |' : l));
        ed.tableCommand('format');
        eq(lineAt(2), '| panjang | 1   |', 'rapikan tidak mengubah yang sudah rapi');
    });
    test('perintah yang tidak boleh ditolak dengan pesan', () => {
        setText(DOC); cursorTo(2, 2);
        ed.tableCommand('delete-row'); eq(tableMessage(), 'Baris judul tidak bisa dihapus');
        ed.tableCommand('row-above'); eq(tableMessage(), 'Tidak bisa menyisipkan baris di atas judul tabel');
        cursorTo(0);
        ed.tableCommand('format'); eq(tableMessage(), 'Kursor harus berada di dalam tabel');
        eq(text(), DOC, 'dokumen tidak berubah');
    });
    test('satu perintah tabel = satu langkah undo', () => {
        setText(DOC); cursorTo(4, 2);
        ed.tableCommand('format');
        ok(text() !== DOC, 'perintah tidak mengubah dokumen');
        buf.undo(); pump();
        eq(text(), DOC, 'setelah undo');
    });
    test('perintah tabel lewat aksi menu', () => {
        setText(DOC); cursorTo(4, 2);
        action('table-row-below');
        eq(text().split('\n').length, DOC.split('\n').length + 1, 'jumlah baris');
    });
    test('mode source menampilkan tabel mentah', () => {
        setText(DOC); cursorTo(0); settleT();
        ok(tBlock().collapsed, 'awal: grid tampil');
        action('source');
        ok(!tBlock().collapsed && !tBlock().widget?.get_visible() && !tableTag(3), 'mode source: grid masih tampil');
        action('source');
        ok(tBlock().collapsed && tBlock().widget?.get_visible(), 'setelah mode source dimatikan');
    });
    test('grid dipersempit agar muat di lebar kolom teks', () => {
        const before = ed.tableLayer.maxWidth;
        setText(`| ${'x'.repeat(80)} | ${'y'.repeat(80)} |\n| --- | --- |\n| 1 | 2 |\n\nakhir`); cursorTo(4);
        settleT();
        const widget = tBlock().widget;
        const height = tBlock().height;
        ed.tableLayer.setMaxWidth(320);
        settleT();
        eq(tBlock().widget, widget, 'perubahan lebar membangun ulang grid');
        ok(tBlock().height > height, 'sel panjang seharusnya dibungkus sehingga tabel lebih tinggi');
        const grid = tBlock().widget!.get_first_child()!;
        const wrapped = grid.get_allocated_height();
        ok(Math.abs(wrapped - tBlock().height) <= 2, `ruang tabel ${tBlock().height}px tidak sama dengan tinggi grid ${wrapped}px`);
        // TextView memberi anak widget ukuran minimumnya; itulah lebar yang tampil.
        const width = tBlock().widget!.get_allocated_width();
        ok(width > 0 && width <= 320, `lebar grid ${width}px melebihi kolom 320px`);
        ed.tableLayer.setMaxWidth(before);
    });
    test('mengetik di tabel tidak membangun ulang grid selama kursor di dalamnya', () => {
        setText(DOC); cursorTo(4, 2); settleT();
        buf.insert_at_cursor('x', -1); pump();
        ok(tBlock().widget === null, 'grid dibangun saat kursor di dalam tabel');
        cursorTo(0); settleT();
        ok(tBlock().widget?.get_visible(), 'grid tidak muncul setelah kursor keluar');
    });
    test('tabel dan gambar beralt emoji tidak memicu peringatan GTK/Pango', () => {
        // Font emoji berwarna pada ukuran teks nyaris nol pernah membuat GTK gagal menggambar.
        const warnings: string[] = [];
        const flags = GLib.LogLevelFlags.LEVEL_WARNING | GLib.LogLevelFlags.LEVEL_CRITICAL;
        const handlers = ['Gtk', 'Pango', 'Gdk'].map(domain =>
            [domain, GLib.log_set_handler(domain, flags, (_d, _l, message) => { warnings.push(`${domain}: ${message}`); })] as const);
        try {
            setText('atas\n\n| 🎉 | b |\n| --- | --- |\n| 👍🏽 | ✨ |\n\n![🎉 alt](gambar/tidak-ada.png)\n\nbawah');
            cursorTo(0); settleT();
            cursorTo(4); settleT();
            cursorTo(8); settleT();
        } finally {
            for (const [domain, id] of handlers) GLib.log_remove_handler(domain, id);
        }
        eq(warnings, [], 'peringatan');
    });
    test('tabel di akhir dokumen tanpa baris baru', () => {
        setText('teks\n\n| a |\n| - |\n| 1 |'); cursorTo(0); settleT();
        ok(tBlock().collapsed && tBlock().widget?.get_visible(), 'grid tidak tampil');
        eq(text(), 'teks\n\n| a |\n| - |\n| 1 |', 'isi dokumen');
    });
    buf.set_modified(false);
}
