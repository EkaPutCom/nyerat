// Tes operasi berkas: buat file/folder dan pindahkan.

import GLib from 'gi://GLib';
import { createFile, createFolder, moveEntry, remapPath, renameEntry } from '../../src/fileops.js';
import { section, test, eq, ok, tmp } from '../framework.js';

const throws = (fn: () => unknown, part: string): void => {
    try { fn(); } catch (e) { ok((e as Error).message.includes(part), `pesan "${(e as Error).message}" tidak memuat "${part}"`); return; }
    throw new Error('seharusnya melempar galat');
};

export function fileOpsTests(): void {
    section('Operasi berkas');
    const base = GLib.build_filenamev([tmp, 'ops']);
    const at = (...parts: string[]) => GLib.build_filenamev([base, ...parts]);
    const exists = (path: string) => GLib.file_test(path, GLib.FileTest.EXISTS);
    GLib.mkdir_with_parents(base, 0o755);

    test('createFile menambahkan .md bila bukan ekstensi Markdown', () => {
        eq(createFile(base, 'catatan'), at('catatan.md'), 'path');
        eq(createFile(base, ' ide.markdown '), at('ide.markdown'), 'ekstensi markdown dipertahankan');
        ok(exists(at('catatan.md')), 'file tidak dibuat');
    });
    test('createFile menolak nama kosong, ber-slash, bertitik, dan yang sudah ada', () => {
        throws(() => createFile(base, '  '), 'kosong');
        throws(() => createFile(base, 'a/b'), '/');
        throws(() => createFile(base, '.rahasia'), 'titik');
        throws(() => createFile(base, 'catatan.md'), 'sudah ada');
    });
    test('createFolder membuat folder dan menolak duplikat', () => {
        eq(createFolder(base, 'bab'), at('bab'), 'path');
        ok(GLib.file_test(at('bab'), GLib.FileTest.IS_DIR), 'bukan folder');
        throws(() => createFolder(base, 'bab'), 'sudah ada');
    });
    test('moveEntry memindahkan file ke dalam folder dan kembali keluar', () => {
        eq(moveEntry(at('catatan.md'), at('bab')), at('bab', 'catatan.md'), 'ke dalam');
        ok(!exists(at('catatan.md')) && exists(at('bab', 'catatan.md')), 'file tidak berpindah');
        eq(moveEntry(at('bab', 'catatan.md'), base), at('catatan.md'), 'keluar');
    });
    test('moveEntry memindahkan folder berisi ke folder lain', () => {
        createFolder(base, 'tujuan');
        createFile(at('bab'), 'isi');
        eq(moveEntry(at('bab'), at('tujuan')), at('tujuan', 'bab'), 'path');
        ok(exists(at('tujuan', 'bab', 'isi.md')), 'isi folder ikut pindah');
    });
    test('moveEntry: tanpa perubahan, ke diri sendiri, dan bentrok nama', () => {
        eq(moveEntry(at('catatan.md'), base), null, 'folder yang sama');
        throws(() => moveEntry(at('tujuan'), at('tujuan', 'bab')), 'dirinya sendiri');
        throws(() => moveEntry(at('tujuan'), at('tujuan')), 'dirinya sendiri');
        createFile(at('tujuan'), 'catatan');
        throws(() => moveEntry(at('catatan.md'), at('tujuan')), 'sudah ada');
        ok(exists(at('catatan.md')), 'sumber tidak boleh hilang');
    });
    test('renameEntry mengganti nama file (tetap .md) dan folder, menolak bentrok', () => {
        createFile(base, 'r1'); createFile(base, 'r2'); createFolder(base, 'rd');
        eq(renameEntry(at('r1.md'), 'r3'), at('r3.md'), 'file');
        eq(renameEntry(at('rd'), 'rd2'), at('rd2'), 'folder tanpa ekstensi');
        eq(renameEntry(at('r3.md'), 'r3.md'), null, 'nama sama');
        throws(() => renameEntry(at('r3.md'), 'r2'), 'sudah ada');
        throws(() => renameEntry(at('r3.md'), 'a/b'), '/');
    });
    test('remapPath mengikuti pemindahan file dan folder', () => {
        eq(remapPath('/a/b.md', '/a/b.md', '/c/b.md'), '/c/b.md', 'file');
        eq(remapPath('/a/d/x.md', '/a/d', '/c/d'), '/c/d/x.md', 'isi folder');
        eq(remapPath('/a/dd/x.md', '/a/d', '/c/d'), null, 'awalan nama saja bukan induk');
    });
}
