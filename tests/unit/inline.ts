// Tes parseInline.

import { makeCpMap, cpLength, countWords } from '../../src/editor/offsets.js';
import { parseInline } from '../../src/markdown/inline.js';
import { section, test, eq, ok } from '../framework.js';

export function inlineTests(): void {
    section('parseInline');
    test('tebal menghasilkan tag dan marker', () => {
        const r = parseInline('a **b** c');
        ok(r.tags.some(([n, s, e]) => n === 'bold' && s === 4 && e === 5), JSON.stringify(r.tags));
        eq(r.marks, [[2, 4], [5, 7]], 'marker');
    });
    test('backtick yang di-escape tidak jadi kode', () => {
        const r = parseInline('\\`a\\`');
        ok(!r.tags.some(([n]) => n === 'code'), JSON.stringify(r.tags));
        eq(r.marks, [[0, 1], [3, 4]], 'marker backslash');
    });
    test('isi kode inline tidak diformat', () => {
        const r = parseInline('`**x**`');
        ok(!r.tags.some(([n]) => n === 'bold'), 'bold di dalam kode');
        ok(r.tags.some(([n]) => n === 'code'), 'tag code tidak ada');
    });
    test('gambar dikumpulkan beserta url tanpa judul', () => {
        const r = parseInline('a ![x y](img/a.png "Judul") b ![](c.jpg)');
        eq(r.images.map(i => [i.alt, i.url, i.start, i.end]), [['x y', 'img/a.png', 2, 27], ['', 'c.jpg', 30, 40]]);
    });
    test('underscore di URL tautan tidak jadi miring', () => {
        const r = parseInline('[x](http://a.com/a_b_c)');
        ok(!r.tags.some(([n]) => n === 'italic'), JSON.stringify(r.tags));
    });
    test('snake_case tidak jadi miring', () => {
        ok(!parseInline('nama_variabel_ini').tags.some(([n]) => n === 'italic'), 'jadi miring');
    });
    test('masking bertahap menjaga kode, tautan, dan penekanan yang bercampur', () => {
        const r = parseInline('`**kode**` [**judul**](https://a_b.test) <https://c_d.test> https://e_f.test **tebal** *miring* ~~hapus~~ ==sorot==');
        const count = (name: string) => r.tags.filter(([n]) => n === name).length;
        eq([count('code'), count('link'), count('bold'), count('italic'), count('strike'), count('mark')], [1, 3, 2, 1, 1, 1]);
        ok(!r.tags.some(([n, a, b]) => n === 'bold' && a < 10 && b < 10), 'isi kode ikut tebal');
    });
    test('baris panjang tanpa sintaks dan hitungan Unicode tetap benar', () => {
        eq(parseInline('catatan biasa '.repeat(10000)), { tags: [], marks: [], images: [] });
        eq(cpLength('abc🎉é'), 6, 'jumlah code point');
        eq(cpLength('x'.repeat(10000)), 10000, 'teks tanpa surrogate');
    });
    test('makeCpMap menghitung emoji sebagai satu karakter', () => {
        const map = makeCpMap('🎉ab');
        eq([map(0), map(2), map(3), map(4)], [0, 1, 2, 3]);
    });
    test('countWords sama dengan regex pemisah kata', () => {
        const words = (s: string) => (s.match(/[^\s#>*_`~=|-]+/g) ?? []).length;
        const pieces = ['kata', ' ', '\t', '\n', '\u00a0', '\u2003', '\u3000', '\ufeff', '\u2028', '#', '>', '*', '_', '`', '~', '=', '|', '-', 'é', '🎉', '“', '1.', '[x]'];
        let seed = 7;
        const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
        for (let n = 0; n < 500; n++) {
            const s = Array.from({ length: Math.floor(random() * 30) }, () => pieces[Math.floor(random() * pieces.length)]).join('');
            eq(countWords(s), words(s), JSON.stringify(s));
        }
        eq(countWords(''), 0, 'string kosong');
    });
}
