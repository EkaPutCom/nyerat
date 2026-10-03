// Tes GUI: Folder.

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=3.0';
import { DEFAULTS, loadSettings } from '../../src/settings.js';
import { listFolder } from '../../src/ui/filetree.js';
import { MainWindow } from '../../src/window.js';
import { section, test, eq, ok, tmp } from '../framework.js';
import type { GuiContext } from './context.js';

export function folderTests(c: GuiContext): void {
    const { app, w, buf, pump, text } = c;

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
    test('klik file di pohon membukanya di editor', () => {
        const row = rowOf(null, 'a.md');
        ft.view.row_activated(ft.store.get_path(row)!, ft.view.get_column(0)!);
        pump();
        eq(w.file, GLib.build_filenamev([proj, 'a.md']), 'file');
        eq(text(), '# A', 'isi editor');
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
    test('menutup folder mengosongkan pohon', () => {
        ft.setRoot(null);
        eq(childNames(null), [], 'baris');
    });
    buf.set_modified(false);
    w.file = null;
}
