// Tes konversi Markdown → HTML.

import { section, test, eq, contains } from '../framework.js';
import { markdownToHtml } from '../../src/markdown/html.js';
import { body } from './helpers.js';

export function htmlTests(): void {
    section('Markdown → HTML');
    test('heading dengan id', () => contains(body('## Halo Dunia'), '<h2 id="halo-dunia">Halo Dunia</h2>'));
    test('format inline', () => eq(body('**a** *b* `c` ~~d~~ ==e=='),
        '<p><strong>a</strong> <em>b</em> <code>c</code> <del>d</del> <mark>e</mark></p>'));
    test('tautan dan gambar', () => {
        const h = body('[GTK](https://gtk.org/a_b) ![logo](img/x.png)');
        contains(h, '<a href="https://gtk.org/a_b">GTK</a>');
        contains(h, '<img src="img/x.png" alt="logo">');
    });
    test('HTML di blok kode di-escape', () => eq(body('```html\n<b>&</b>\n```'),
        '<pre><code class="language-html">&lt;b&gt;&amp;&lt;/b&gt;</code></pre>'));
    test('blok mermaid menjadi <pre class="mermaid"> dan memuat skrip Mermaid', () => {
        const h = markdownToHtml('```mermaid\ngraph TD\n  A-->B\n```', 't');
        contains(h, '<pre class="mermaid">graph TD\n  A--&gt;B</pre>');
        contains(h, 'mermaid.esm.min.mjs');
    });
    test('blok dbml menjadi diagram ER Mermaid; dbml yang salah tetap blok kode', () => {
        const h = markdownToHtml('```dbml\nTable a { id int [pk] }\n```', 't');
        contains(h, '<pre class="mermaid">erDiagram');
        contains(h, 'mermaid.esm.min.mjs');
        contains(body('```dbml\nTable a {\n```'), '<pre><code class="language-dbml">');
    });
    test('dokumen tanpa mermaid tidak memuat skrip Mermaid', () => {
        eq(markdownToHtml('```js\nx\n```', 't').includes('mermaid.esm'), false, 'skrip termuat');
    });
    test('tabel', () => {
        const h = body('| A | B |\n|:--|--:|\n| 1 | 2 |');
        contains(h, '<th style="text-align:left">A</th>');
        contains(h, '<td style="text-align:right">2</td>');
    });
    test('daftar tugas', () => {
        const h = body('- [x] selesai\n- [ ] belum');
        contains(h, '<input type="checkbox" disabled checked> selesai');
        contains(h, '<input type="checkbox" disabled> belum');
    });
    test('daftar bersarang', () => contains(body('1. a\n   - b\n2. c'), '<li>a\n<ul>\n<li>b</li>\n</ul></li>'));
    test('daftar bernomor mulai dari 3', () => contains(body('3. a\n4. b'), '<ol start="3">'));
    test('kutipan', () => eq(body('> halo\n> *dunia*'), '<blockquote>\n<p>halo\n<em>dunia</em></p>\n</blockquote>'));
    test('garis pemisah', () => eq(body('a\n\n---\n\nb'), '<p>a</p>\n<hr>\n<p>b</p>'));
    test('karakter HTML di teks di-escape', () => eq(body('a < b & "c"'), '<p>a &lt; b &amp; &quot;c&quot;</p>'));
    test('escape backslash', () => eq(body('\\*bukan miring\\*'), '<p>*bukan miring*</p>'));
    test('backtick yang di-escape bukan kode', () => eq(body('\\`bukan kode\\`'), '<p>`bukan kode`</p>'));
    test('backslash di dalam kode tetap apa adanya', () => eq(body('`C:\\*`'), '<p><code>C:\\*</code></p>'));
    test('tabel tanpa pipa di tepi', () => {
        const h = body('Nama | Nilai\n--- | ---\nSatu | 1');
        contains(h, '<th>Nama</th><th>Nilai</th>');
        contains(h, '<td>Satu</td><td>1</td>');
    });
    test('"---" di bawah teks berpipa tetap garis pemisah, bukan tabel', () =>
        eq(body('a | b\n\n---'), '<p>a | b</p>\n<hr>'));
}
