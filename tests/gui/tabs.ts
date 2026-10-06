// Tes GUI: Banyak dokumen (tab) dalam satu jendela.

import GLib from 'gi://GLib';
import { section, test, eq, ok, tmp } from '../framework.js';
import { readTextFile } from '../../src/files.js';
import { AppSettings } from '../../src/settings.js';
import { MainWindow } from '../../src/window.js';
import { registerActions } from '../../src/actions.js';
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
    const tabsShown = () => w.tabBar.widget.tabs_revealed;

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
        eq(w.outline.count, 2, 'heading bab 2');
        w.switchTab(-1); settle();
        eq(w.file, bab1, 'file setelah pindah');
        eq(w.outline.count, 1, 'heading bab 1');
        ok(w.statusBar.right.label.includes('kata'), `status: ${w.statusBar.right.label}`);
    });
    test('file panjang di tab baru terbuka dari awal, bukan tergulir ke tengah', () => {
        // Editor tab baru belum punya ukuran saat isinya diganti; gulir yang tertunda tidak boleh
        // memakai geometri kosong itu (GTK 4 lalu menggulir ke tengah/akhir dokumen).
        const panjang = put('panjang.md', Array.from({ length: 300 }, (_, i) => `Paragraf ${i}`).join('\n\n'));
        w.openFile(panjang); settle();
        const vadj = w.editor.view.get_vadjustment()!;
        ok(vadj.get_upper() > vadj.get_page_size() * 2, 'dokumen tidak cukup panjang untuk digulir');
        eq(vadj.get_value(), 0, 'posisi gulir');
        w.closeTab(); settle();
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

    // ---------- Pemulihan tab ----------
    section('Pemulihan tab');
    const bab3 = put('bab-3.md', '# Bab Tiga\n\nBaris kedua.\n\nBaris ketiga yang dituju kursor.\n');
    const settingsFor = (extra: Partial<AppSettings>): AppSettings => AppSettings.inMemory({ welcomed: true, dark: false, autosave: false, ...extra });
    // Jendela kedua mendaftarkan ulang aksi aplikasi; hancurkan lalu kembalikan aksi ke jendela tes utama.
    const closeWindow = (win: MainWindow) => {
        win.win.destroy();
        settle();
        registerActions(c.app, w);
    };
    const opened = (win: MainWindow) => {
        const files: (string | null)[] = [];
        for (let i = 0; i < win.documentCount; i++) { win.switchTab(1); files.push(win.file); }
        return files;
    };

    test('menutup jendela mencatat tab berfile, urutan, tab aktif, dan kursornya', () => {
        const s = settingsFor({});
        const w2 = new MainWindow(c.app, s, null); settle();
        w2.openFile(bab1); settle();
        w2.newDocument(); settle();
        w2.editor.buffer.insert_at_cursor('tanpa file', -1);
        w2.editor.buffer.set_modified(false);   // dokumen tanpa file: tidak ikut dicatat, tanpa dialog
        w2.openFile(bab3); settle();
        w2.editor.restoreCursor(20); settle();
        w2.openFile(bab2); settle();
        w2.switchTab(-1); settle();   // bab-3 aktif (urutan tab: bab-1, kosong, bab-3, bab-2)
        ok(w2.onClose(), 'onClose() menolak menutup');
        eq(s.tabs.map(t => t.file), [bab1, bab3, bab2], 'tab tercatat');
        eq(s.activeTab, 1, 'tab aktif');
        eq(s.tabs[1].cursor, 20, 'kursor bab-3');
        closeWindow(w2);
    });
    test('membuka tanpa argumen memulihkan tab, tab aktif, dan kursor', () => {
        const s = settingsFor({ tabs: [{ file: bab1, cursor: 0 }, { file: bab3, cursor: 20 }, { file: bab2, cursor: 3 }], activeTab: 1 });
        const w2 = new MainWindow(c.app, s, null); settle();
        eq(w2.documentCount, 3, 'jumlah tab');
        eq(w2.file, bab3, 'tab aktif');
        eq(w2.editor.cursorOffset, 20, 'kursor tab aktif');
        ok(!w2.editor.buffer.get_modified(), 'dokumen dipulihkan ditandai berubah');
        eq(opened(w2), [bab2, bab1, bab3], 'urutan tab');   // mulai dari tab sesudah bab-3
        closeWindow(w2);
    });
    test('file yang hilang dilewati dan tidak dibuat ulang', () => {
        const hilang = path('hilang.md');
        const s = settingsFor({ tabs: [{ file: hilang, cursor: 0 }, { file: bab2, cursor: 0 }], activeTab: 0 });
        const w2 = new MainWindow(c.app, s, null); settle();
        eq(w2.documentCount, 1, 'jumlah tab');
        eq(w2.file, bab2, 'tab aktif jatuh ke tab yang ada');
        ok(!GLib.file_test(hilang, GLib.FileTest.EXISTS), 'file hilang dibuat ulang');
        ok(w2.lastToast.includes('tidak ditemukan'), `status: ${w2.lastToast}`);
        closeWindow(w2);
    });
    test('kursor di luar dokumen dipotong ke akhir', () => {
        const s = settingsFor({ tabs: [{ file: bab1, cursor: 99999 }], activeTab: 0 });
        const w2 = new MainWindow(c.app, s, null); settle();
        eq(w2.editor.cursorOffset, w2.editor.buffer.get_char_count(), 'kursor');
        closeWindow(w2);
    });
    test('file dari argumen tidak memulihkan tab terakhir', () => {
        const s = settingsFor({ tabs: [{ file: bab1, cursor: 0 }, { file: bab2, cursor: 0 }], activeTab: 0 });
        const w2 = new MainWindow(c.app, s, bab3); settle();
        eq(w2.documentCount, 1, 'jumlah tab');
        eq(w2.file, bab3, 'file');
        closeWindow(w2);
    });
    test('tab yang tidak punya file dan indeks aktif di luar daftar diabaikan', () => {
        const s = settingsFor({ tabs: [{ file: '', cursor: 0 }, { file: path('hilang-2.md'), cursor: 0 }], activeTab: 5 });
        const w2 = new MainWindow(c.app, s, null); settle();
        eq(w2.documentCount, 1, 'jumlah tab');
        eq(w2.file, null, 'file');
        closeWindow(w2);
    });

    w.file = null;
    c.setText('');
}
