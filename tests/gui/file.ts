// Tes GUI: File.

import GLib from 'gi://GLib';
import { section, test, eq, ok, tmp } from '../framework.js';
import type { GuiContext } from './context.js';

export function fileTests(c: GuiContext): void {
    const { w, buf, text, setText } = c;

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
}
