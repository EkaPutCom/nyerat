// Tes GUI: Menyembunyikan sintaks.

import { section, test, eq, ok } from '../framework.js';
import type { GuiContext } from './context.js';
import { listRows } from '../widgets.js';

export function syntaxHidingTests(c: GuiContext): void {
    const { w, ed, setText, cursorTo, hidden, tagAt, action } = c;

    section('Menyembunyikan sintaks');
    test('marker heading tersembunyi saat kursor di baris lain', () => {
        setText('# Judul\n\nteks **tebal** di sini');
        cursorTo(2, -1);
        ok(hidden(0), '"#" seharusnya tersembunyi');
        ok(!hidden(17), '"**" di baris aktif seharusnya terlihat');
    });
    test('marker muncul saat kursor pindah ke barisnya', () => {
        cursorTo(0);
        ok(!hidden(0), '"#" seharusnya terlihat');
        ok(hidden(14), '"**" di baris lain seharusnya tersembunyi');
        ok(tagAt(16, 'bold'), 'teks tebal tidak diberi tag bold');
    });
    test('offset benar setelah emoji', () => {
        setText('🎉 **a**\n');
        cursorTo(1);
        ok(hidden(2) && hidden(3), '"**" setelah emoji seharusnya tersembunyi');
        ok(!hidden(4) && tagAt(4, 'bold'), 'huruf "a" seharusnya tebal dan terlihat');
    });
    test('baris pembatas blok kode tersembunyi di luar blok', () => {
        setText('a\n```js\nkode\n```\nb');
        cursorTo(0);
        ok(hidden(2) && hidden(13), 'pembatas ``` seharusnya tersembunyi');
        ok(tagAt(9, 'codeblock') && !hidden(9), 'isi kode seharusnya terlihat');
    });
    test('baris pembatas muncul saat kursor di dalam blok', () => {
        cursorTo(2);
        ok(!hidden(2) && !hidden(13), 'pembatas ``` seharusnya terlihat');
    });
    test('mode source menampilkan semua marker', () => {
        setText('# a\n\n**b**');
        cursorTo(2);
        ok(hidden(0), 'awal: "#" tersembunyi');
        action('source');
        ok(!hidden(0), 'mode source: "#" seharusnya terlihat');
        action('source');
        ok(hidden(0), 'setelah mode source dimatikan: "#" tersembunyi lagi');
    });
    test('outline berisi heading', () => {
        setText('# Satu\n## Dua\nteks\n### Tiga');
        eq(ed.headings.map(h => [h.level, h.text, h.line]), [[1, 'Satu', 0], [2, 'Dua', 1], [3, 'Tiga', 3]]);
        eq(listRows(w.outline.list).length, 3, 'jumlah baris outline');
    });
}
