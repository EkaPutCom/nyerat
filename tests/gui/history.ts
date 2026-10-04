// Tes GUI: tab Riwayat git.

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { HistoryViewer } from '../../src/ui/historyviewer.js';
import type { Commit } from '../../src/gitlog.js';
import { section, test, eq, ok, tmp } from '../framework.js';
import type { GuiContext } from './context.js';
import { iterAtLine } from '../../src/gtkutil.js';
import { childrenOf } from '../../src/gtkutil.js';
import { listRows } from '../widgets.js';

export function historyTests(c: GuiContext): void {
    const { w, pump, setText } = c;

    section('Riwayat git');
    const repo = GLib.build_filenamev([tmp, 'repo-riwayat']);
    const plain = GLib.build_filenamev([tmp, 'tanpa-git']);
    GLib.mkdir_with_parents(repo, 0o755);
    GLib.mkdir_with_parents(plain, 0o755);
    const env = [...GLib.get_environ(), 'GIT_CONFIG_GLOBAL=/dev/null', 'GIT_CONFIG_SYSTEM=/dev/null'];
    const git = (...args: string[]) => {
        const [, , err, status] = GLib.spawn_sync(repo, ['git', '-c', 'user.name=Penguji', '-c', 'user.email=penguji@example.com', ...args], env, GLib.SpawnFlags.SEARCH_PATH, null);
        if (status !== 0) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(err ?? undefined)}`);
    };
    const write = (path: string, text: string) => GLib.file_set_contents(path, text);
    const waitFor = (cond: () => boolean) => {
        for (let i = 0; i < 500 && !cond(); i++) { pump(); GLib.usleep(10000); }
        return cond();
    };
    const rows = () => listRows(w.history.list).length;

    const a = GLib.build_filenamev([repo, 'a.md']);
    const untracked = GLib.build_filenamev([repo, 'baru.md']);
    const outside = GLib.build_filenamev([plain, 'x.md']);
    const V1 = '# Judul\n\nsatu\n', V2 = '# Judul\n\nsatu\ndua\n';
    git('init', '-q');
    write(a, V1);
    git('add', 'a.md');
    git('commit', '-q', '-m', 'Buat catatan');
    write(a, V2);
    git('commit', '-q', '-a', '-m', 'Tambah baris dua');
    write(untracked, '# Belum masuk git\n');
    write(outside, '# Di luar repo\n');

    w.sidebar.setVisible(true);
    w.sidebar.setPage('history');

    test('tab riwayat tidak membuat sidebar mengembang (sidebar tetap di tepi kiri, selebar 240)', () => {
        ok(!w.sidebar.widget.compute_expand(Gtk.Orientation.HORIZONTAL), 'sidebar menuntut ruang sisa');
        ok(!w.history.widget.compute_expand(Gtk.Orientation.HORIZONTAL), 'tab riwayat menuntut ruang sisa');
        w.win.set_default_size(1600, 700);
        for (let i = 0; i < 40; i++) { pump(); GLib.usleep(15000); }
        const a = w.sidebar.widget.get_allocation();
        ok(a.width <= 260, `lebar sidebar ${a.width}`);
        // Relatif ke isi jendela: di desktop, dekorasi/bayangan window manager menggeser alokasi toplevel.
        const x = w.sidebar.widget.translate_coordinates(w.win.get_child()!, 0, 0)[1];
        // Kembalikan ukuran: jendela yang lebih lebar dari layar Xvfb menaruh tombol di luar
        // monitor, dan popover dari tombol itu memicu Gdk-CRITICAL di GTK 4 (X11).
        w.win.set_default_size(1100, 700);
        for (let i = 0; i < 20; i++) { pump(); GLib.usleep(15000); }
        ok(x < 20, `sidebar bergeser ke x=${x}`);
    });
    test('daftar belum di-commit dengan kolom pesan tidak membuat sidebar mengembang', () => {
        ok(!w.history.commitBar.compute_expand(Gtk.Orientation.HORIZONTAL), 'kolom commit menuntut ruang sisa');
        ok(!w.history.changedBox.compute_expand(Gtk.Orientation.HORIZONTAL), 'daftar perubahan menuntut ruang sisa');
    });
    test('daftar belum di-commit dengan kolom pesan tidak membuat sidebar mengembang', () => {
        ok(!w.history.commitBar.compute_expand(Gtk.Orientation.HORIZONTAL), 'kolom commit menuntut ruang sisa');
        ok(!w.history.changedBox.compute_expand(Gtk.Orientation.HORIZONTAL), 'daftar perubahan menuntut ruang sisa');
    });
    test('riwayat file tampil terbaru dulu', () => {
        w.load(a);
        ok(waitFor(() => rows() === 2), 'jumlah baris riwayat');
        const label = (i: number) => ((w.history.list.get_row_at_index(i)!.get_child() as Gtk.Box).get_first_child() as Gtk.Label).label;
        eq([label(0), label(1)], ['Tambah baris dua', 'Buat catatan']);
    });
    test('file yang belum di-commit menampilkan pesan kosong', () => {
        w.load(untracked);
        ok(waitFor(() => rows() === 0 && w.history.note.label.includes('Belum ada commit')), `pesan: ${w.history.note.label}`);
    });
    test('file di luar repositori git menampilkan pesan', () => {
        w.load(outside);
        ok(waitFor(() => w.history.note.label.includes('tidak berada di repositori git')), `pesan: ${w.history.note.label}`);
    });
    test('dokumen tanpa file menampilkan petunjuk menyimpan', () => {
        w.history.setFile(null);
        ok(w.history.note.label.includes('Simpan dokumen'), `pesan: ${w.history.note.label}`);
    });
    test('riwayat tidak dimuat selama tab lain yang terbuka', () => {
        w.sidebar.setPage('outline');
        w.load(a);
        pump();
        eq(rows(), 0, 'baris riwayat');
        w.sidebar.setPage('history');
        ok(waitFor(() => rows() === 2), 'riwayat dimuat saat tab dibuka');
    });
    test('muat ulang menangkap commit baru', () => {
        write(a, V2 + 'tiga\n');
        git('commit', '-q', '-a', '-m', 'Tambah baris tiga');
        w.history.refresh();
        ok(waitFor(() => rows() === 3), 'commit baru tidak muncul');
    });

    let commits: Commit[] = [];
    test('klik commit membuka penampil dengan diff dan isi versi itu', () => {
        w.history.onOpen = commit => { commits.push(commit); };
        w.history.list.emit('row-activated', w.history.list.get_row_at_index(1)!);
        eq(commits.length, 1, 'commit dibuka');
        eq(commits[0].subject, 'Tambah baris dua');
        const viewer = new HistoryViewer(w.win, a, commits[0], false);
        try {
            const diff = () => viewer.diffView.buffer.get_text(viewer.diffView.buffer.get_start_iter(), viewer.diffView.buffer.get_end_iter(), false);
            ok(waitFor(() => diff().includes('+dua')), `diff: ${diff()}`);
            ok(!diff().includes('diff --git'), 'kepala diff tidak dibuang');
            const table = viewer.diffView.buffer.get_tag_table();
            const lineTags = (n: number) => iterAtLine(viewer.diffView.buffer, n).get_tags().map(t => t.name);
            eq(lineTags(0), ['hunk'], 'tag baris hunk');
            const added = diff().split('\n').findIndex(l => l === '+dua');
            eq(lineTags(added), ['add'], 'tag baris tambahan');
            ok(table.lookup('del') !== null, 'tag hapus ada');
            const content = () => viewer.contentView.buffer.get_text(viewer.contentView.buffer.get_start_iter(), viewer.contentView.buffer.get_end_iter(), false);
            ok(waitFor(() => content() === V2), `isi versi itu: ${JSON.stringify(content())}`);
            ok(!viewer.contentView.editable, 'isi bisa diedit');
            eq(viewer.diffView.wrap_mode, Gtk.WrapMode.WORD_CHAR, 'diff tidak di-wrap');
            eq(viewer.contentView.wrap_mode, Gtk.WrapMode.WORD_CHAR, 'isi tidak di-wrap');
        } finally {
            viewer.window.destroy();
        }
    });
    test('penampil menampilkan isi versi pertama untuk commit awal', () => {
        const first = commits[0];
        w.history.onOpen = commit => { commits.push(commit); };
        w.history.list.emit('row-activated', w.history.list.get_row_at_index(2)!);
        const root = commits[commits.length - 1];
        ok(root !== first, 'commit awal tidak dibuka');
        const viewer = new HistoryViewer(w.win, a, root, true);
        try {
            const content = () => viewer.contentView.buffer.get_text(viewer.contentView.buffer.get_start_iter(), viewer.contentView.buffer.get_end_iter(), false);
            ok(waitFor(() => content() === V1), `isi versi awal: ${JSON.stringify(content())}`);
            const diff = () => viewer.diffView.buffer.get_text(viewer.diffView.buffer.get_start_iter(), viewer.diffView.buffer.get_end_iter(), false);
            ok(waitFor(() => diff().includes('+# Judul')), `diff commit awal: ${diff()}`);
        } finally {
            viewer.window.destroy();
        }
    });

    test('perubahan yang belum di-commit tampil sebagai tombol dan diff terhadap HEAD', () => {
        w.load(a);
        ok(waitFor(() => rows() === 3), 'riwayat dimuat');
        ok(waitFor(() => !w.history.changes.get_visible()), 'tombol perubahan tampil padahal file bersih');
        write(a, V2 + 'tiga\nempat\n');
        w.history.refresh();
        ok(waitFor(() => w.history.changes.get_visible()), 'tombol perubahan tidak tampil');
        ok(w.history.changes.label!.includes('Perubahan belum di-commit'), String(w.history.changes.label));
        const viewer = new HistoryViewer(w.win, a, null, false);
        try {
            const diff = () => viewer.diffView.buffer.get_text(viewer.diffView.buffer.get_start_iter(), viewer.diffView.buffer.get_end_iter(), false);
            ok(waitFor(() => diff().includes('+empat')), `diff: ${diff()}`);
            ok(!diff().includes('+tiga'), 'baris yang sudah di-commit ikut tampil sebagai tambahan');
            ok(viewer.stack.get_child_by_name('content') === null, 'tab isi versi ikut muncul');
        } finally {
            viewer.window.destroy();
        }
        git('commit', '-q', '-a', '-m', 'Tambah baris empat');
        w.history.refresh();
        ok(waitFor(() => !w.history.changes.get_visible()), 'tombol tidak hilang setelah commit');
    });
    test('file baru yang belum dilacak diff-nya seluruh isi', () => {
        w.load(untracked);
        ok(waitFor(() => w.history.changes.get_visible()), 'tombol tidak tampil');
        ok(w.history.changes.label!.includes('File baru'), String(w.history.changes.label));
        const viewer = new HistoryViewer(w.win, untracked, null, false);
        try {
            const diff = () => viewer.diffView.buffer.get_text(viewer.diffView.buffer.get_start_iter(), viewer.diffView.buffer.get_end_iter(), false);
            ok(waitFor(() => diff().includes('+# Belum masuk git')), `diff: ${diff()}`);
        } finally {
            viewer.window.destroy();
        }
    });

    test('commit dari jendela perubahan hanya mengambil file itu', () => {
        write(a, V2 + 'tiga\nempat\nlima\n');
        write(untracked, '# Belum masuk git\nubah\n');
        git('add', 'baru.md');
        w.load(a);
        ok(waitFor(() => w.history.changes.get_visible()), 'tombol perubahan');
        const viewer = new HistoryViewer(w.win, a, null, false);
        let done = 0;
        viewer.onCommitted = () => { done++; };
        try {
            viewer.commitButton.emit('clicked');
            ok(viewer.status.get_text().includes('pesan'), 'pesan kosong tidak ditolak');
            eq(done, 0, 'commit tanpa pesan');
            viewer.messageEntry.set_text('Tambah baris lima');
            viewer.commitButton.emit('clicked');
            ok(waitFor(() => done === 1), `commit gagal: ${viewer.closed ? '' : viewer.status.get_text()}`);
        } finally {
            if (!viewer.closed) viewer.window.destroy();   // commit yang berhasil menutup jendelanya sendiri
        }
        w.history.refresh();
        ok(waitFor(() => rows() === 5 && !w.history.changes.get_visible()), 'riwayat tidak memuat commit baru');
        w.load(untracked);
        ok(waitFor(() => w.history.changes.get_visible()), 'file lain ikut ter-commit');
    });
    test('commit file baru yang belum dilacak', () => {
        const viewer = new HistoryViewer(w.win, untracked, null, false);
        let done = 0;
        viewer.onCommitted = () => { done++; };
        try {
            viewer.messageEntry.set_text('Tambah catatan baru');
            viewer.commitButton.emit('clicked');
            ok(waitFor(() => done === 1), `commit gagal: ${viewer.closed ? '' : viewer.status.get_text()}`);
        } finally {
            if (!viewer.closed) viewer.window.destroy();   // commit yang berhasil menutup jendelanya sendiri
        }
        w.history.refresh();
        ok(waitFor(() => rows() === 1 && !w.history.changes.get_visible()), 'riwayat file baru');
    });

    test('daftar semua file yang belum di-commit tampil dan membuka diff file yang diklik', () => {
        const b = GLib.build_filenamev([repo, 'b.md']);
        write(b, '# B\n');
        git('add', 'b.md');
        git('commit', '-q', '-m', 'Tambah b');
        write(b, '# B\nubah\n');
        write(GLib.build_filenamev([repo, 'c.md']), '# C\n');
        w.load(a);
        w.history.refresh();
        const names = () => listRows(w.history.changedList).map(r => (childrenOf(r.get_child()!)[2] as Gtk.Label).label);
        ok(waitFor(() => names().length === 2), `daftar: ${names()}`);
        eq(names().sort(), ['b.md', 'c.md']);
        ok(w.history.changedBox.get_visible() && (w.history.changedBox.label ?? '').includes('(2)'), `label: ${w.history.changedBox.label}`);
        const opened: string[] = [];
        w.history.onOpenChanges = f => { opened.push(f); };
        const idx = names().indexOf('b.md');
        w.history.changedList.emit('row-activated', w.history.changedList.get_row_at_index(idx)!);
        eq(opened, [b], 'file yang dibuka');
        const viewer = new HistoryViewer(w.win, b, null, false);
        try {
            const diff = () => viewer.diffView.buffer.get_text(viewer.diffView.buffer.get_start_iter(), viewer.diffView.buffer.get_end_iter(), false);
            ok(waitFor(() => diff().includes('+ubah')), `diff: ${diff()}`);
        } finally {
            viewer.window.destroy();
        }
        git('add', '-A');
        git('commit', '-q', '-m', 'Bersihkan');
        w.history.refresh();
        ok(waitFor(() => !w.history.changedBox.get_visible()), 'daftar tidak hilang setelah semua di-commit');
        w.history.onOpenChanges = () => {};
    });

    test('beberapa file dicentang lalu di-commit sekaligus', () => {
        const b = GLib.build_filenamev([repo, 'b.md']);
        const c2 = GLib.build_filenamev([repo, 'c.md']);
        const e = GLib.build_filenamev([repo, 'e.md']);
        write(b, '# B\nlagi\n');
        write(c2, '# C\nlagi\n');
        write(e, '# E\n');
        git('add', 'c.md');
        w.load(a);
        w.history.refresh();
        const names = () => listRows(w.history.changedList).map(r => (childrenOf(r.get_child()!)[2] as Gtk.Label).label);
        ok(waitFor(() => names().length >= 3 && w.history.commitButton.label === 'Commit 3 file'), `daftar: ${names()} / ${w.history.commitButton.label}`);
        const check = (name: string) => (w.history.changedList.get_row_at_index(names().indexOf(name))!.get_child()!.get_first_child() as Gtk.CheckButton);
        check('e.md').active = false;
        eq(w.history.commitButton.label, 'Commit 2 file');
        w.history.commitButton.emit('clicked');
        ok(w.history.commitStatus.get_text().includes('pesan'), 'pesan kosong tidak ditolak');
        let done = 0;
        w.history.onCommitted = () => { done++; };
        w.history.messageEntry.set_text('Commit b dan c');
        w.history.commitButton.emit('clicked');
        ok(waitFor(() => done === 1), `commit gagal: ${w.history.commitStatus.get_text()}`);
        w.history.refresh();
        ok(waitFor(() => names().join() === 'e.md'), `sisa daftar: ${names()}`);
        ok(!check('e.md').active, 'centang e.md hilang setelah muat ulang');
        eq(w.history.messageEntry.get_text(), '', 'pesan tidak dikosongkan');
        git('add', '-A');
        git('commit', '-q', '-m', 'Bersihkan e');
        w.history.onCommitted = () => {};
        w.history.refresh();
        ok(waitFor(() => !w.history.changedBox.get_visible()), 'daftar tidak hilang');
    });

    test('tanpa file, folder yang dibuka tetap menampilkan file yang belum di-commit', () => {
        write(GLib.build_filenamev([repo, 'd.md']), '# D\n');
        w.file = null; setText('');
        w.history.setFile(null, true, repo);
        ok(waitFor(() => listRows(w.history.changedList).length === 1), 'daftar kosong padahal folder punya file baru');
        ok(w.history.note.label.includes('Simpan dokumen'), 'petunjuk simpan hilang');
        w.history.setFile(null, true, null);
        ok(waitFor(() => listRows(w.history.changedList).length === 0), 'daftar tidak dikosongkan tanpa folder');
    });

    // Kembalikan keadaan untuk tes berikutnya.
    w.history.onOpen = () => {};
    w.sidebar.setPage('outline');
    w.file = null; setText('');
}
