// Tes GUI: tab Riwayat git.

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=3.0';
import { HistoryViewer } from '../../src/ui/historyviewer.js';
import type { Commit } from '../../src/gitlog.js';
import { section, test, eq, ok, tmp } from '../framework.js';
import type { GuiContext } from './context.js';

export function historyTests(c: GuiContext): void {
    const { w, pump } = c;

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
    const rows = () => w.history.list.get_children().length;

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
        w.win.resize(1600, 700);
        for (let i = 0; i < 40; i++) { pump(); GLib.usleep(15000); }
        const a = w.sidebar.widget.get_allocation();
        ok(a.width <= 260, `lebar sidebar ${a.width}`);
        ok(a.x < 20, `sidebar bergeser ke x=${a.x}`);
    });
    test('riwayat file tampil terbaru dulu', () => {
        w.load(a);
        ok(waitFor(() => rows() === 2), 'jumlah baris riwayat');
        const label = (i: number) => ((w.history.list.get_row_at_index(i)!.get_child() as Gtk.Box).get_children()[0] as Gtk.Label).label;
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
            const lineTags = (n: number) => viewer.diffView.buffer.get_iter_at_line(n).get_tags().map(t => t.name);
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

    // Kembalikan keadaan untuk tes berikutnya.
    w.history.onOpen = () => {};
    w.sidebar.setPage('outline');
    w.newDocument();
}
