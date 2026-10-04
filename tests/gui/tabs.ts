// Tes GUI: Banyak dokumen (tab) dalam satu jendela.

import GLib from 'gi://GLib';
import { section, test, eq, ok, tmp } from '../framework.js';
import { readTextFile } from '../../src/files.js';
import type { GuiContext } from './context.js';

export function tabTests(c: GuiContext): void {
    const { w, ed, pump } = c;

    section('Tab dokumen');
    const dir = GLib.build_filenamev([tmp, 'tab']);
    GLib.mkdir_with_parents(dir, 0o755);
    const path = (name: string) => GLib.build_filenamev([dir, name]);
    const put = (name: string, text: string) => { GLib.file_set_contents(path(name), text); return path(name); };
    const bab1 = put('bab-1.md', '# Bab Satu\n\nRaka berusia dua puluh tahun.\n');
    const bab2 = put('bab-2.md', '# Bab Dua\n\n## Bagian\n\nIsi bab dua.\n');
    const papan = put('papan.md', '---\nkanban: true\n---\n\n## Rencana\n\n- [ ] Kartu\n');
    const settle = () => { for (let i = 0; i < 30; i++) { pump(); GLib.usleep(10000); } };
    const tabsShown = () => w.tabBar.widget.get_reveal_child();

    // Mulai dari satu dokumen kosong tanpa file.
    w.file = null;
    c.setText('');

    test('satu dokumen: baris tab tersembunyi', () => {
        eq(w.documentCount, 1, 'jumlah dokumen');
        ok(!tabsShown(), 'baris tab tampil untuk satu dokumen');
    });
    test('membuka file di dokumen kosong memakai ulang tab itu', () => {
        w.openFile(bab1); settle();
        eq(w.documentCount, 1, 'jumlah dokumen');
        ok(w.editor === ed, 'editor berganti');
        eq(w.file, bab1, 'file');
    });
    test('membuka file kedua membuka tab baru dan dokumen pertama tetap utuh', () => {
        w.openFile(bab2); settle();
        eq(w.documentCount, 2, 'jumlah dokumen');
        ok(tabsShown(), 'baris tab tersembunyi');
        ok(w.editor !== ed, 'editor tidak berganti');
        eq(w.file, bab2, 'file aktif');
        eq(w.editor.getText().startsWith('# Bab Dua'), true, 'isi tab aktif');
        eq(ed.getText().startsWith('# Bab Satu'), true, 'isi tab pertama');
        eq(w.win.get_title(), 'bab-2.md — Nyerat', 'judul jendela');
    });
    test('outline dan hitungan kata mengikuti tab aktif', () => {
        eq(w.outline.list.get_children().length, 2, 'heading bab 2');
        w.switchTab(-1); settle();
        eq(w.file, bab1, 'file setelah pindah');
        eq(w.outline.list.get_children().length, 1, 'heading bab 1');
        ok(w.statusBar.right.label.includes('kata'), `status: ${w.statusBar.right.label}`);
    });
    test('membuka file yang sudah terbuka hanya berpindah tab', () => {
        w.openFile(bab2); settle();
        eq(w.documentCount, 2, 'jumlah dokumen');
        eq(w.file, bab2, 'file aktif');
    });
    test('undo tiap tab terpisah', () => {
        const second = w.editor;
        w.switchTab(-1); settle();
        ok(w.editor === ed, 'bukan tab pertama');
        ed.buffer.insert_at_cursor('YYY', -1); pump();
        w.switchTab(1); settle();
        second.buffer.place_cursor(second.buffer.get_end_iter());
        second.buffer.insert_at_cursor('ZZZ', -1); pump();
        second.buffer.undo(); pump();
        ok(!second.getText().includes('ZZZ'), 'undo tab kedua gagal');
        ok(ed.getText().includes('YYY'), 'undo tab kedua mengubah tab pertama');
        w.switchTab(-1); settle();
        ed.buffer.undo(); pump();
        ok(!ed.getText().includes('YYY'), 'undo tab pertama gagal');
        ed.buffer.set_modified(false);
        second.buffer.set_modified(false);
        w.switchTab(1); settle();
    });
    test('tanda belum disimpan muncul per tab', () => {
        const second = w.editor;
        second.buffer.insert_at_cursor('x', -1); pump();
        ok(w.win.get_title()!.startsWith('• '), `judul: ${w.win.get_title()}`);
        w.switchTab(-1); settle();
        ok(!w.win.get_title()!.startsWith('• '), `judul tab lain: ${w.win.get_title()}`);
        second.buffer.undo(); second.buffer.set_modified(false); pump();
    });
    test('pencarian mengikuti editor aktif', () => {
        w.switchTab(1); settle();
        ok(w.findBar.buffer === w.editor.buffer, 'buffer pencarian tidak berganti');
        w.switchTab(-1); settle();
        ok(w.findBar.buffer === ed.buffer, 'buffer pencarian tidak kembali');
    });
    test('mode tampilan dan tema diwarisi tab baru', () => {
        w.setOption('focus', true);
        w.openFile(papan); settle();
        eq(w.documentCount, 3, 'jumlah dokumen');
        ok(w.editor.modes.focus, 'mode fokus tidak ikut');
        w.setOption('focus', false);
        ok(!w.editor.modes.focus && !ed.modes.focus, 'mode fokus tidak dimatikan di semua tab');
    });
    test('papan kanban dan teks bergantian antar tab', () => {
        ok(w.boardMode, 'papan tidak tampil');
        w.switchTab(-1); settle();
        ok(!w.boardMode, 'papan tetap tampil di tab teks');
        w.switchTab(1); settle();
        ok(w.boardMode, 'papan tidak kembali');
    });
    test('menutup tab aktif berpindah ke tetangganya', () => {
        const kanban = w.editor;
        ok(w.closeTab(), 'closeTab() gagal'); settle();
        eq(w.documentCount, 2, 'jumlah dokumen');
        ok(w.editor !== kanban, 'tab yang ditutup masih aktif');
        eq(w.file, bab2, 'file aktif');
        ok(!w.boardMode, 'papan masih tampil');
    });
    test('menutup tab dengan perubahan menyimpannya lebih dulu bila auto save aktif', () => {
        w.setOption('autosave', true);
        w.editor.buffer.insert_at_cursor('!', -1); pump();
        ok(w.closeTab(), 'closeTab() gagal'); settle();
        ok(readTextFile(bab2).includes('!'), 'perubahan tidak tersimpan');
        eq(w.documentCount, 1, 'jumlah dokumen');
        ok(w.editor === ed, 'editor semula tidak aktif');
        ok(!tabsShown(), 'baris tab masih tampil untuk satu dokumen');
        w.setOption('autosave', false);
    });
    test('menutup tab terakhir mengosongkan dokumennya', () => {
        ok(w.closeTab(), 'closeTab() gagal');
        eq(w.documentCount, 1, 'jumlah dokumen');
        eq(w.file, null, 'file');
        eq(w.editor.getText(), '', 'isi');
    });
    test('asisten membaca isi tab yang belum disimpan', () => {
        w.openFolder(dir, false);
        w.openFile(bab1); settle();
        w.openFile(bab2); settle();
        w.editor.buffer.insert_at_cursor('BELUM-DISIMPAN ', -1); pump();
        w.switchTab(-1); settle();
        eq(w.file, bab1, 'file aktif');
        w.setOption('autosave', false);
        const other = w.chat.host.files().find(f => f.name === 'bab-2.md');
        ok(other?.text.includes('BELUM-DISIMPAN'), 'asisten membaca versi di disk');
        // Bersihkan: tutup tab kedua tanpa menyimpan.
        w.switchTab(1); settle();
        w.editor.buffer.undo(); w.editor.buffer.set_modified(false); pump();
        ok(w.closeTab(), 'closeTab() gagal');
        ok(w.closeTab(), 'closeTab() terakhir gagal');
    });

    w.file = null;
    c.setText('');
}
