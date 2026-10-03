// Tes GUI: Dokumen contoh semua format (tests/samples/semua-format.md).

import { type TagName } from '../../src/editor/tags.js';
import { readTextFile } from '../../src/files.js';
import { markdownToHtml } from '../../src/markdown/html.js';
import { section, test, eq, ok, contains } from '../framework.js';
import type { GuiContext } from './context.js';

export function sampleTests(c: GuiContext): void {
    const { w, ed, buf, pump, text, cursorTo, tagAt, samplePath } = c;

    section('Dokumen contoh semua format (tests/samples/semua-format.md)');
    const offsetOf = (needle: string) => {
        const t = text(), i = t.indexOf(needle);
        ok(i >= 0, `teks ${JSON.stringify(needle)} tidak ditemukan`);
        return Array.from(t.slice(0, i)).length;
    };
    test('file dibuka dan semua heading masuk outline', () => {
        ok(w.load(samplePath), 'load() gagal');
        pump();
        const names = ed.headings.map(h => h.text);
        for (const h of ['Uji Semua Format Markdown', 'Heading 6', 'Heading dengan tanda penutup', '15. Kasus sulit'])
            ok(names.includes(h), `heading "${h}" tidak ada`);
        ok(!names.some(n => n.includes('Tujuh pagar') || n.includes('Tanpa spasi')), 'teks yang bukan heading masuk outline');
    });
    test('format inline mendapat tag yang benar', () => {
        cursorTo(0);
        const cases: [string, TagName][] = [['tebal dengan bintang', 'bold'], ['miring dengan garis bawah', 'italic'], ['tebal miring*', 'bolditalic'],
            ['dicoret', 'strike'], ['distabilo', 'mark'], ['gjs -m nyerat.js', 'code'], ['GTK](', 'link'], ['Logo GTK', 'image']];
        for (const [needle, tag] of cases) ok(tagAt(offsetOf(needle) + 1, tag), `"${needle}" tidak bertag ${tag}`);
    });
    test('kasus sulit tidak salah format', () => {
        ok(!tagAt(offsetOf('case_seperti') + 2, 'italic'), 'snake_case jadi miring');
        ok(!tagAt(offsetOf('3 * 4') , 'italic'), '"2 * 3 * 4" jadi miring');
        ok(!tagAt(offsetOf('bukan kode\\`') + 1, 'code'), 'backtick yang di-escape jadi kode');
        ok(!tagAt(offsetOf('**bukan tebal**`') + 3, 'bold'), 'isi kode inline jadi tebal');
        ok(!tagAt(offsetOf('nama_file_ini') + 6, 'italic'), 'URL dengan garis bawah jadi miring');
    });
    test('tabel dengan dan tanpa pipa di tepi dikenali', () => {
        ok(tagAt(offsetOf('| Kiri') + 2, 'tablehead'), 'judul tabel berpipa');
        ok(tagAt(offsetOf('Satu | 1'), 'table'), 'baris tabel tanpa pipa di tepi');
        ok(tagAt(offsetOf('Nama | Nilai'), 'tablehead'), 'judul tabel tanpa pipa di tepi');
    });
    test('blok kode 4 backtick memuat ``` di dalamnya', () => {
        const inner = offsetOf('kode\n```\n````') ;
        ok(tagAt(inner, 'codeblock'), 'isi blok tidak bertag codeblock');
        ok(tagAt(offsetOf('Tingkat tiga'), 'quote'), 'kutipan bersarang tidak bertag quote');
    });
    test('kursor menyapu seluruh dokumen contoh', () => {
        const n = buf.get_line_count();
        for (let i = 0; i < n; i++) { cursorTo(i); cursorTo(i, -1); }
    });
    test('ekspor HTML dokumen contoh lengkap', () => {
        const h = markdownToHtml(readTextFile(samplePath), 't');
        for (const tag of ['<h6', '<strong><em>', '<del>', '<mark>', '<code>', '<a href=', '<img ', '<ol start="7">',
            'type="checkbox"', '<blockquote>\n<p>Tingkat dua', '<pre><code class="language-bash">', '<pre class="mermaid">', '<table>', '<hr>', '<br>'])
            contains(h, tag);
        eq((h.match(/<table>/g) || []).length, 3, 'jumlah tabel');
        contains(h, '>a | b</td>');  // \\| di dalam sel menjadi |
    });
    buf.set_modified(false);
}
