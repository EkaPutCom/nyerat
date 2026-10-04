// Tes GUI: File.

import GLib from 'gi://GLib';
import { section, test, eq, ok, tmp } from '../framework.js';
import { readTextFile } from '../../src/files.js';
import type { GuiContext } from './context.js';

export function fileTests(c: GuiContext): void {
    const { w, buf, text, setText, pump } = c;

    section('File');
    test('simpan lalu buka lagi menghasilkan isi yang sama', () => {
        const path = GLib.build_filenamev([tmp, 'uji.md']);
        const content = '# Uji 🎉\n\nÄÖÜ — ✓\n';
        setText(content);
        w.file = path;
        ok(w.save(), 'save() gagal');
        ok(!buf.get_modified(), 'status modified tidak direset');
        setText('');
        ok(w.load(path), 'load() gagal');
        eq(text(), content);
    });

    test('auto save menulis file setelah jeda mengetik', () => {
        const path = GLib.build_filenamev([tmp, 'otomatis.md']);
        setText('');
        w.file = path;
        ok(w.save(), 'save() gagal');
        w.setOption('autosave', true);
        buf.insert_at_cursor('# Halo', -1);
        pump();
        eq(readTextFile(path), '', 'belum ditulis sebelum jeda');
        ok(buf.get_modified(), 'masih ditandai berubah');
        for (let i = 0; i < 150 && buf.get_modified(); i++) { pump(); GLib.usleep(10000); }
        eq(readTextFile(path), '# Halo', 'isi file');
        ok(!buf.get_modified(), 'status modified direset');
    });

    test('auto save latar: suntingan selama menulis tetap ditandai berubah', () => {
        const path = GLib.build_filenamev([tmp, 'otomatis.md']);
        let finished = false;
        ok(w.autosaveInBackground(undefined, () => { finished = true; }) === false, 'tidak ada perubahan, tidak menulis');
        buf.insert_at_cursor(' A', -1);
        pump();
        ok(w.autosaveInBackground(undefined, () => { finished = true; }), 'penulisan latar tidak dimulai');
        buf.insert_at_cursor('B', -1);   // diketik sebelum penulisan selesai
        for (let i = 0; i < 500 && !finished; i++) { pump(); GLib.usleep(2000); }
        ok(finished, 'penulisan latar tidak selesai');
        eq(readTextFile(path), '# Halo A', 'isi yang ditulis adalah salinan saat dimulai');
        ok(buf.get_modified(), 'B belum tersimpan, tetapi status modified direset');
    });

    test('simpan langsung setelah auto save latar tidak tertimpa isi lama', () => {
        const path = GLib.build_filenamev([tmp, 'otomatis.md']);
        ok(w.autosaveInBackground(), 'penulisan latar tidak dimulai');
        buf.insert_at_cursor('C', -1);
        ok(w.save(), 'save() gagal');   // menunggu penulisan latar, lalu menulis isi terbaru
        for (let i = 0; i < 20; i++) { pump(); GLib.usleep(2000); }
        eq(readTextFile(path), '# Halo ABC', 'isi file');
        ok(!buf.get_modified(), 'status modified');
        buf.delete(buf.get_iter_at_offset(6), buf.get_end_iter());
        ok(w.save(), 'save() gagal');
    });

    test('auto save menyimpan tanpa bertanya saat berpindah dokumen', () => {
        const path = GLib.build_filenamev([tmp, 'otomatis.md']);
        buf.insert_at_cursor('!', -1);
        pump();
        // Tanpa auto save, menutup dokumen membuka dialog dan tes akan macet. Berpindah tab
        // adalah titik aman: dokumen yang ditinggalkan langsung disimpan.
        w.newDocument();
        eq(readTextFile(path), '# Halo!', 'isi file');
        eq(w.file, null, 'dokumen baru');
        eq(w.documentCount, 2, 'dokumen baru dibuka di tab baru');
        ok(w.closeTab(), 'closeTab() gagal');
        ok(w.editor === c.ed, 'editor semula tidak aktif lagi');
        w.file = null;
    });

    test('auto save tidak menyentuh dokumen tanpa file', () => {
        buf.insert_at_cursor('x', -1);
        pump();
        ok(!w.autosave(), 'autosave() melaporkan tersimpan');
        ok(buf.get_modified(), 'status modified direset');
        w.setOption('autosave', false);
        setText('');
    });
}
