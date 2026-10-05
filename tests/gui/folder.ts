// Tes GUI: Folder.

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { isKanban, parseBoard } from '../../src/markdown/kanban.js';
import { DEFAULTS, loadSettings } from '../../src/settings.js';
import { listFolder } from '../../src/ui/filetree.js';
import { MainWindow } from '../../src/window.js';
import { widgetPixbuf } from '../widgets.js';
import { section, test, eq, ok, tmp, optVal } from '../framework.js';
import type { GuiContext } from './context.js';
import type { MenuEntry } from '../../src/ui/menu.js';

export function folderTests(c: GuiContext): void {
    const { app, w, ed, buf, pump } = c;

    section('Folder');
    // Struktur uji:
    //   proyek/a.md  b.txt  Catatan.markdown  sub/c.md  sub/dalam/d.md
    //   proyek/.tersembunyi/x.md  node_modules/y.md  z-kosong/
    const proj = GLib.build_filenamev([tmp, 'proyek']);
    const write = (rel: string, content = '') => {
        const full = GLib.build_filenamev([proj, rel]);
        GLib.mkdir_with_parents(GLib.path_get_dirname(full), 0o755);
        GLib.file_set_contents(full, content);
        return full;
    };
    write('a.md', '# A');
    write('b.txt', 'bukan markdown');
    write('Catatan.markdown', '# Catatan');
    write('sub/c.md', '# C');
    const dPath = write('sub/dalam/d.md', '# D');
    write('.tersembunyi/x.md');
    write('node_modules/y.md');
    GLib.mkdir_with_parents(GLib.build_filenamev([proj, 'z-kosong']), 0o755);

    const ft = w.fileTree;
    const childNames = (parent: Gtk.TreeIter | null) => {
        const names: string[] = [];
        let [ok, it] = ft.store.iter_children(parent);
        while (ok) { names.push(ft.store.get_value(it, 0) as string); ok = ft.store.iter_next(it); }
        return names;
    };
    const rowOf = (parent: Gtk.TreeIter | null, name: string) => {
        let [ok, it] = ft.store.iter_children(parent);
        while (ok) { if (ft.store.get_value(it, 0) === name) return it; ok = ft.store.iter_next(it); }
        throw new Error(`baris "${name}" tidak ada`);
    };
    const waitFor = (cond: () => boolean) => {
        for (let i = 0; i < 300 && !cond(); i++) { pump(); GLib.usleep(10000); }
        return cond();
    };

    test('isi folder: subfolder dulu, hanya Markdown, tanpa file tersembunyi', () => {
        eq(listFolder(proj).map(e => e.name), ['sub', 'z-kosong', 'a.md', 'Catatan.markdown']);
    });
    test('membuka folder menampilkan pohon di tab Berkas', () => {
        w.openFolder(proj);
        pump();
        eq(ft.root, proj, 'root');
        eq(childNames(null), ['sub', 'z-kosong', 'a.md', 'Catatan.markdown'], 'baris root');
        eq(w.sidebar.page, 'files', 'tab sidebar');
        ok(w.sidebar.visible, 'sidebar tidak terlihat');
        eq(loadSettings().folder, proj, 'folder tersimpan di pengaturan');
    });
    test('isi subfolder baru dibaca saat dibuka', () => {
        const sub = rowOf(null, 'sub');
        eq(childNames(sub), [''], 'sebelum dibuka (baris pengganti)');
        ft.view.expand_row(ft.store.get_path(sub)!, false);
        pump();
        eq(childNames(sub), ['dalam', 'c.md'], 'setelah dibuka');
    });
    test('klik file di pohon membukanya di editor (tab baru bila dokumen aktif sedang dipakai)', () => {
        const row = rowOf(null, 'a.md');
        ft.view.row_activated(ft.store.get_path(row)!, ft.view.get_column(0)!);
        pump();
        eq(w.file, GLib.build_filenamev([proj, 'a.md']), 'file');
        eq(w.editor.getText(), '# A', 'isi editor');
        // Kembali ke editor semula supaya tes berikutnya memakai buffer yang sama.
        if (w.editor !== ed) ok(w.closeTab(), 'closeTab() gagal');
        ok(w.editor === ed, 'editor semula tidak aktif lagi');
    });
    test('file yang dibuka disorot, folder induknya ikut dibuka', () => {
        ok(w.load(dPath), 'load() gagal');
        pump();
        const [selected, , iter] = ft.view.get_selection().get_selected();
        ok(selected && iter, 'tidak ada baris tersorot');
        eq(ft.store.get_value(iter, 1), dPath, 'baris tersorot');
        const dalam = rowOf(rowOf(null, 'sub'), 'dalam');
        ok(ft.view.row_expanded(ft.store.get_path(dalam)!), 'folder "dalam" tidak terbuka');
    });
    test('file baru di disk muncul tanpa menutup subfolder yang terbuka', () => {
        write('b-baru.md', '# Baru');
        ok(waitFor(() => childNames(null).includes('b-baru.md')), 'file baru tidak muncul');
        eq(childNames(null), ['sub', 'z-kosong', 'a.md', 'b-baru.md', 'Catatan.markdown'], 'urutan');
        ok(ft.view.row_expanded(ft.store.get_path(rowOf(null, 'sub'))!), 'subfolder ikut tertutup');
    });
    test('file yang dihapus di disk hilang dari pohon', () => {
        GLib.unlink(GLib.build_filenamev([proj, 'b-baru.md']));
        ok(waitFor(() => !childNames(null).includes('b-baru.md')), 'file terhapus masih tampil');
    });
    test('file non-Markdown yang ditambahkan tidak muncul', () => {
        write('gambar.png');
        write('c-baru.md');
        ok(waitFor(() => childNames(null).includes('c-baru.md')), 'file Markdown baru tidak muncul');
        ok(!childNames(null).includes('gambar.png'), 'file .png ikut tampil');
    });
    test('load() dengan path folder membuka folder, bukan error', () => {
        ft.setRoot(null);
        // Sebelum diperbaiki, ini menampilkan dialog error "Is a directory" (dan tes macet di dialog itu).
        ok(w.load(proj), 'load() gagal');
        pump();
        eq(ft.root, proj, 'root');
        eq(w.sidebar.page, 'files', 'tab sidebar');
        eq(w.file, GLib.build_filenamev([proj, 'sub', 'dalam', 'd.md']), 'file yang terbuka tidak berubah');
    });
    test('folder sebagai argumen membuka folder itu', () => {
        const w2 = new MainWindow(app, { ...DEFAULTS, welcomed: true, dark: false }, proj);
        pump();
        eq(w2.fileTree.root, proj, 'root jendela kedua');
        eq(w2.file, null, 'tidak ada file yang dibuka');
        w2.editor.buffer.set_modified(false);
        w2.win.destroy();
        pump();
    });
    test('folder terakhir dipulihkan tanpa memaksa sidebar terbuka', () => {
        const w3 = new MainWindow(app, { ...DEFAULTS, welcomed: true, dark: false, folder: proj, sidebar: false }, null);
        pump();
        eq(w3.fileTree.root, proj, 'root');
        ok(!w3.sidebar.visible, 'sidebar dipaksa terbuka');
        w3.editor.buffer.set_modified(false);
        w3.win.destroy();
        pump();
    });
    // ---------- Kelola berkas lewat pohon ----------
    const prompts: (string | null)[] = [];
    const errors: string[] = [];
    const confirms: boolean[] = [];
    ft.dialogs = { prompt: () => prompts.shift() ?? null, confirm: () => confirms.shift() ?? false, error: msg => { errors.push(msg); } };
    const menuLabels = (m: MenuEntry[]) => m.map(i => i.label);
    const activate = (m: MenuEntry[], label: string) => m.find(i => i.label === label)!.run!();
    const opened: string[] = [];
    const openBefore = ft.onOpenFile;
    ft.onOpenFile = p => { opened.push(p); openBefore(p); };
    ft.setRoot(proj);
    w.file = null;
    buf.set_modified(false);

    test('menu klik kanan berisi File Baru, Folder Baru, dan Papan Kanban Baru', () => {
        eq(menuLabels(ft.contextMenu(null)), ['File Baru…', 'Folder Baru…', 'Papan Kanban Baru…']);
    });
    test('klik kanan area kosong membuat file di root dan membukanya', () => {
        prompts.push('kosong-baru');
        activate(ft.contextMenu(null), 'File Baru…');
        pump();
        ok(waitFor(() => childNames(null).includes('kosong-baru.md')), 'file tidak muncul di pohon');
        ok(GLib.file_test(GLib.build_filenamev([proj, 'kosong-baru.md']), GLib.FileTest.EXISTS), 'file tidak ada di disk');
        eq(opened, [GLib.build_filenamev([proj, 'kosong-baru.md'])], 'file tidak dibuka');
        eq(w.file, GLib.build_filenamev([proj, 'kosong-baru.md']), 'file editor');
    });
    test('klik kanan folder membuat file di dalam folder itu', () => {
        prompts.push('di-sub.md');
        activate(ft.contextMenu(ft.store.get_path(rowOf(null, 'sub'))!), 'File Baru…');
        pump();
        ok(GLib.file_test(GLib.build_filenamev([proj, 'sub', 'di-sub.md']), GLib.FileTest.EXISTS), 'file tidak ada di disk');
        const sub = rowOf(null, 'sub');
        ok(childNames(sub).includes('di-sub.md'), 'file tidak muncul di folder');
        ok(ft.view.row_expanded(ft.store.get_path(sub)!), 'folder tujuan tidak terbuka');
    });
    test('klik kanan file membuat file di folder induknya', () => {
        const row = rowOf(rowOf(null, 'sub'), 'c.md');
        prompts.push('sebelah');
        activate(ft.contextMenu(ft.store.get_path(row)!), 'File Baru…');
        pump();
        ok(GLib.file_test(GLib.build_filenamev([proj, 'sub', 'sebelah.md']), GLib.FileTest.EXISTS), 'file tidak di folder induk');
    });
    test('file baru dari menu terbuka di tabnya sendiri; dokumen pertama tetap ada', () => {
        eq(w.documentCount, 3, 'jumlah tab');
        eq(w.file, GLib.build_filenamev([proj, 'sub', 'sebelah.md']), 'file tab aktif');
        eq(ed.getText(), '', 'isi dokumen pertama');
        // Kembali ke editor semula supaya tes berikutnya memakai buffer yang sama.
        while (w.editor !== ed) ok(w.closeTab(), 'closeTab() gagal');
        eq(w.documentCount, 1, 'jumlah tab setelah ditutup');
    });
    test('Papan Kanban Baru membuat file papan di folder yang diklik dan membukanya sebagai papan', () => {
        // --shot-tree-menu=<prefix>: simpan tangkapan menu klik kanan (<prefix>-menu.png) dan papan yang dibuat (<prefix>-papan.png).
        const shot = optVal('shot-tree-menu');
        if (shot) {
            const popover = ft.popupContextMenu(ft.store.get_path(rowOf(null, 'sub'))!, 40, 40);
            for (let i = 0; i < 20; i++) { pump(); GLib.usleep(10000); }
            widgetPixbuf(popover)?.savev(`${shot}-menu.png`, 'png', [], []);
            popover.popdown();
            // Popover dilepas dari TreeView di idle; tunggu sampai lepas sebelum pohon diubah.
            ok(waitFor(() => !popover.get_parent()), 'popover tidak dilepas');
        }
        prompts.push('tugas');
        activate(ft.contextMenu(ft.store.get_path(rowOf(null, 'sub'))!), 'Papan Kanban Baru…');
        pump();
        const path = GLib.build_filenamev([proj, 'sub', 'tugas.md']);
        ok(GLib.file_test(path, GLib.FileTest.EXISTS), 'file papan tidak ada di disk');
        const text = new TextDecoder().decode(GLib.file_get_contents(path)[1]);
        ok(isKanban(text), 'isi file bukan papan kanban');
        eq(parseBoard(text).columns.map(c => c.title), ['Rencana', 'Dikerjakan', 'Selesai'], 'daftar papan');
        ok(childNames(rowOf(null, 'sub')).includes('tugas.md'), 'file papan tidak tampil di pohon');
        eq(w.file, path, 'file tab aktif');
        ok(w.boardMode, 'papan tidak tampil');
        ok(!w.editor.buffer.get_modified(), 'papan baru ditandai belum disimpan');
        if (shot) {
            for (let i = 0; i < 20; i++) { pump(); GLib.usleep(10000); }
            widgetPixbuf(w.win)?.savev(`${shot}-papan.png`, 'png', [], []);
        }
        while (w.editor !== ed) ok(w.closeTab(), 'closeTab() gagal');
    });
    test('Papan Kanban Baru dengan nama bentrok menampilkan galat tanpa menimpa', () => {
        errors.length = 0;
        prompts.push('a');
        const before = new TextDecoder().decode(GLib.file_get_contents(GLib.build_filenamev([proj, 'a.md']))[1]);
        activate(ft.contextMenu(null), 'Papan Kanban Baru…');
        eq(errors.length, 1, 'galat bentrok');
        eq(new TextDecoder().decode(GLib.file_get_contents(GLib.build_filenamev([proj, 'a.md']))[1]), before, 'isi a.md');
    });
    test('Folder Baru membuat folder di root dan di dalam folder', () => {
        prompts.push('baru-root');
        activate(ft.contextMenu(null), 'Folder Baru…');
        ok(waitFor(() => childNames(null).includes('baru-root')), 'folder root tidak muncul');
        prompts.push('baru-dalam');
        activate(ft.contextMenu(ft.store.get_path(rowOf(null, 'z-kosong'))!), 'Folder Baru…');
        ok(GLib.file_test(GLib.build_filenamev([proj, 'z-kosong', 'baru-dalam']), GLib.FileTest.IS_DIR), 'folder dalam tidak dibuat');
        ok(childNames(rowOf(null, 'z-kosong')).includes('baru-dalam'), 'folder dalam tidak tampil');
    });
    test('nama bentrok atau tidak valid menampilkan galat, dialog dibatalkan tidak membuat apa-apa', () => {
        errors.length = 0;
        prompts.push('a');
        activate(ft.contextMenu(null), 'File Baru…');
        eq(errors.length, 1, 'galat bentrok');
        prompts.push('x/y');
        activate(ft.contextMenu(null), 'Folder Baru…');
        eq(errors.length, 2, 'galat nama tidak valid');
        const before = childNames(null).length;
        prompts.push(null);
        activate(ft.contextMenu(null), 'File Baru…');
        eq(childNames(null).length, before, 'dibatalkan');
    });

    const abs = (...p: string[]) => GLib.build_filenamev([proj, ...p]);
    test('menu baris menambah Ganti Nama dan Hapus; area kosong tidak', () => {
        const row = ft.store.get_path(rowOf(null, 'a.md'))!;
        eq(menuLabels(ft.contextMenu(row)).filter(l => l), ['File Baru…', 'Folder Baru…', 'Papan Kanban Baru…', 'Ganti Nama…', 'Hapus']);
        eq(menuLabels(ft.contextMenu(null)), ['File Baru…', 'Folder Baru…', 'Papan Kanban Baru…']);
    });
    test('ganti nama file dan folder memperbarui pohon dan disk', () => {
        write('lama.md');
        ok(waitFor(() => childNames(null).includes('lama.md')), 'file uji tidak muncul');
        prompts.push('baru');
        activate(ft.contextMenu(ft.store.get_path(rowOf(null, 'lama.md'))!), 'Ganti Nama…');
        ok(GLib.file_test(abs('baru.md'), GLib.FileTest.EXISTS) && !GLib.file_test(abs('lama.md'), GLib.FileTest.EXISTS), 'disk');
        ok(waitFor(() => childNames(null).includes('baru.md') && !childNames(null).includes('lama.md')), 'pohon');
        prompts.push('ganti-dir');
        activate(ft.contextMenu(ft.store.get_path(rowOf(null, 'z-kosong'))!), 'Ganti Nama…');
        ok(GLib.file_test(abs('ganti-dir'), GLib.FileTest.IS_DIR), 'folder diganti namanya');
        ok(ft.rename(abs('ganti-dir')) === null, 'dialog dibatalkan tidak mengubah apa pun');
        prompts.push('z-kosong');
        activate(ft.contextMenu(ft.store.get_path(rowOf(null, 'ganti-dir'))!), 'Ganti Nama…');
        ok(GLib.file_test(abs('z-kosong'), GLib.FileTest.IS_DIR), 'kembali');
    });
    test('ganti nama ditolak jika bentrok; file terbuka mengikuti nama baru', () => {
        errors.length = 0;
        prompts.push('a.md');
        activate(ft.contextMenu(ft.store.get_path(rowOf(null, 'baru.md'))!), 'Ganti Nama…');
        eq(errors.length, 1, 'galat bentrok');
        ok(w.load(abs('baru.md')), 'load');
        prompts.push('terbuka');
        ft.rename(abs('baru.md'));
        eq(w.file, abs('terbuka.md'), 'path dokumen');
    });
    test('hapus meminta konfirmasi; batal tidak menghapus', () => {
        confirms.push(false);
        ok(!ft.remove(abs('terbuka.md')), 'dibatalkan');
        ok(GLib.file_test(abs('terbuka.md'), GLib.FileTest.EXISTS), 'file hilang padahal dibatalkan');
    });
    test('hapus membuang file ke sampah dan melepas dokumen yang terbuka', () => {
        errors.length = 0;
        confirms.push(true);
        const done = ft.remove(abs('terbuka.md'));
        if (!done) { eq(errors.length, 1, 'gagal tanpa galat'); return; }  // lingkungan tanpa Tempat Sampah
        ok(!GLib.file_test(abs('terbuka.md'), GLib.FileTest.EXISTS), 'file masih ada');
        ok(!childNames(null).includes('terbuka.md'), 'baris masih ada');
        eq(w.file, null, 'dokumen terbuka dilepas');
        ok(buf.get_modified(), 'isi harus ditandai belum disimpan');
        buf.set_modified(false);
    });
    test('pindahkan file ke dalam folder', () => {
        errors.length = 0;
        ok(ft.moveTo(abs('Catatan.markdown'), abs('z-kosong')), 'moveTo gagal');
        ok(GLib.file_test(abs('z-kosong', 'Catatan.markdown'), GLib.FileTest.EXISTS), 'file belum pindah');
        ok(!childNames(null).includes('Catatan.markdown'), 'baris lama masih ada');
        ok(childNames(rowOf(null, 'z-kosong')).includes('Catatan.markdown'), 'baris baru tidak ada');
        eq(errors, [], 'galat');
    });
    test('pindahkan file keluar dari folder ke root', () => {
        ok(ft.moveTo(abs('z-kosong', 'Catatan.markdown'), proj), 'moveTo gagal');
        ok(childNames(null).includes('Catatan.markdown'), 'baris tidak muncul di root');
        ok(!childNames(rowOf(null, 'z-kosong')).includes('Catatan.markdown'), 'baris lama masih ada');
    });
    test('pindahkan folder ke folder lain dan keluar lagi', () => {
        ok(ft.moveTo(abs('baru-root'), abs('sub')), 'moveTo gagal');
        ok(GLib.file_test(abs('sub', 'baru-root'), GLib.FileTest.IS_DIR), 'folder belum pindah');
        ok(childNames(rowOf(null, 'sub')).includes('baru-root'), 'baris tidak muncul di folder tujuan');
        ok(ft.moveTo(abs('sub', 'baru-root'), proj), 'moveTo keluar gagal');
        ok(childNames(null).includes('baru-root'), 'baris tidak kembali ke root');
    });
    test('folder tidak bisa dipindah ke dalam dirinya atau turunannya, bentrok nama ditolak', () => {
        errors.length = 0;
        ok(!ft.moveTo(abs('sub'), abs('sub', 'dalam')), 'masuk ke turunan seharusnya gagal');
        eq(errors.length, 1, 'galat');
        ok(GLib.file_test(abs('sub', 'dalam'), GLib.FileTest.IS_DIR), 'folder hilang');
        write('z-kosong/a.md');
        ok(!ft.moveTo(abs('a.md'), abs('z-kosong')), 'bentrok seharusnya gagal');
        ok(GLib.file_test(abs('a.md'), GLib.FileTest.EXISTS), 'sumber hilang');
    });
    test('memindahkan file yang sedang terbuka memperbarui path dokumen', () => {
        ok(w.load(abs('sub', 'c.md')), 'load');
        ok(ft.moveTo(abs('sub', 'c.md'), proj), 'moveTo');
        eq(w.file, abs('c.md'), 'path dokumen');
        ok(!buf.get_modified(), 'dokumen tidak boleh berubah');
        ok(ft.moveTo(abs('sub'), abs('z-kosong')), 'pindah folder induk');
        ok(w.load(abs('z-kosong', 'sub', 'dalam', 'd.md')), 'load d.md');
        ok(ft.moveTo(abs('z-kosong', 'sub'), proj), 'kembalikan');
        eq(w.file, abs('sub', 'dalam', 'd.md'), 'path dokumen setelah folder induk pindah');
    });
    buf.set_modified(false);
    w.file = null;
    ft.onOpenFile = openBefore;

    test('menutup folder mengosongkan pohon', () => {
        ft.setRoot(null);
        eq(childNames(null), [], 'baris');
    });
    buf.set_modified(false);
    w.file = null;
}
