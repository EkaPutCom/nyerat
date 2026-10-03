// Tes GUI: Warna blok kode.

import { section, test, eq, ok } from '../framework.js';
import type { GuiContext } from './context.js';

export function codeColorTests(c: GuiContext): void {
    const { ed, buf, pump, text, setText, cursorTo, offsetIn, tagAt, action } = c;

    section('Warna blok kode');
    const syntaxTags = (off: number) => buf.get_iter_at_offset(off).get_tags().filter(t => t.name?.startsWith('syntax:'));
    const colorAt = (off: number) => syntaxTags(off).map(t => t.foreground_rgba?.to_string()).find(Boolean) ?? null;
    test('kata kunci, string, dan komentar diwarnai berbeda', () => {
        setText('teks\n\n```js\nconst s = "halo"; // catatan\n```\n');
        const at = (needle: string) => offsetIn(text(), needle);
        ok(syntaxTags(at('const')).length > 0, 'kata kunci tidak diwarnai');
        const str = colorAt(at('"halo"') + 1), comment = colorAt(at('// catatan') + 3);
        ok(str && comment && str !== comment, `warna string (${str}) dan komentar (${comment}) harus berbeda`);
        ok(syntaxTags(at('teks')).length === 0, 'teks di luar blok ikut diwarnai');
    });
    test('isi dokumen tidak berubah karena pewarnaan', () => {
        eq(text(), 'teks\n\n```js\nconst s = "halo"; // catatan\n```\n');
    });
    test('blok tanpa bahasa atau bahasa tak dikenal tidak diwarnai', () => {
        setText('```\nconst a = 1;\n```\n\n```ngarang\nconst b = 2;\n```');
        ok(syntaxTags(offsetIn(text(), 'const a')).length === 0, 'blok tanpa bahasa diwarnai');
        ok(syntaxTags(offsetIn(text(), 'const b')).length === 0, 'blok bahasa tak dikenal diwarnai');
    });
    test('mengetik di dalam blok mewarnai ulang', () => {
        setText('```python\nx = 1\n```');
        ok(syntaxTags(offsetIn(text(), 'x')).length === 0, 'awal: "x" tidak bergaya');
        cursorTo(1);
        buf.insert_at_cursor('def ', -1);
        pump();
        ok(syntaxTags(offsetIn(text(), 'def')).length > 0, '"def" tidak diwarnai setelah diketik');
    });
    test('emoji sebelum blok tidak menggeser warna', () => {
        setText('🎉🎉\n```js\nreturn 1;\n```');
        const off = offsetIn(text(), 'return');
        ok(syntaxTags(off).length > 0 && syntaxTags(off + 5).length > 0, '"return" tidak diwarnai utuh');
        ok(syntaxTags(off - 1).length === 0, 'warna bergeser ke sebelum "return"');
    });
    test('cache warna tetap benar setelah blok bergeser dan dokumen dimuat ulang', () => {
        const doc = 'awal\n\n```js\nconst s = "halo";\n```';
        setText(doc);
        buf.insert(buf.get_start_iter(), '😀 tambahan\n', -1); pump();
        ok(syntaxTags(offsetIn(text(), 'const')).length > 0, 'warna hilang setelah blok bergeser');
        ok(syntaxTags(0).length === 0, 'teks tambahan ikut diwarnai');
        setText(doc);
        ok(syntaxTags(offsetIn(text(), 'const')).length > 0, 'warna hilang setelah setText');
        cursorTo(3);
        buf.insert_at_cursor('/*', -1); pump();
        ok(colorAt(offsetIn(text(), 'halo')) !== null, 'warna komentar hilang');
        buf.undo(); pump();
        ok(syntaxTags(offsetIn(text(), 'const')).length > 0, 'undo tidak memulihkan warna');
    });
    test('mode gelap memakai skema warna lain', () => {
        setText('```js\nconst s = "halo";\n```');
        const off = offsetIn(text(), '"halo"') + 1;
        const light = colorAt(off);
        action('dark');
        const dark = colorAt(off);
        action('dark');
        ok(light && dark && light !== dark, `warna terang (${light}) dan gelap (${dark}) sama`);
        eq(colorAt(off), light, 'kembali ke warna terang');
    });
    test('mode fokus tetap meredupkan blok kode di paragraf lain', () => {
        setText('paragraf\n\n```js\nconst s = 1;\n```');
        cursorTo(0);
        action('focus');
        // dim dan hidden harus di atas semua tag warna kode, supaya warnanya menang.
        const maxSyntax = Math.max(...syntaxTags(offsetIn(text(), 'const')).map(t => t.get_priority()));
        ok(ed.tags.dim.get_priority() > maxSyntax && ed.tags.hidden.get_priority() > maxSyntax,
            `prioritas dim/hidden (${ed.tags.dim.get_priority()}/${ed.tags.hidden.get_priority()}) tidak di atas warna kode (${maxSyntax})`);
        ok(tagAt(offsetIn(text(), 'const'), 'dim'), 'blok kode tidak diredupkan');
        action('focus');
    });
}
