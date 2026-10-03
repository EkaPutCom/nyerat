// Tes otomatis Nyerat. Dibundel Vite menjadi dist/run-tests.js.
//
//   npm test                                         build, lalu semua tes
//   gjs -m dist/run-tests.js --no-gui                hanya tes konversi Markdown → HTML
//   gjs -m dist/run-tests.js --mouse                 tambah klik mouse sungguhan (pointer akan bergerak)
//   gjs -m dist/run-tests.js --screenshot=a.png      simpan tangkapan layar jendela editor
//
// Tes GUI membuka jendela sungguhan, jadi perlu sesi desktop (X11/Wayland).

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=3.0';
import Gdk from 'gi://Gdk?version=3.0';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import System from 'system';

import { parseInline } from '../src/markdown/inline.js';
import { markdownToHtml } from '../src/markdown/html.js';
import { makeCpMap } from '../src/editor/offsets.js';
import { DEFAULTS, loadSettings, saveSettings } from '../src/settings.js';
import { WELCOME } from '../src/welcome.js';
import { readTextFile } from '../src/files.js';
import { MainWindow, type Option } from '../src/window.js';
import { listFolder } from '../src/ui/filetree.js';
import { resolveLanguage } from '../src/editor/codehighlight.js';
import {
    cellIndexAt, cellStart, deleteColumn, deleteRow, displayWidth, findTables, insertColumn, insertRow,
    parseTable, renderTable, setAlign, splitRow, tableEnd,
} from '../src/markdown/table.js';
import { cellMarkup } from '../src/markdown/pango.js';
import {
    addCard, addColumn, cardMeta, countCards, deleteCard, deleteColumn as deleteList, dropIndex, dueStatus, isKanban, moveCard,
    moveColumn, newBoard, parseBoard, renameColumn, serializeBoard, toggleDone, updateCard, type Board,
} from '../src/markdown/kanban.js';
import { fitColumns } from '../src/editor/tablelayer.js';
import { KanbanBoard } from '../src/ui/kanban.js';
import { ImageViewer, MAX_ZOOM, MIN_ZOOM, clampZoom, fitZoom } from '../src/ui/imageviewer.js';
import type { TagName } from '../src/editor/tags.js';

const argv = System.programArgs;
const opt = (name: string) => argv.includes(`--${name}`);
const optVal = (name: string) => argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

// Folder proyek. File ini berada di tests/ (sumber) atau dist/ (hasil build),
// jadi folder proyek adalah induk dari foldernya.
const ROOT = GLib.path_get_dirname(GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]));

// Pengaturan dan file tes ditaruh di folder sementara, bukan ~/.config. Aman di-set
// setelah import karena settings.ts baru membaca XDG_CONFIG_HOME saat dipanggil.
const tmp = GLib.dir_make_tmp('nyerat-test-XXXXXX');
GLib.setenv('XDG_CONFIG_HOME', tmp, true);

const errorMessage = (e: unknown): string => e instanceof Error ? e.message : String(e);

// ───────────────────────── Mini framework ─────────────────────────

let passed = 0, failed = 0;
const RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

function section(name: string): void { print(`\n${name}`); }

function test(name: string, fn: () => void): void {
    try {
        fn();
        passed++;
        print(`  ${GREEN}✓${RESET} ${name}`);
    } catch (e) {
        failed++;
        print(`  ${RED}✗ ${name}${RESET}\n    ${errorMessage(e).split('\n').join('\n    ')}`);
    }
}

function eq(actual: unknown, expected: unknown, what = 'nilai'): void {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${what} salah\n    dapat:    ${a}\n    harapan:  ${b}`);
}

function ok(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

function contains(haystack: string, needle: string): void {
    if (!haystack.includes(needle)) throw new Error(`tidak mengandung ${JSON.stringify(needle)}\n    dalam: ${JSON.stringify(haystack.slice(0, 300))}`);
}

// ───────────────────────── Tes konversi (tanpa GUI) ─────────────────────────

const body = (md: string) => markdownToHtml(md, 't').split('<body>\n')[1].split('\n</body>')[0];

// Papan kanban baku untuk tes model dan tes GUI.
const BOARD = [
    '---', 'kanban: true', '---', '',
    '## Rencana', '',
    '- [ ] Tulis laporan #penting @{2026-10-20}', '  catatan satu', '', '  catatan dua',
    '- [ ] Kirim undangan', '',
    '## Dikerjakan', '', '**Aktif**', '', '- [ ] Desain logo', '',
    '## Selesai', '', '- [x] Pesan tempat', '- Item biasa', '', '***', '',
    '%% kanban:settings', '```', '{"kanban":true}', '```', '%%', '',
].join('\n');

function runUnitTests() {
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
    test('makeCpMap menghitung emoji sebagai satu karakter', () => {
        const map = makeCpMap('🎉ab');
        eq([map(0), map(2), map(3), map(4)], [0, 1, 2, 3]);
    });

    section('Pengaturan');
    test('pengaturan disimpan lalu dibaca kembali', () => {
        eq(loadSettings().focus, false, 'nilai bawaan');
        saveSettings({ ...DEFAULTS, focus: true });
        ok(GLib.file_test(GLib.build_filenamev([tmp, 'nyerat', 'settings.json']), GLib.FileTest.EXISTS), 'file tidak dibuat');
        eq(loadSettings().focus, true, 'nilai tersimpan');
    });

    section('Tabel Markdown');
    const spans = (line: string) => splitRow(line).map(c => [c.text, c.start, c.end]);
    test('splitRow: pipa di tepi, tanpa pipa di tepi, sel kosong, \\|', () => {
        eq(spans('| a | b |'), [['a', 2, 3], ['b', 6, 7]], 'dengan pipa di tepi');
        eq(spans('a | b'), [['a', 0, 1], ['b', 4, 5]], 'tanpa pipa di tepi');
        eq(spans('|  | x |'), [['', 2, 2], ['x', 5, 6]], 'sel kosong');
        eq(spans('| a \\| b | c |').map(c => c[0]), ['a \\| b', 'c'], 'pipa yang di-escape bukan pemisah');
        eq(splitRow('| satu |').length, 1, 'satu sel');
    });
    test('cellIndexAt dan cellStart', () => {
        const line = '| aa | bb | cc |';
        eq([cellIndexAt(line, 2), cellIndexAt(line, 7), cellIndexAt(line, 12)], [0, 1, 2], 'kolom di posisi');
        eq([cellStart(line, 0), cellStart(line, 2), cellStart(line, 9)], [2, 12, line.length], 'awal sel; di luar jangkauan = akhir baris');
    });
    test('parseTable: perataan, sel kurang dan berlebih', () => {
        const t = parseTable(['| a | b | c | d |', '| :--- | :-: | ---: | --- |', '| 1 |', '| 1 | 2 | 3 | 4 | 5 |']);
        eq(t.aligns, ['left', 'center', 'right', null], 'perataan');
        eq(t.rows, [['1', '', '', ''], ['1', '2', '3', '4']], 'baris dilengkapi/dipotong sebanyak judul');
    });
    test('displayWidth: CJK dan emoji dua kolom, tanda gabung nol', () => {
        eq([displayWidth('abc'), displayWidth('日本'), displayWidth('🎉'), displayWidth('e\u0301')], [3, 4, 2, 1]);
    });
    test('renderTable merapikan kolom sesuai perataan', () => {
        const t = parseTable(['| Nama | N |', '| :-- | --: |', '| satu | 1 |', '| tiga puluh | 30 |']);
        eq(renderTable(t), [
            '| Nama       |   N |',
            '| :--------- | --: |',
            '| satu       |   1 |',
            '| tiga puluh |  30 |',
        ]);
    });
    test('renderTable: lebar CJK dihitung dua kolom', () => {
        const lines = renderTable(parseTable(['| a | b |', '| --- | --- |', '| 日本 | x |']));
        eq(lines, ['| a    | b   |', '| ---- | --- |', '| 日本 | x   |']);
    });
    test('renderTable lalu parseTable mengembalikan tabel yang sama', () => {
        const t = parseTable(['| a | b |', '| :-: | --: |', '| 1 | 2 |']);
        eq(parseTable(renderTable(t)), t);
    });
    test('operasi baris dan kolom tidak mengubah tabel asal', () => {
        const t = parseTable(['| a | b |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |']);
        const before = JSON.stringify(t);
        eq(insertRow(t, 1).rows, [['1', '2'], ['', ''], ['3', '4']], 'sisip baris');
        eq(deleteRow(t, 0).rows, [['3', '4']], 'hapus baris');
        eq(insertColumn(t, 1).header, ['a', '', 'b'], 'sisip kolom');
        eq(insertColumn(t, 1).rows[0], ['1', '', '2'], 'sisip kolom di baris isi');
        eq(deleteColumn(t, 0).header, ['b'], 'hapus kolom');
        eq(setAlign(t, 1, 'right').aligns, [null, 'right'], 'perataan');
        eq(JSON.stringify(t), before, 'tabel asal');
    });
    test('kolom terakhir tidak bisa dihapus', () => {
        const t = parseTable(['| a |', '| --- |', '| 1 |']);
        eq(deleteColumn(t, 0), t);
    });
    test('findTables: beberapa tabel, melewati blok kode, berhenti di blok lain', () => {
        const lines = [
            '| a | b |', '| - | - |', '| 1 | 2 |', '',            // 0–2
            '```', '| x | y |', '| - | - |', '```',               // dalam blok kode: bukan tabel
            'p | q', '--- | ---', 'r | s', '# Judul', 'bukan baris', // 8–10; heading menghentikan tabel
            '| m |', '| - |', '> kutipan',                         // 13–14; kutipan menghentikan tabel
        ];
        eq(findTables(lines), [{ start: 0, end: 2 }, { start: 8, end: 10 }, { start: 13, end: 14 }]);
        eq(tableEnd(['| a |', '| - |', '| 1 |', 'tanpa pipa'], 0), 2, 'baris tanpa pipa mengakhiri tabel');
    });
    test('cellMarkup: format inline, escape markup, \\| menjadi |', () => {
        const colors = { code: '#c00', codeBg: '#eee', link: '#00c', mark: '#ff0' };
        eq(cellMarkup('**tebal** & <b>', colors), '<span font_weight="bold">tebal</span> &amp; &lt;b&gt;');
        eq(cellMarkup('[tautan](http://x.y)', colors), '<span foreground="#00c" underline="single">tautan</span>');
        eq(cellMarkup('`k`', colors), '<span font_family="monospace" foreground="#c00" background="#eee">k</span>');
        eq(cellMarkup('a \\| b', colors), 'a | b');
        eq(cellMarkup('***dua***', colors), '<span font_weight="bold" font_style="italic">dua</span>');
    });
    test('fitColumns: dibiarkan jika muat, dipersempit hanya kolom yang lebar', () => {
        eq(fitColumns([100, 80], 300), [100, 80], 'muat');
        eq(fitColumns([400, 50, 50], 300), [200, 50, 50], 'kolom lebar dipersempit, yang sempit dibiarkan');
        eq(fitColumns([400, 400], 300), [150, 150], 'dibagi rata');
        ok(fitColumns([1000, 1000, 1000], 90).every(w => w >= 56), 'tidak lebih kecil dari lebar minimum');
    });

    section('Kanban (model)');
    const titles = (b: Board) => b.columns.map(c => c.title);
    const cardsOf = (b: Board, col: number) => b.columns[col].cards.map(c => c.text);

    test('isKanban: hanya jika frontmatter memuat penanda papan', () => {
        eq([isKanban(BOARD), isKanban('# Biasa\n\nteks'), isKanban('---\njudul: a\n---\n\nteks'),
            isKanban('teks\n\nkanban: true'), isKanban('---\n\nteks\n\n---\nkanban: true')], [true, false, false, false, false]);
    });
    test('isKanban: kanban: true, kanban-plugin lama, dan nilai yang bukan penanda', () => {
        const doc = (line: string) => `---\n${line}\n---\n\n## A`;
        eq(['kanban: true', 'kanban: "true"', 'KANBAN: True', 'kanban-plugin: basic', 'kanban-plugin: board'].map(l => isKanban(doc(l))),
            [true, true, true, true, true], 'penanda yang dikenali');
        eq(['kanban: false', 'kanban: tidak', 'kanban:', 'kanban-plugin:', 'kanbans: true'].map(l => isKanban(doc(l))),
            [false, false, false, false, false], 'bukan penanda');
        eq(isKanban('---\njudul: x\nkanban: true\ntag: y\n---'), true, 'penanda di antara kunci frontmatter lain');
    });
    test('papan berpenanda lama (kanban-plugin) dipertahankan apa adanya saat ditulis', () => {
        const legacy = BOARD.replace('---\nkanban: true\n---', '---\n\nkanban-plugin: basic\n\n---');
        ok(legacy !== BOARD && legacy.includes('kanban-plugin: basic'), 'bahan uji');
        eq(serializeBoard(parseBoard(legacy)), legacy, 'frontmatter lama utuh');
        ok(isKanban(legacy), 'tetap dikenali');
    });
    test('parseBoard: daftar, kartu, catatan, intro, outro, dan footer', () => {
        const b = parseBoard(BOARD);
        eq(titles(b), ['Rencana', 'Dikerjakan', 'Selesai'], 'daftar');
        eq(b.head, ['---', 'kanban: true', '---'], 'head');
        eq(b.columns[0].cards[0], { done: false, text: 'Tulis laporan #penting @{2026-10-20}', notes: ['catatan satu', '', 'catatan dua'] }, 'kartu dengan catatan');
        eq(b.columns[1].intro, ['**Aktif**'], 'intro');
        eq(b.columns[2].cards.map(c => c.done), [true, null], 'selesai dan item biasa');
        eq(b.columns[2].outro, ['***'], 'outro');
        eq(b.footer.length, 5, 'footer dipertahankan');
    });
    test('serializeBoard(parseBoard(x)) = x untuk papan baku', () => eq(serializeBoard(parseBoard(BOARD)), BOARD));
    test('papan yang berantakan dirapikan dan hasilnya stabil', () => {
        const messy = '---\r\nkanban-plugin: board\r\n---\r\n# Judul papan\r\n\r\n\r\n##   A  \r\n* [X] satu\r\n    catatan empat spasi\r\n\r\n\r\n- dua\r\n## B\r\n';
        const once = serializeBoard(parseBoard(messy));
        eq(serializeBoard(parseBoard(once)), once, 'idempoten');
        const b = parseBoard(messy);
        eq([b.columns[0].title, b.columns[0].cards.map(c => c.done), b.columns[0].cards[0].notes, b.head[b.head.length - 1]],
            ['A', [true, null], ['  catatan empat spasi'], '# Judul papan']);
        eq(b.columns[1].cards, [], 'daftar kosong');
    });
    test('papan baru bisa ditulis dan dikenali lagi', () => {
        const text = serializeBoard(newBoard(['X', 'Y']));
        ok(text.startsWith('---\nkanban: true\n---\n\n## X\n'), 'penanda baru');
        ok(isKanban(text), 'tidak dikenali');
        eq(titles(parseBoard(text)), ['X', 'Y']);
    });
    test('addCard / updateCard / toggleDone / deleteCard', () => {
        let b = parseBoard(BOARD);
        b = addCard(b, 1, '  Kartu baru  ');
        eq(cardsOf(b, 1), ['Desain logo', 'Kartu baru'], 'tambah di bawah, teks dipangkas');
        b = addCard(b, 1, 'Pertama', 0);
        eq(cardsOf(b, 1)[0], 'Pertama', 'tambah di atas');
        eq(addCard(b, 1, '   '), b, 'kartu kosong ditolak');
        b = updateCard(b, { column: 1, index: 0 }, { text: 'Diubah', notes: ['isi'] });
        eq([b.columns[1].cards[0].text, b.columns[1].cards[0].notes], ['Diubah', ['isi']]);
        b = toggleDone(b, { column: 2, index: 1 });
        eq(b.columns[2].cards[1].done, true, 'item biasa jadi selesai');
        b = toggleDone(b, { column: 2, index: 1 });
        eq(b.columns[2].cards[1].done, false, 'lalu belum selesai');
        b = deleteCard(b, { column: 1, index: 0 });
        eq(cardsOf(b, 1), ['Desain logo', 'Kartu baru']);
    });
    test('moveCard: antar daftar dan di dalam daftar yang sama', () => {
        const b = parseBoard(BOARD);
        const across = moveCard(b, { column: 0, index: 0 }, { column: 2, index: 1 });
        eq([cardsOf(across, 0), cardsOf(across, 2)], [['Kirim undangan'], ['Pesan tempat', 'Tulis laporan #penting @{2026-10-20}', 'Item biasa']], 'antar daftar');
        eq(across.columns[2].cards[1].notes, ['catatan satu', '', 'catatan dua'], 'catatan ikut pindah');
        const down = moveCard(b, { column: 0, index: 0 }, { column: 0, index: 1 });
        eq(cardsOf(down, 0), ['Kirim undangan', 'Tulis laporan #penting @{2026-10-20}'], 'ke bawah: index = posisi akhir');
        eq(cardsOf(moveCard(down, { column: 0, index: 1 }, { column: 0, index: 0 }), 0), cardsOf(b, 0), 'kembali ke atas');
        eq(moveCard(b, { column: 0, index: 9 }, { column: 1, index: 0 }), b, 'kartu yang tidak ada');
        eq(cardsOf(moveCard(b, { column: 0, index: 0 }, { column: 1, index: 99 }), 1).length, 2, 'index dibatasi');
        eq(countCards(across), countCards(b), 'jumlah kartu tetap');
    });
    test('operasi daftar: tambah, ganti nama, pindah, hapus', () => {
        let b = parseBoard(BOARD);
        b = addColumn(b, 'Ide', 0);
        eq(titles(b), ['Ide', 'Rencana', 'Dikerjakan', 'Selesai']);
        b = renameColumn(b, 0, '  Ide Baru ');
        b = moveColumn(b, 0, 3);
        eq(titles(b), ['Rencana', 'Dikerjakan', 'Selesai', 'Ide Baru'], 'pindah ke ujung');
        eq(renameColumn(b, 0, '  '), b, 'nama kosong ditolak');
        b = deleteList(b, 1);
        eq(titles(b), ['Rencana', 'Selesai', 'Ide Baru']);
        eq(b.footer, parseBoard(BOARD).footer, 'footer tetap');
    });
    test('cardMeta: #tag dan @{tanggal} dipisahkan dari judul', () => {
        eq(cardMeta('Tulis laporan #penting #kerja/besar @{2026-10-20}'), { title: 'Tulis laporan', tags: ['penting', 'kerja/besar'], due: '2026-10-20' });
        eq(cardMeta('Tanpa meta'), { title: 'Tanpa meta', tags: [], due: null });
        eq(cardMeta('http://x.y/#bagian').tags, [], 'tanda # di dalam URL bukan tag');
        eq(cardMeta('#saja').title, '#saja', 'teks yang hanya tag tetap tampil');
    });
    test('dueStatus dan dropIndex', () => {
        eq(['2026-10-01', '2026-10-03', '2026-10-05', '2026-10-09'].map(d => dueStatus(d, '2026-10-03')), ['overdue', 'today', 'soon', 'later']);
        eq([dropIndex([10, 50, 90], 0), dropIndex([10, 50, 90], 60), dropIndex([10, 50, 90], 200), dropIndex([], 5)], [0, 2, 3, 0]);
    });

    section('Bahasa blok kode');
    test('nama bahasa umum dan alias dikenali', () => {
        const ids = ['js', 'javascript', 'ts', 'py', 'python', 'bash', 'rs', 'go', 'c++', 'yml', 'json', 'html', 'sql']
            .map(n => resolveLanguage(n)?.get_id() ?? null);
        eq(ids, ['js', 'js', 'typescript', 'python3', 'python3', 'sh', 'rust', 'go', 'cpp', 'yaml', 'json', 'html', 'sql']);
    });
    test('nama tak dikenal dan kosong tidak diwarnai', () => {
        eq([resolveLanguage('bahasa-ngarang'), resolveLanguage('')], [null, null]);
    });

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

// ───────────────────────── Tes editor (GUI) ─────────────────────────

function runGuiTests(app: Gtk.Application): void {
    const settings = { ...DEFAULTS, welcomed: true, dark: false };
    const w = new MainWindow(app, settings, null);
    const ed = w.editor;
    const buf = ed.buffer;
    const ctx = GLib.MainContext.default();
    const pump = () => { for (let i = 0; i < 200 && ctx.pending(); i++) ctx.iteration(false); };
    const text = () => { const [s, e] = buf.get_bounds(); return buf.get_text(s, e, true); };
    const setText = (t: string) => { ed.setText(t); pump(); };
    const cursorTo = (line: number, col = 0) => {
        const it = buf.get_iter_at_line(line);
        if (col < 0) it.forward_to_line_end(); else it.forward_chars(col);
        buf.place_cursor(it);
        pump();
    };
    // Posisi (code point) teks needle di dalam s.
    const offsetIn = (s: string, needle: string) => {
        const i = s.indexOf(needle);
        if (i < 0) throw new Error(`teks ${JSON.stringify(needle)} tidak ditemukan`);
        return Array.from(s.slice(0, i)).length;
    };
    const hidden = (off: number) => buf.get_iter_at_offset(off).has_tag(ed.tags.hidden);
    const tagAt = (off: number, name: TagName) => buf.get_iter_at_offset(off).has_tag(ed.tags[name]);
    const key = (keyval: number, state = 0 as Gdk.ModifierType) => {
        const handled = ed.onKey({ get_keyval: () => [true, keyval], get_state: () => [true, state] });
        if (!handled) buf.insert_at_cursor(keyval === Gdk.KEY_Return ? '\n' : '', -1);
        pump();
    };
    const action = (name: string | Option) => { app.lookup_action(name)!.activate(null); pump(); };
    const clickAt = (off: number) => {
        const rect = ed.view.get_iter_location(buf.get_iter_at_offset(off));
        const [x, y] = ed.view.buffer_to_window_coords(Gtk.TextWindowType.TEXT, rect.x + 2, rect.y + rect.height / 2);
        const handled = ed.onClick({
            get_button: () => [true, 1], get_event_type: () => Gdk.EventType.BUTTON_PRESS,
            get_coords: () => [true, x, y], get_state: () => [true, 0 as Gdk.ModifierType],
        });
        pump();
        return handled;
    };

    pump();

    section('Menyembunyikan sintaks (ala Typora)');
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
        eq(w.outline.list.get_children().length, 3, 'jumlah baris outline');
    });

    section('Enter dan Tab di daftar');
    test('Enter melanjutkan daftar biasa', () => {
        setText('- satu'); cursorTo(0, -1); key(Gdk.KEY_Return);
        eq(text(), '- satu\n- ');
    });
    test('Enter di item kosong mengakhiri daftar', () => {
        key(Gdk.KEY_Return);
        eq(text(), '- satu\n');
    });
    test('Enter menaikkan nomor daftar', () => {
        setText('9. a'); cursorTo(0, -1); key(Gdk.KEY_Return);
        eq(text(), '9. a\n10. ');
    });
    test('Enter di daftar tugas membuat kotak kosong', () => {
        setText('- [x] a'); cursorTo(0, -1); key(Gdk.KEY_Return);
        eq(text(), '- [x] a\n- [ ] ');
    });
    test('Enter melanjutkan kutipan', () => {
        setText('> a'); cursorTo(0, -1); key(Gdk.KEY_Return);
        eq(text(), '> a\n> ');
    });
    test('Enter di dalam blok kode tidak menambah bullet', () => {
        setText('```\n- a\n```'); cursorTo(1, -1);
        ok(!ed.onKey({ get_keyval: () => [true, Gdk.KEY_Return], get_state: () => [true, 0 as Gdk.ModifierType] }), 'Enter ditangani sebagai daftar');
    });
    test('Tab dan Shift+Tab mengatur indentasi', () => {
        setText('- a'); cursorTo(0, -1);
        key(Gdk.KEY_Tab); eq(text(), '    - a', 'setelah Tab');
        key(Gdk.KEY_ISO_Left_Tab, Gdk.ModifierType.SHIFT_MASK); eq(text(), '- a', 'setelah Shift+Tab');
    });

    section('Perintah format');
    test('Ctrl+B membungkus pilihan dengan **', () => {
        setText('satu kata');
        buf.select_range(buf.get_iter_at_offset(5), buf.get_iter_at_offset(9)); pump();
        action('bold');
        eq(text(), 'satu **kata**');
    });
    test('Ctrl+B lagi melepas **', () => { action('bold'); eq(text(), 'satu kata'); });
    test('undo mengembalikan perubahan', () => {
        setText('x');
        buf.select_range(buf.get_start_iter(), buf.get_end_iter()); pump();
        action('italic');
        eq(text(), '*x*', 'setelah Ctrl+I');
        buf.undo(); pump();
        eq(text(), 'x', 'setelah undo');
    });
    test('Ctrl+2 dan Ctrl+0 mengatur heading', () => {
        setText('judul'); cursorTo(0);
        action('heading2'); eq(text(), '## judul', 'Ctrl+2');
        action('heading0'); eq(text(), 'judul', 'Ctrl+0');
    });
    test('kutipan diterapkan ke beberapa baris', () => {
        setText('a\nb');
        buf.select_range(buf.get_start_iter(), buf.get_end_iter()); pump();
        action('quote'); eq(text(), '> a\n> b');
    });
    test('Ctrl+K membuat tautan dari pilihan', () => {
        setText('GTK');
        buf.select_range(buf.get_start_iter(), buf.get_end_iter()); pump();
        action('link'); eq(text(), '[GTK]()');
    });
    test('klik kotak tugas mencentang dan menghapus centang', () => {
        setText('- [ ] tugas\n\nlain'); cursorTo(2);
        ok(clickAt(3), 'klik tidak ditangani');
        eq(text(), '- [x] tugas\n\nlain', 'setelah klik pertama');
        clickAt(3);
        eq(text(), '- [ ] tugas\n\nlain', 'setelah klik kedua');
    });

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

    section('Gambar');
    // Gambar uji 300×100 di folder sementara.
    const imgDir = GLib.build_filenamev([tmp, 'gambar']);
    GLib.mkdir_with_parents(imgDir, 0o755);
    const pb = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 300, 100);
    pb.fill(0x4183c4ff);
    pb.savev(GLib.build_filenamev([imgDir, 'uji.png']), 'png', [], []);
    const images = () => ed.images.blocks;
    const waitImages = () => {
        for (let i = 0; i < 200 && images().some(b => b.items.some(it => !it.entry || it.entry.status === 'loading')); i++) {
            pump();
            GLib.usleep(10000);
        }
        pump();
    };
    const hasGap = (line: number) => buf.get_iter_at_line(line).get_tags().some(t => t.name?.startsWith('image-gap-'));

    test('gambar lokal dimuat dan ditampilkan di bawah barisnya', () => {
        w.file = GLib.build_filenamev([tmp, 'dok.md']);
        setText('judul\n\n![uji](gambar/uji.png)\n\nakhir');
        waitImages();
        eq(images().length, 1, 'jumlah blok gambar');
        const block = images()[0];
        eq(block.items[0].entry?.status, 'ok', 'status muat');
        ok(block.box.get_visible(), 'widget gambar tidak terlihat');
        ok(hasGap(2), 'ruang di bawah baris gambar tidak disediakan');
        const [lineY] = ed.view.get_line_yrange(buf.get_iter_at_line(2));
        ok(block.y > lineY, `gambar (y=${block.y}) tidak di bawah barisnya (y=${lineY})`);
    });
    test('isi dokumen tidak berubah karena gambar', () => {
        eq(text(), 'judul\n\n![uji](gambar/uji.png)\n\nakhir');
    });
    test('sintaks gambar tersembunyi di baris lain, terlihat di baris aktif', () => {
        cursorTo(0);
        ok(hidden(9) && hidden(15), '![uji](...) seharusnya tersembunyi');
        cursorTo(2);
        ok(!hidden(9) && !hidden(15), '![uji](...) seharusnya terlihat');
    });
    test('widget dipakai ulang saat baris bergeser', () => {
        const before = images()[0];
        buf.insert(buf.get_start_iter(), 'baris baru\n', -1);
        pump();
        eq(images().length, 1, 'jumlah blok gambar');
        ok(images()[0] === before, 'widget dibuat ulang');
        eq(images()[0].line, 3, 'baris gambar');
        ok(hasGap(3) && !hasGap(2), 'ruang kosong tidak ikut pindah');
    });
    test('gambar yang tidak ada menampilkan pesan', () => {
        setText('![hilang](gambar/tidak-ada.png)');
        waitImages();
        eq(images()[0].items[0].entry?.status, 'error', 'status muat');
        // Setiap item dibungkus EventBox untuk menangkap kliknya.
        const label = (images()[0].content.get_children()[0] as Gtk.Bin).get_child();
        ok(label instanceof Gtk.Label && label.label.includes('hilang'), 'label error tidak tampil');
    });
    test('gambar di baris tabel dan blok kode diabaikan', () => {
        setText('| ![a](gambar/uji.png) |\n| --- |\n\n```\n![b](gambar/uji.png)\n```');
        eq(images().length, 0, 'jumlah blok gambar');
    });
    test('mode source menyembunyikan gambar', () => {
        setText('![uji](gambar/uji.png)\nteks');
        waitImages();
        action('source');
        ok(!images()[0].box.get_visible() && !hasGap(0), 'gambar masih tampil di mode source');
        action('source');
        ok(images()[0].box.get_visible() && hasGap(0), 'gambar tidak muncul lagi');
    });
    test('klik gambar memindahkan kursor ke barisnya', () => {
        cursorTo(1);
        ed.images.onActivate(images()[0].line);
        pump();
        eq(buf.get_iter_at_mark(buf.get_insert()).get_line(), 0, 'baris kursor');
    });
    test('menghapus sintaks gambar menghapus widgetnya', () => {
        setText('teks saja');
        eq(images().length, 0, 'jumlah blok gambar');
    });
    section('Zoom gambar');
    const makePixbuf = (width: number, height: number) => {
        const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, width, height);
        pixbuf.fill(0x4183c4ff);
        return pixbuf;
    };
    makePixbuf(50, 50).savev(GLib.build_filenamev([imgDir, 'kecil.png']), 'png', [], []);
    const settleV = () => { for (let i = 0; i < 30; i++) { pump(); GLib.usleep(10000); } };
    const openViewer = (pixbuf: GdkPixbuf.Pixbuf, title = 'uji') => {
        const viewer = new ImageViewer(w.win, pixbuf, title);
        viewer.show();
        settleV();
        return viewer;
    };
    const message = () => w.statusBar.left.label;
    const cursorLineNow = () => buf.get_iter_at_mark(buf.get_insert()).get_line();
    const originalOnView = ed.onViewImage;
    let viewed: { pixbuf: GdkPixbuf.Pixbuf; title: string } | null = null;
    ed.onViewImage = (pixbuf, title) => { viewed = { pixbuf, title }; };

    test('imageAt memberi gambar ukuran penuh, bukan yang diperkecil untuk tampilan', () => {
        w.file = GLib.build_filenamev([tmp, 'dok.md']);
        setText('![uji](gambar/uji.png)\n\nteks'); waitImages();
        const found = ed.images.imageAt(0);
        ok(found.ok, 'gambar tidak ditemukan');
        eq([found.pixbuf.get_width(), found.pixbuf.get_height(), found.title], [300, 100, 'uji']);
    });
    test('judul penampil: teks alt, atau nama file jika alt kosong', () => {
        setText('![](gambar/uji.png)'); waitImages();
        const found = ed.images.imageAt(0);
        ok(found.ok && found.title === 'uji.png', 'judul dari nama file');
    });
    test('imageAt menolak baris tanpa gambar dan gambar yang gagal dimuat', () => {
        setText('![x](gambar/tidak-ada.png)\n\nteks'); waitImages();
        const missing = ed.images.imageAt(0), none = ed.images.imageAt(2);
        ok(!missing.ok && missing.reason === 'Gambar tidak bisa dimuat', 'gambar hilang');
        ok(!none.ok && none.reason === 'Tidak ada gambar di baris ini', 'baris tanpa gambar');
    });
    test('klik sekali memindahkan kursor ke gambar; klik ganda memperbesarnya', () => {
        setText('teks\n\n![uji](gambar/uji.png)'); waitImages(); cursorTo(0);
        viewed = null;
        ed.images.press(2, 0, false); pump();
        eq(cursorLineNow(), 2, 'kursor setelah klik sekali');
        eq(viewed, null, 'klik sekali tidak membuka penampil');
        ed.images.press(2, 0, true);
        ok(viewed !== null && (viewed as { pixbuf: GdkPixbuf.Pixbuf }).pixbuf.get_width() === 300, 'klik ganda tidak membuka penampil');
    });
    test('klik ganda memilih gambar yang tepat jika satu baris memuat beberapa gambar', () => {
        setText('![a](gambar/uji.png) ![b](gambar/kecil.png)'); waitImages();
        viewed = null;
        ed.images.press(0, 1, true);
        const v = viewed as unknown as { pixbuf: GdkPixbuf.Pixbuf; title: string };
        eq([v.pixbuf.get_width(), v.title], [50, 'b']);
    });
    test('zoomImage memakai baris kursor; tanpa gambar menampilkan pesan', () => {
        setText('teks\n\n![uji](gambar/uji.png)'); waitImages();
        cursorTo(2); viewed = null; ed.zoomImage();
        ok(viewed !== null, 'gambar di baris kursor tidak dibuka');
        cursorTo(0); viewed = null; ed.zoomImage();
        eq([viewed, message()], [null, 'Tidak ada gambar di baris ini']);
    });
    test('perintah menu Perbesar Gambar', () => {
        cursorTo(2); viewed = null;
        action('zoom-image');
        ok(viewed !== null, 'aksi tidak membuka penampil');
    });
    ed.onViewImage = originalOnView;

    test('penampil: gambar kecil dibuka 100%, gambar besar dipas ke jendela', () => {
        const small = openViewer(makePixbuf(100, 80));
        eq(small.zoom, 1, 'gambar kecil tidak diperbesar');
        const big = openViewer(makePixbuf(3000, 2000));
        ok(big.zoom < 0.5 && big.zoom > MIN_ZOOM, `zoom awal gambar besar ${big.zoom}`);
        ok(big.area.get_size_request()[0] <= big.window.get_allocated_width(), 'gambar lebih lebar dari jendela');
        small.close(); big.close();
    });
    test('zoom masuk/keluar mengalikan 1,25 dan dibatasi 5%–800%', () => {
        const v = openViewer(makePixbuf(100, 80));
        v.zoomIn(); eq(Math.round(v.zoom * 1000) / 1000, 1.25, 'zoom masuk');
        v.zoomOut(); v.zoomOut(); eq(Math.round(v.zoom * 1000) / 1000, 0.8, 'zoom keluar');
        for (let i = 0; i < 40; i++) v.zoomIn();
        eq(v.zoom, MAX_ZOOM, 'batas atas');
        for (let i = 0; i < 80; i++) v.zoomOut();
        eq(v.zoom, MIN_ZOOM, 'batas bawah');
        v.actual(); eq(v.zoom, 1, 'ukuran asli');
        v.close();
    });
    test('ukuran area gambar mengikuti zoom', () => {
        const v = openViewer(makePixbuf(400, 200));
        v.actual(); eq(v.area.get_size_request(), [400, 200], '100%');
        v.zoomIn(); eq(v.area.get_size_request(), [500, 250], '125%');
        v.close();
    });
    test('Pas memperbesar gambar kecil, 0 mengembalikan 100%', () => {
        const v = openViewer(makePixbuf(100, 80));
        v.fit(); settleV();
        ok(v.zoom > 1, `pas layar gambar kecil ${v.zoom}`);
        v.handleKey(Gdk.KEY_0); eq(v.zoom, 1, 'ukuran asli');
        v.close();
    });
    test('tombol: + − 0 F Esc; tombol lain tidak ditangani', () => {
        const v = openViewer(makePixbuf(100, 80));
        ok(v.handleKey(Gdk.KEY_plus) && Math.abs(v.zoom - 1.25) < 1e-9, '+');
        ok(v.handleKey(Gdk.KEY_minus) && Math.abs(v.zoom - 1) < 1e-9, '−');
        ok(v.handleKey(Gdk.KEY_f), 'F'); settleV(); ok(v.zoom > 1, 'F memperbesar gambar kecil');
        ok(v.handleKey(Gdk.KEY_0) && v.zoom === 1, '0');
        ok(!v.handleKey(Gdk.KEY_a), 'tombol lain');
        ok(v.handleKey(Gdk.KEY_Escape) && v.closed, 'Esc menutup');
    });
    test('zoom di titik penunjuk: titik gambar di bawah penunjuk tidak bergeser', () => {
        const v = openViewer(makePixbuf(2000, 1500));
        v.actual(); settleV();
        const scroller = v['scroller'];
        scroller.get_hadjustment().set_value(0); scroller.get_vadjustment().set_value(0);
        // Roda ke atas di titik (400, 300) pada gambar yang tergulir ke (0, 0).
        const wheel = { get_coords: () => [true, 400, 300], get_scroll_direction: () => [true, Gdk.ScrollDirection.UP], get_scroll_deltas: () => [false, 0, 0] };
        v['onScroll'](wheel as unknown as Gdk.Event, true); settleV();
        // Titik gambar (400, 300) kini di 500 × 375; agar tetap di (400, 300) layar, gulir (100, 75).
        const [h, vv] = [scroller.get_hadjustment().get_value(), scroller.get_vadjustment().get_value()];
        ok(Math.abs(h - 100) < 1.5 && Math.abs(vv - 75) < 1.5, `gulir (${h}, ${vv}), seharusnya (100, 75)`);
        v.close();
    });
    test('drag menggeser gambar', () => {
        const v = openViewer(makePixbuf(2000, 1500));
        v.actual(); settleV();
        const scroller = v['scroller'];
        scroller.get_hadjustment().set_value(0); scroller.get_vadjustment().set_value(0);
        const at = (x: number, y: number, type = Gdk.EventType.BUTTON_PRESS) => ({
            get_button: () => [true, 1], get_event_type: () => type, get_root_coords: () => [true, x, y],
        }) as unknown as Gdk.Event;
        v['onPress'](at(500, 500));
        v['onMotion'](at(450, 470));   // digeser ke kiri-atas = melihat bagian kanan-bawah
        eq([scroller.get_hadjustment().get_value(), scroller.get_vadjustment().get_value()], [50, 30], 'gulir');
        v['endDrag'](); ok(!v['onMotion'](at(0, 0)), 'setelah lepas tombol, gerak tidak menggeser');
        v.close();
    });
    test('klik ganda di penampil: bergantian pas layar dan 100%', () => {
        const v = openViewer(makePixbuf(3000, 2000));
        const dbl = { get_button: () => [true, 1], get_event_type: () => Gdk.EventType.DOUBLE_BUTTON_PRESS, get_root_coords: () => [true, 0, 0] } as unknown as Gdk.Event;
        const fitted = v.zoom;
        v['onPress'](dbl); eq(v.zoom, 1, 'ke 100%');
        v['onPress'](dbl); settleV();
        ok(Math.abs(v.zoom - fitted) < 0.02, `kembali ke pas layar (${v.zoom} vs ${fitted})`);
        v.close();
    });
    test('fungsi bantu zoom', () => {
        eq([clampZoom(100), clampZoom(0), clampZoom(2)], [MAX_ZOOM, MIN_ZOOM, 2], 'clampZoom');
        eq(fitZoom(1000, 500, 500, 500), 0.5, 'fitZoom mengikuti sisi yang lebih sempit');
    });
    test('menggambar dengan zoom besar tidak memicu peringatan GTK/cairo', () => {
        const warnings: string[] = [];
        const flags = GLib.LogLevelFlags.LEVEL_WARNING | GLib.LogLevelFlags.LEVEL_CRITICAL;
        const handlers = ['Gtk', 'Gdk', 'GLib-GObject'].map(domain =>
            [domain, GLib.log_set_handler(domain, flags, (_d, _l, m) => { warnings.push(`${domain}: ${m}`); })] as const);
        try {
            const v = openViewer(makePixbuf(3000, 2000));
            for (let i = 0; i < 10; i++) { v.zoomIn(); settleV(); }
            v.zoomOut(); settleV();
            v.close(); settleV();
        } finally {
            for (const [domain, id] of handlers) GLib.log_remove_handler(domain, id);
        }
        eq(warnings, [], 'peringatan');
    });
    w.file = null;

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

    section('Tabel (grid dan penyuntingan)');
    //  0 atas | 1 (kosong) | 2 judul | 3 pemisah | 4 satu | 5 dua | 6 (kosong) | 7 bawah
    const DOC = 'atas\n\n| Nama | Nilai |\n| :--- | ---: |\n| satu | 1 |\n| dua | 2 |\n\nbawah';
    const settleT = () => { for (let i = 0; i < 30; i++) { pump(); GLib.usleep(10000); } };
    const tBlock = () => ed.tableLayer.blocks[0];
    const tableTag = (line: number) => buf.get_iter_at_line(line).has_tag(ed.tags.tablehide);
    const lineAt = (n: number) => text().split('\n')[n];
    const curLine = () => buf.get_iter_at_mark(buf.get_insert()).get_line();
    const curCol = () => cellIndexAt(lineAt(curLine()), buf.get_iter_at_mark(buf.get_insert()).get_line_offset());
    const tableLines = (from: number, to: number) => text().split('\n').slice(from, to + 1);
    const tableMessage = () => w.statusBar.left.label;

    test('tabel di luar kursor dirender sebagai grid', () => {
        setText(DOC); cursorTo(0); settleT();
        const b = tBlock();
        ok(b.collapsed && b.widget && b.widget.get_visible(), 'grid tidak tampil');
        ok([2, 3, 4, 5].every(tableTag), 'baris tabel tidak dikecilkan');
        ok(!tableTag(1) && !tableTag(6) && !tableTag(0), 'teks di luar tabel ikut dikecilkan');
    });
    test('isi dokumen tidak berubah karena grid', () => eq(text(), DOC));
    test('grid berada di antara paragraf di atas dan di bawahnya', () => {
        const [prevY, prevH] = ed.view.get_line_yrange(buf.get_iter_at_line(1));
        const [nextY] = ed.view.get_line_yrange(buf.get_iter_at_line(6));
        const b = tBlock();
        ok(b.height > 0, 'tinggi grid 0');
        ok(b.y >= prevY + prevH, `grid (y=${b.y}) menimpa paragraf di atasnya (bawah=${prevY + prevH})`);
        ok(b.y + b.height <= nextY, `grid (bawah=${b.y + b.height}) menimpa paragraf di bawahnya (atas=${nextY})`);
    });
    test('kursor masuk ke tabel: teks mentah tampil, grid hilang', () => {
        cursorTo(4); settleT();
        const b = tBlock();
        ok(!b.collapsed && !b.widget?.get_visible(), 'grid masih tampil');
        ok(![2, 3, 4, 5].some(tableTag), 'baris tabel masih dikecilkan');
    });
    test('kursor keluar lagi: grid kembali', () => {
        cursorTo(7); settleT();
        ok(tBlock().collapsed && tBlock().widget?.get_visible(), 'grid tidak kembali');
    });
    test('klik sel menaruh kursor di sel itu pada teks mentah', () => {
        cursorTo(0); settleT();
        ed.tableLayer.onActivate(5, 1);
        pump();
        eq([curLine(), curCol()], [5, 1], 'sel baris "dua" kolom 2');
        ok(!tBlock().collapsed, 'tabel tidak terbuka');
        cursorTo(0); ed.tableLayer.onActivate(2, 0); pump();
        eq([curLine(), curCol()], [2, 0], 'sel judul kolom 1');
    });
    test('Tab pindah ke sel berikutnya, lalu ke baris berikutnya', () => {
        setText(DOC); cursorTo(4, 2);
        key(Gdk.KEY_Tab); eq([curLine(), curCol()], [4, 1], 'sel kedua');
        key(Gdk.KEY_Tab); eq([curLine(), curCol()], [5, 0], 'baris berikutnya');
    });
    test('Tab di sel terakhir menambah baris baru', () => {
        cursorTo(5, 9);
        key(Gdk.KEY_Tab);
        eq(text().split('\n').length, DOC.split('\n').length + 1, 'jumlah baris');
        eq(lineAt(6), '|  |  |', 'baris baru');
        eq([curLine(), curCol()], [6, 0], 'kursor di sel pertama baris baru');
    });
    test('Shift+Tab mundur, dan berhenti di sel pertama', () => {
        setText(DOC); cursorTo(5, 2);
        key(Gdk.KEY_ISO_Left_Tab, Gdk.ModifierType.SHIFT_MASK); eq([curLine(), curCol()], [4, 1], 'ke baris sebelumnya');
        cursorTo(2, 2);
        key(Gdk.KEY_ISO_Left_Tab, Gdk.ModifierType.SHIFT_MASK); eq([curLine(), curCol()], [2, 0], 'tetap di sel pertama');
    });
    test('Enter pindah ke sel yang sama di baris berikutnya, melewati baris pemisah', () => {
        setText(DOC); cursorTo(2, 9);
        key(Gdk.KEY_Return); eq([curLine(), curCol()], [4, 1], 'dari judul ke baris isi pertama');
        key(Gdk.KEY_Return); eq([curLine(), curCol()], [5, 1], 'ke baris berikutnya');
    });
    test('Enter di baris terakhir menambah baris; di baris kosong terakhir keluar dari tabel', () => {
        key(Gdk.KEY_Return);
        eq(lineAt(6), '|  |  |', 'baris baru');
        eq([curLine(), curCol()], [6, 1], 'kursor di sel yang sama');
        key(Gdk.KEY_Return);
        eq(lineAt(6), '', 'baris kosong dihapus');
        eq(text(), DOC, 'dokumen kembali seperti semula');
        eq(curLine(), 6, 'kursor di luar tabel');
    });
    test('Enter di luar tabel tidak ditangani tabel', () => {
        setText('teks\n\n| a |\n| - |\n| 1 |'); cursorTo(0, 4);
        ok(!ed.onKey({ get_keyval: () => [true, Gdk.KEY_Return], get_state: () => [true, 0 as Gdk.ModifierType] }), 'Enter di paragraf biasa ditangani');
    });
    test('tabel hanya judul: Tab di sel terakhir menambah baris isi', () => {
        setText('| a | b |\n| --- | --- |\n\nx'); cursorTo(0, 6);
        key(Gdk.KEY_Tab);
        eq(tableLines(0, 3), ['| a | b |', '| --- | --- |', '|  |  |', ''], 'baris baru');
        eq([curLine(), curCol()], [2, 0], 'kursor');
    });

    test('perintah: tambah baris di bawah (kolom dirapikan)', () => {
        setText(DOC); cursorTo(4, 2);
        ed.tableCommand('row-below');
        eq(tableLines(2, 6), ['| Nama | Nilai |', '| :--- | ----: |', '| satu |     1 |', '|      |       |', '| dua  |     2 |']);
        eq([curLine(), curCol()], [5, 0], 'kursor di baris baru');
    });
    test('perintah: tambah baris di atas dan hapus baris', () => {
        setText(DOC); cursorTo(5, 2);
        ed.tableCommand('row-above');
        eq(tableLines(4, 6).map(l => l.trim()), ['| satu |     1 |', '|      |       |', '| dua  |     2 |'], 'sisip di atas "dua"');
        eq(curLine(), 5, 'kursor di baris baru');
        ed.tableCommand('delete-row');
        eq(tableLines(2, 5), ['| Nama | Nilai |', '| :--- | ----: |', '| satu |     1 |', '| dua  |     2 |'], 'baris dihapus');
    });
    test('perintah: tambah dan hapus kolom', () => {
        setText(DOC); cursorTo(4, 2);
        ed.tableCommand('col-right');   // kursor di kolom 1, jadi kolom baru di kanannya
        eq(tableLines(2, 5), ['| Nama |     | Nilai |', '| :--- | --- | ----: |', '| satu |     |     1 |', '| dua  |     |     2 |'], 'kolom baru');
        eq([curLine(), curCol()], [4, 1], 'kursor di kolom baru');
        ed.tableCommand('delete-col');
        eq(tableLines(2, 5), ['| Nama | Nilai |', '| :--- | ----: |', '| satu |     1 |', '| dua  |     2 |'], 'kolom baru dihapus; kolom lain utuh');
        ed.tableCommand('col-left');    // kursor sekarang di kolom "Nilai" (menggantikan kolom yang dihapus)
        eq(lineAt(2), '| Nama |     | Nilai |', 'kolom baru di kiri "Nilai"');
    });
    test('perintah: rata tengah dan rapikan', () => {
        setText('| a | b |\n| --- | --- |\n| panjang | 1 |'); cursorTo(0, 2);
        ed.tableCommand('align-center');
        eq(tableLines(0, 2), ['| a       | b   |', '| :-----: | --- |', '| panjang | 1   |'].map((l, i) => i === 0 ? '|    a    | b   |' : l));
        ed.tableCommand('format');
        eq(lineAt(2), '| panjang | 1   |', 'rapikan tidak mengubah yang sudah rapi');
    });
    test('perintah yang tidak boleh ditolak dengan pesan', () => {
        setText(DOC); cursorTo(2, 2);
        ed.tableCommand('delete-row'); eq(tableMessage(), 'Baris judul tidak bisa dihapus');
        ed.tableCommand('row-above'); eq(tableMessage(), 'Tidak bisa menyisipkan baris di atas judul tabel');
        cursorTo(0);
        ed.tableCommand('format'); eq(tableMessage(), 'Kursor harus berada di dalam tabel');
        eq(text(), DOC, 'dokumen tidak berubah');
    });
    test('satu perintah tabel = satu langkah undo', () => {
        setText(DOC); cursorTo(4, 2);
        ed.tableCommand('format');
        ok(text() !== DOC, 'perintah tidak mengubah dokumen');
        buf.undo(); pump();
        eq(text(), DOC, 'setelah undo');
    });
    test('perintah tabel lewat aksi menu', () => {
        setText(DOC); cursorTo(4, 2);
        action('table-row-below');
        eq(text().split('\n').length, DOC.split('\n').length + 1, 'jumlah baris');
    });
    test('mode source menampilkan tabel mentah', () => {
        setText(DOC); cursorTo(0); settleT();
        ok(tBlock().collapsed, 'awal: grid tampil');
        action('source');
        ok(!tBlock().collapsed && !tBlock().widget?.get_visible() && !tableTag(3), 'mode source: grid masih tampil');
        action('source');
        ok(tBlock().collapsed && tBlock().widget?.get_visible(), 'setelah mode source dimatikan');
    });
    test('grid dipersempit agar muat di lebar kolom teks', () => {
        const before = ed.tableLayer.maxWidth;
        setText(`| ${'x'.repeat(80)} | ${'y'.repeat(80)} |\n| --- | --- |\n| 1 | 2 |\n\nakhir`); cursorTo(4);
        ed.tableLayer.setMaxWidth(320);
        settleT();
        // TextView memberi anak widget ukuran minimumnya; itulah lebar yang tampil.
        const width = tBlock().widget!.get_allocated_width();
        ok(width > 0 && width <= 320, `lebar grid ${width}px melebihi kolom 320px`);
        ed.tableLayer.setMaxWidth(before);
    });
    test('mengetik di tabel tidak membangun ulang grid selama kursor di dalamnya', () => {
        setText(DOC); cursorTo(4, 2); settleT();
        buf.insert_at_cursor('x', -1); pump();
        ok(tBlock().widget === null, 'grid dibangun saat kursor di dalam tabel');
        cursorTo(0); settleT();
        ok(tBlock().widget?.get_visible(), 'grid tidak muncul setelah kursor keluar');
    });
    test('tabel dan gambar beralt emoji tidak memicu peringatan GTK/Pango', () => {
        // Font emoji berwarna pada ukuran teks nyaris nol pernah membuat GTK gagal menggambar.
        const warnings: string[] = [];
        const flags = GLib.LogLevelFlags.LEVEL_WARNING | GLib.LogLevelFlags.LEVEL_CRITICAL;
        const handlers = ['Gtk', 'Pango', 'Gdk'].map(domain =>
            [domain, GLib.log_set_handler(domain, flags, (_d, _l, message) => { warnings.push(`${domain}: ${message}`); })] as const);
        try {
            setText('atas\n\n| 🎉 | b |\n| --- | --- |\n| 👍🏽 | ✨ |\n\n![🎉 alt](gambar/tidak-ada.png)\n\nbawah');
            cursorTo(0); settleT();
            cursorTo(4); settleT();
            cursorTo(8); settleT();
        } finally {
            for (const [domain, id] of handlers) GLib.log_remove_handler(domain, id);
        }
        eq(warnings, [], 'peringatan');
    });
    test('tabel di akhir dokumen tanpa baris baru', () => {
        setText('teks\n\n| a |\n| - |\n| 1 |'); cursorTo(0); settleT();
        ok(tBlock().collapsed && tBlock().widget?.get_visible(), 'grid tidak tampil');
        eq(text(), 'teks\n\n| a |\n| - |\n| 1 |', 'isi dokumen');
    });
    buf.set_modified(false);

    section('Kanban (papan)');
    const papan = GLib.build_filenamev([tmp, 'papan.md']);
    GLib.file_set_contents(papan, BOARD);
    const kb = w.board;
    const settleK = () => { for (let i = 0; i < 25; i++) { pump(); GLib.usleep(8000); } };
    const kbDescendants = (root: Gtk.Widget): Gtk.Widget[] =>
        root instanceof Gtk.Container ? root.get_children().flatMap(c => [c, ...kbDescendants(c)]) : [];
    const kbEntry = (name: string) => kbDescendants(kb.widget).find(c => c.get_name() === name) as Gtk.Entry | undefined;
    const kbCheck = (col: number, idx: number) => kbDescendants(kb.columns[col].cards[idx]).find(c => c instanceof Gtk.CheckButton) as Gtk.CheckButton;
    const kbMenu = (menu: Gtk.Menu, label: string): Gtk.MenuItem => {
        const item = menu.get_children().find(c => c instanceof Gtk.MenuItem && c.get_label() === label);
        if (!item) throw new Error(`item menu "${label}" tidak ada`);
        return item as Gtk.MenuItem;
    };
    const kbTitles = () => kb.getBoard().columns.map(c => c.title);
    const ptr = (lx: number, ly: number, rx: number, ry: number) =>
        ({ get_coords: () => [true, lx, ly], get_root_coords: () => [true, rx, ry], get_button: () => [true, 1] }) as unknown as Gdk.Event;
    // Titik di kartu `target` (offset dx, dy) dinyatakan dalam koordinat kartu `from`.
    const inCard = (from: Gtk.Widget, target: Gtk.Widget, dx: number, dy: number) => {
        const [, x, y] = target.translate_coordinates(from, dx, dy);
        return [x, y] as const;
    };
    const stubDialogs = (over: Partial<KanbanBoard['dialogs']> = {}) => {
        const calls: string[] = [];
        kb.dialogs = {
            editCard: () => { calls.push('sunting'); return null; },
            prompt: () => { calls.push('prompt'); return null; },
            confirm: () => { calls.push('konfirmasi'); return true; },
            ...over,
        };
        return calls;
    };
    const openBoard = () => { GLib.file_set_contents(papan, BOARD); w.load(papan); settleK(); };

    test('dokumen kanban dibuka sebagai papan, dokumen biasa sebagai teks', () => {
        openBoard();
        ok(w.boardMode, 'papan tidak tampil');
        eq(kbTitles(), ['Rencana', 'Dikerjakan', 'Selesai']);
        eq(kb.columns.map(c => c.cards.length), [2, 1, 2], 'jumlah kartu');
        ok(w.statusBar.right.label.includes('3 daftar · 5 kartu'), `status: ${w.statusBar.right.label}`);
        eq(text(), BOARD, 'teks dokumen tidak berubah karena dibuka');
        GLib.file_set_contents(papan, '# Biasa\n\nteks');
        w.load(papan); settleK();
        ok(!w.boardMode, 'dokumen biasa tampil sebagai papan');
        openBoard();
    });
    test('menambah kartu lewat dialog menulis ke teks dokumen', () => {
        openBoard();
        const titles: (string | undefined)[] = [];
        stubDialogs({ editCard: (_p, _c, title) => { titles.push(title); return { text: 'Kartu uji #baru', notes: ['catatan'] }; } });
        kb.showAddCard(1); settleK();
        eq(titles, ['Tambah Kartu'], 'judul dialog');
        eq(kb.cardTexts(1), ['Desain logo', 'Kartu uji #baru'], 'model');
        ok(text().includes('- [ ] Desain logo\n- [ ] Kartu uji #baru\n  catatan\n'), 'teks dokumen');
        ok(buf.get_modified(), 'dokumen belum ditandai berubah');
        stubDialogs({ editCard: () => ({ text: '', notes: [] }) });
        kb.showAddCard(1); settleK();
        eq(kb.cardTexts(1).length, 2, 'kartu kosong ditolak');
        stubDialogs({ editCard: () => null });
        kb.showAddCard(1); settleK();
        eq(kb.cardTexts(1).length, 2, 'dibatalkan');
    });
    test('menambah daftar lewat isian', () => {
        openBoard();
        kb.showAddList(); settleK();
        const entry = kbEntry('kanban-entry-list')!;
        ok(entry.get_child_visible() && entry.get_mapped(), 'isian tampil setelah klik Tambah daftar');
        entry.set_text('Review'); entry.activate(); settleK();
        eq(kbTitles(), ['Rencana', 'Dikerjakan', 'Selesai', 'Review']);
        ok(text().includes('## Review'), 'teks dokumen');
        kb.hideAdd();
    });
    test('kotak centang menandai kartu selesai', () => {
        openBoard();
        kbCheck(0, 1).set_active(true); settleK();
        eq(kb.getBoard().columns[0].cards[1].done, true, 'model');
        ok(text().includes('- [x] Kirim undangan'), 'teks dokumen');
        ok(kb.columns[0].cards[1].get_style_context().has_class('kanban-card-done'), 'gaya kartu selesai');
    });
    test('menu kartu: hapus, pindah ke daftar lain, naik/turun, tandai selesai', () => {
        openBoard();
        const menu = kb.cardMenu(0, 0);
        ok(!kbMenu(menu, 'Naik').get_sensitive() && kbMenu(menu, 'Turun').get_sensitive(), 'Naik/Turun di kartu pertama');
        kbMenu(menu, 'Turun').activate(); settleK();
        eq(kb.cardTexts(0), ['Kirim undangan', 'Tulis laporan #penting @{2026-10-20}'], 'turun');
        const submenu = kbMenu(kb.cardMenu(0, 0), 'Pindahkan ke').get_submenu() as Gtk.Menu;
        eq(submenu.get_children().map(c => (c as Gtk.MenuItem).get_label()), ['Dikerjakan', 'Selesai'], 'tujuan tidak memuat daftar asal');
        (submenu.get_children().find(c => (c as Gtk.MenuItem).get_label() === 'Selesai') as Gtk.MenuItem).activate(); settleK();
        eq([kb.cardTexts(0).length, kb.cardTexts(2).at(-1)], [1, 'Kirim undangan'], 'pindah ke akhir daftar tujuan');
        kbMenu(kb.cardMenu(2, 2), 'Tandai Selesai').activate(); settleK();
        eq(kb.getBoard().columns[2].cards[2].done, true, 'tandai selesai');
        kbMenu(kb.cardMenu(2, 2), 'Hapus').activate(); settleK();
        eq(kb.cardTexts(2).length, 2, 'hapus');
    });
    test('menu daftar: ganti nama, geser, hapus dengan konfirmasi', () => {
        openBoard();
        const calls = stubDialogs({ prompt: () => 'Backlog' });
        kbMenu(kb.columnMenu(0), 'Ganti Nama…').activate(); settleK();
        eq(kbTitles()[0], 'Backlog', 'ganti nama');
        ok(!kbMenu(kb.columnMenu(0), 'Geser ke Kiri').get_sensitive(), 'daftar pertama tidak bisa ke kiri');
        kbMenu(kb.columnMenu(0), 'Geser ke Kanan').activate(); settleK();
        eq(kbTitles(), ['Dikerjakan', 'Backlog', 'Selesai'], 'geser');
        stubDialogs({ confirm: () => false });
        kbMenu(kb.columnMenu(1), 'Hapus Daftar…').activate(); settleK();
        eq(kbTitles().length, 3, 'tidak jadi dihapus');
        stubDialogs({ confirm: () => true });
        kbMenu(kb.columnMenu(1), 'Hapus Daftar…').activate(); settleK();
        eq(kbTitles(), ['Dikerjakan', 'Selesai'], 'dihapus');
        void calls;
    });
    test('sunting kartu lewat dialog: judul dan catatan', () => {
        openBoard();
        stubDialogs({ editCard: () => ({ text: 'Judul baru #x', notes: ['baris 1', 'baris 2'] }) });
        kb.editCard(0, 1); settleK();
        eq(kb.getBoard().columns[0].cards[1], { done: false, text: 'Judul baru #x', notes: ['baris 1', 'baris 2'] });
        ok(text().includes('- [ ] Judul baru #x\n  baris 1\n  baris 2\n'), 'teks dokumen');
        stubDialogs({ editCard: () => ({ text: '', notes: [] }) });
        kb.editCard(0, 1); settleK();
        eq(kb.cardTexts(0)[1], 'Judul baru #x', 'judul kosong tidak menimpa');
    });
    test('klik kartu tanpa bergeser membuka sunting; gerak kecil tetap dianggap klik', () => {
        openBoard();
        const calls = stubDialogs();
        const card = kb.columns[0].cards[0];
        kb.onCardPress(0, 0, card, ptr(10, 10, 100, 100));
        kb.onCardMotion(ptr(12, 11, 103, 102));
        ok(!kb.dragging, 'gerak 3 piksel dianggap menyeret');
        kb.onCardRelease(ptr(12, 11, 103, 102));
        eq(calls, ['sunting']);
    });
    test('menyeret kartu ke daftar lain menjatuhkannya di posisi yang ditunjuk', () => {
        openBoard();
        const calls = stubDialogs();
        const moved = kb.cardTexts(0)[0];
        const source = kb.columns[0].cards[0], target = kb.columns[2].cards[0];
        const before = Gtk.Window.list_toplevels().length;
        kb.onCardPress(0, 0, source, ptr(10, 10, 100, 100));
        const top = inCard(source, target, 10, 4);   // di paruh atas kartu pertama daftar tujuan
        kb.onCardMotion(ptr(top[0], top[1], 500, 100));
        ok(kb.dragging, 'tidak mulai menyeret');
        eq(kb.columns[2].cardsBox.get_children().length, 3, 'penanda tujuan muncul di daftar tujuan');
        eq(Gtk.Window.list_toplevels().length, before + 1, 'kartu bayangan');
        kb.onCardRelease(ptr(top[0], top[1], 500, 100)); settleK();
        ok(!kb.dragging, 'masih menyeret setelah dilepas');
        eq(Gtk.Window.list_toplevels().length, before, 'kartu bayangan tidak dibersihkan');
        eq([kb.cardTexts(2)[0], kb.cardTexts(0).length, kb.cardTexts(2).length], [moved, 1, 3], 'kartu pindah ke atas daftar tujuan');
        ok(text().includes(`## Selesai\n\n- [ ] ${moved}\n`), 'teks dokumen');
        eq(calls, [], 'seret tidak membuka dialog sunting');
    });
    test('menyeret di paruh bawah kartu menjatuhkan setelahnya; di daftar yang sama mengurutkan ulang', () => {
        openBoard();
        const source = kb.columns[0].cards[0], second = kb.columns[0].cards[1];
        const first = kb.cardTexts(0)[0];
        kb.onCardPress(0, 0, source, ptr(10, 10, 100, 100));
        const low = inCard(source, second, 10, second.get_allocated_height() - 3);
        kb.onCardMotion(ptr(low[0], low[1], 100, 300));
        kb.onCardRelease(ptr(low[0], low[1], 100, 300)); settleK();
        eq(kb.cardTexts(0)[1], first, 'kartu pertama turun ke bawah kartu kedua');
    });
    test('menjatuhkan di tempat asal tidak mengubah apa pun', () => {
        openBoard();
        buf.set_modified(false);
        const source = kb.columns[1].cards[0];
        kb.onCardPress(1, 0, source, ptr(10, 10, 100, 100));
        const same = inCard(source, source, 10, 4);
        kb.onCardMotion(ptr(same[0], same[1], 300, 100));   // 200 px di layar → menyeret
        kb.onCardRelease(ptr(same[0], same[1], 300, 100)); settleK();
        eq(text(), BOARD, 'teks');
        ok(!buf.get_modified(), 'dokumen ditandai berubah');
    });
    test('menyeret ke ruang kosong di bawah daftar menjatuhkan di akhir daftar itu', () => {
        openBoard();
        const source = kb.columns[0].cards[0], last = kb.columns[1].cards[0];
        const moved = kb.cardTexts(0)[0];
        kb.onCardPress(0, 0, source, ptr(10, 10, 100, 100));
        const below = inCard(source, last, 10, 400);
        kb.onCardMotion(ptr(below[0], below[1], 400, 500));
        kb.onCardRelease(ptr(below[0], below[1], 400, 500)); settleK();
        eq(kb.cardTexts(1).at(-1), moved);
    });
    test('menyeret dekat tepi kanan menggulir papan', () => {
        openBoard();
        kb.showAddList(); kb.hideAdd(); settleK();
        const hadj = kb.widget.get_hadjustment();
        if (hadj.get_upper() - hadj.get_page_size() < 50) { w.win.resize(700, 600); settleK(); }
        hadj.set_value(0);
        const source = kb.columns[0].cards[0];
        kb.onCardPress(0, 0, source, ptr(10, 10, 100, 100));
        kb.onCardMotion(ptr(20, 20, 300, 100));
        const drag = kb['drag']!;
        const edgeX = hadj.get_value() + kb.widget.get_allocated_width() - 10;   // 10 px dari tepi kanan
        drag.pointer = [edgeX, drag.pointer[1]];
        kb.autoscroll();
        ok(hadj.get_value() > 0, `papan tidak tergulir (${hadj.get_value()})`);
        kb.onCardRelease(ptr(20, 20, 300, 100)); settleK();
        w.win.resize(1100, 700); settleK();
    });
    test('undo dan redo mengembalikan papan dan teks, satu langkah per perubahan', () => {
        openBoard();
        kb.commit(addCard(kb.getBoard(), 0, 'Satu'));
        kb.commit(addCard(kb.getBoard(), 0, 'Dua')); settleK();
        eq(kb.cardTexts(0).length, 4, 'dua kartu ditambah');
        action('undo'); settleK();
        eq([kb.cardTexts(0).length, text().includes('Dua')], [3, false], 'undo pertama hanya membatalkan "Dua"');
        action('undo'); settleK();
        eq([kb.cardTexts(0).length, text()], [2, BOARD], 'undo kedua mengembalikan teks semula');
        action('redo'); settleK();
        eq(kb.cardTexts(0).at(-1), 'Satu', 'redo');
    });
    test('beralih ke tampilan teks dan kembali; perubahan di teks muncul di papan', () => {
        openBoard();
        w.toggleBoardView(false); settleK();
        ok(!w.boardMode && ed.widget.get_visible(), 'tampilan teks');
        eq(text(), BOARD, 'teks mentah');
        setText(BOARD.replace('- [ ] Kirim undangan', '- [ ] Kirim undangan\n- [ ] Dari teks'));
        w.toggleBoardView(true); settleK();
        ok(w.boardMode, 'kembali ke papan');
        eq(kb.cardTexts(0), ['Tulis laporan #penting @{2026-10-20}', 'Kirim undangan', 'Dari teks']);
    });
    test('tampilan papan untuk dokumen biasa ditolak dengan pesan', () => {
        GLib.file_set_contents(papan, '# Biasa');
        w.load(papan); settleK();
        w.toggleBoardView(true);
        ok(!w.boardMode, 'dokumen biasa tampil sebagai papan');
        ok(w.statusBar.left.label.includes('bukan papan kanban'), `pesan: ${w.statusBar.left.label}`);
    });
    test('papan kanban baru berisi tiga daftar kosong', () => {
        w.newBoardDocument(); settleK();
        ok(w.boardMode && w.file === null, 'mode atau nama file');
        eq(kbTitles(), ['Rencana', 'Dikerjakan', 'Selesai']);
        ok(isKanban(text()), 'teks bukan papan kanban');
    });
    test('aksi yang menyunting teks ditolak saat papan tampil', () => {
        openBoard();
        const before = text();
        action('bold'); action('heading1'); action('table');
        eq(text(), before, 'teks berubah');
        ok(w.statusBar.left.label.includes('tampilan teks'), `pesan: ${w.statusBar.left.label}`);
    });
    test('simpan menulis Markdown yang bisa dibaca lagi sebagai papan yang sama', () => {
        openBoard();
        kb.commit(addCard(kb.getBoard(), 1, 'Tersimpan'));
        const out = GLib.build_filenamev([tmp, 'simpan.md']);
        w.file = out;
        ok(w.save(), 'save() gagal');
        const saved = readTextFile(out);
        eq(saved, text(), 'isi file = isi dokumen');
        eq(parseBoard(saved), kb.getBoard(), 'papan dari file = papan di layar');
        w.file = null;
    });
    test('label tanggal: tahun hanya jika bukan tahun ini; tanggal lewat batas ditandai', () => {
        kb.today = () => '2026-10-20';
        eq([kb.formatDue('2026-10-25'), kb.formatDue('2027-01-02')], ['25 Okt', '2 Jan 2027']);
        openBoard();
        const chip = (cls: string) => kbDescendants(kb.widget).some(c => c instanceof Gtk.Label && c.get_style_context().has_class(cls));
        ok(!chip('kanban-due-overdue'), 'tanggal 20 Okt belum lewat pada 20 Okt');
        kb.today = () => '2026-10-21'; kb.render(); settleK();
        ok(chip('kanban-due-overdue'), 'tanggal 20 Okt harus lewat batas pada 21 Okt');
        kb.today = () => '2026-10-20';
        eq([kb.tagColor('penting'), kb.tagColor('penting')].every(c => c >= 0 && c < 8), true, 'warna tag dalam rentang');
        eq(kb.tagColor('bug'), kb.tagColor('bug'), 'warna tag tetap');
    });
    test('replaceText: suntingan minimal, satu langkah undo, aman untuk emoji', () => {
        setText('atas 🎉 tengah 🎉 bawah');
        buf.set_modified(false);
        ed.replaceText('atas 🎉 TENGAH 🎉 bawah'); pump();
        eq(text(), 'atas 🎉 TENGAH 🎉 bawah');
        buf.undo(); pump();
        eq(text(), 'atas 🎉 tengah 🎉 bawah', 'undo');
        buf.set_modified(false);
        ed.replaceText('atas 🎉 tengah 🎉 bawah'); pump();
        ok(!buf.get_modified(), 'teks sama tidak mengubah dokumen');
        ed.replaceText('🎉🎉'); pump();
        eq(text(), '🎉🎉', 'pasangan surrogat di tepi');
        ed.replaceText('x🎉🎉y'); pump();
        eq(text(), 'x🎉🎉y');
    });
    test('papan dan seret tidak memicu peringatan GTK', () => {
        const warnings: string[] = [];
        const flags = GLib.LogLevelFlags.LEVEL_WARNING | GLib.LogLevelFlags.LEVEL_CRITICAL;
        const handlers = ['Gtk', 'Gdk', 'Pango', 'GLib-GObject'].map(domain =>
            [domain, GLib.log_set_handler(domain, flags, (_d, _l, m) => { warnings.push(`${domain}: ${m}`); })] as const);
        try {
            openBoard();
            const source = kb.columns[0].cards[0], target = kb.columns[2].cards[0];
            kb.onCardPress(0, 0, source, ptr(10, 10, 100, 100));
            const at = inCard(source, target, 10, 4);
            kb.onCardMotion(ptr(at[0], at[1], 500, 100)); settleK();
            kb.onCardRelease(ptr(at[0], at[1], 500, 100)); settleK();
            kb.showAddList(); settleK(); kb.hideAdd(); settleK();
            w.setDark(true); settleK(); w.setDark(false); settleK();
        } finally {
            for (const [domain, id] of handlers) GLib.log_remove_handler(domain, id);
        }
        eq(warnings, [], 'peringatan');
    });
    GLib.file_set_contents(papan, '# selesai');
    w.load(papan); settleK();
    stubDialogs();
    w.file = null;
    buf.set_modified(false);

    section('Folder');
    // Struktur uji:
    //   proyek/a.md  b.txt  Catatan.markdown  sub/c.md  sub/dalam/d.md
    //   proyek/.tersembunyi/x.md  node_modules/y.md  z-kosong/
    const proj = GLib.build_filenamev([tmp, 'proyek']);
    const write = (rel: string, content = '') => {
        const full = GLib.build_filenamev([proj, rel]);
        GLib.mkdir_with_parents(GLib.path_get_dirname(full), 0o755);
        GLib.file_set_contents(full, content);
        return full;
    };
    write('a.md', '# A');
    write('b.txt', 'bukan markdown');
    write('Catatan.markdown', '# Catatan');
    write('sub/c.md', '# C');
    const dPath = write('sub/dalam/d.md', '# D');
    write('.tersembunyi/x.md');
    write('node_modules/y.md');
    GLib.mkdir_with_parents(GLib.build_filenamev([proj, 'z-kosong']), 0o755);

    const ft = w.fileTree;
    const childNames = (parent: Gtk.TreeIter | null) => {
        const names: string[] = [];
        let [ok, it] = ft.store.iter_children(parent);
        while (ok) { names.push(ft.store.get_value(it, 0) as string); ok = ft.store.iter_next(it); }
        return names;
    };
    const rowOf = (parent: Gtk.TreeIter | null, name: string) => {
        let [ok, it] = ft.store.iter_children(parent);
        while (ok) { if (ft.store.get_value(it, 0) === name) return it; ok = ft.store.iter_next(it); }
        throw new Error(`baris "${name}" tidak ada`);
    };
    const waitFor = (cond: () => boolean) => {
        for (let i = 0; i < 300 && !cond(); i++) { pump(); GLib.usleep(10000); }
        return cond();
    };

    test('isi folder: subfolder dulu, hanya Markdown, tanpa file tersembunyi', () => {
        eq(listFolder(proj).map(e => e.name), ['sub', 'z-kosong', 'a.md', 'Catatan.markdown']);
    });
    test('membuka folder menampilkan pohon di tab Berkas', () => {
        w.openFolder(proj);
        pump();
        eq(ft.root, proj, 'root');
        eq(childNames(null), ['sub', 'z-kosong', 'a.md', 'Catatan.markdown'], 'baris root');
        eq(w.sidebar.page, 'files', 'tab sidebar');
        ok(w.sidebar.visible, 'sidebar tidak terlihat');
        eq(loadSettings().folder, proj, 'folder tersimpan di pengaturan');
    });
    test('isi subfolder baru dibaca saat dibuka', () => {
        const sub = rowOf(null, 'sub');
        eq(childNames(sub), [''], 'sebelum dibuka (baris pengganti)');
        ft.view.expand_row(ft.store.get_path(sub)!, false);
        pump();
        eq(childNames(sub), ['dalam', 'c.md'], 'setelah dibuka');
    });
    test('klik file di pohon membukanya di editor', () => {
        const row = rowOf(null, 'a.md');
        ft.view.row_activated(ft.store.get_path(row)!, ft.view.get_column(0)!);
        pump();
        eq(w.file, GLib.build_filenamev([proj, 'a.md']), 'file');
        eq(text(), '# A', 'isi editor');
    });
    test('file yang dibuka disorot, folder induknya ikut dibuka', () => {
        ok(w.load(dPath), 'load() gagal');
        pump();
        const [selected, , iter] = ft.view.get_selection().get_selected();
        ok(selected && iter, 'tidak ada baris tersorot');
        eq(ft.store.get_value(iter, 1), dPath, 'baris tersorot');
        const dalam = rowOf(rowOf(null, 'sub'), 'dalam');
        ok(ft.view.row_expanded(ft.store.get_path(dalam)!), 'folder "dalam" tidak terbuka');
    });
    test('file baru di disk muncul tanpa menutup subfolder yang terbuka', () => {
        write('b-baru.md', '# Baru');
        ok(waitFor(() => childNames(null).includes('b-baru.md')), 'file baru tidak muncul');
        eq(childNames(null), ['sub', 'z-kosong', 'a.md', 'b-baru.md', 'Catatan.markdown'], 'urutan');
        ok(ft.view.row_expanded(ft.store.get_path(rowOf(null, 'sub'))!), 'subfolder ikut tertutup');
    });
    test('file yang dihapus di disk hilang dari pohon', () => {
        GLib.unlink(GLib.build_filenamev([proj, 'b-baru.md']));
        ok(waitFor(() => !childNames(null).includes('b-baru.md')), 'file terhapus masih tampil');
    });
    test('file non-Markdown yang ditambahkan tidak muncul', () => {
        write('gambar.png');
        write('c-baru.md');
        ok(waitFor(() => childNames(null).includes('c-baru.md')), 'file Markdown baru tidak muncul');
        ok(!childNames(null).includes('gambar.png'), 'file .png ikut tampil');
    });
    test('load() dengan path folder membuka folder, bukan error', () => {
        ft.setRoot(null);
        // Sebelum diperbaiki, ini menampilkan dialog error "Is a directory" (dan tes macet di dialog itu).
        ok(w.load(proj), 'load() gagal');
        pump();
        eq(ft.root, proj, 'root');
        eq(w.sidebar.page, 'files', 'tab sidebar');
        eq(w.file, GLib.build_filenamev([proj, 'sub', 'dalam', 'd.md']), 'file yang terbuka tidak berubah');
    });
    test('folder sebagai argumen membuka folder itu', () => {
        const w2 = new MainWindow(app, { ...DEFAULTS, welcomed: true, dark: false }, proj);
        pump();
        eq(w2.fileTree.root, proj, 'root jendela kedua');
        eq(w2.file, null, 'tidak ada file yang dibuka');
        w2.editor.buffer.set_modified(false);
        w2.win.destroy();
        pump();
    });
    test('folder terakhir dipulihkan tanpa memaksa sidebar terbuka', () => {
        const w3 = new MainWindow(app, { ...DEFAULTS, welcomed: true, dark: false, folder: proj, sidebar: false }, null);
        pump();
        eq(w3.fileTree.root, proj, 'root');
        ok(!w3.sidebar.visible, 'sidebar dipaksa terbuka');
        w3.editor.buffer.set_modified(false);
        w3.win.destroy();
        pump();
    });
    test('menutup folder mengosongkan pohon', () => {
        ft.setRoot(null);
        eq(childNames(null), [], 'baris');
    });
    buf.set_modified(false);
    w.file = null;

    section('Dokumen contoh semua format (tests/samples/semua-format.md)');
    const samplePath = GLib.build_filenamev([ROOT, 'tests', 'samples', 'semua-format.md']);
    const offsetOf = (needle: string) => {
        const t = text(), i = t.indexOf(needle);
        ok(i >= 0, `teks ${JSON.stringify(needle)} tidak ditemukan`);
        return Array.from(t.slice(0, i)).length;
    };
    test('file dibuka dan semua heading masuk outline', () => {
        ok(w.load(samplePath), 'load() gagal');
        pump();
        const names = ed.headings.map(h => h.text);
        for (const h of ['Uji Semua Format Markdown', 'Heading 6', 'Heading dengan tanda penutup', '14. Kasus sulit'])
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
            'type="checkbox"', '<blockquote>\n<p>Tingkat dua', '<pre><code class="language-bash">', '<table>', '<hr>', '<br>'])
            contains(h, tag);
        eq((h.match(/<table>/g) || []).length, 3, 'jumlah tabel');
        contains(h, '>a | b</td>');  // \\| di dalam sel menjadi |
    });
    buf.set_modified(false);

    section('Ukuran jendela');
    const settle = () => { for (let i = 0; i < 40; i++) { pump(); GLib.usleep(15000); } };
    const winWidth = () => w.win.get_size()[0];
    test('membuka file kedua tidak memperbesar jendela', () => {
        w.win.resize(1100, 700); settle();
        const before = winWidth();
        ok(w.load(samplePath), 'load() file pertama gagal'); waitImages(); settle();
        ok(w.load(GLib.build_filenamev([ROOT, 'README.md'])), 'load() file kedua gagal');
        settle();
        eq(winWidth(), before, 'lebar jendela');
    });
    test('jendela bisa diperbesar lalu diperkecil lagi', () => {
        w.win.resize(1500, 700); settle();
        eq(winWidth(), 1500, 'setelah diperbesar');
        w.win.resize(800, 700); settle();
        eq(winWidth(), 800, 'setelah diperkecil');
        ok(ed.view.get_left_margin() < 100, `margin tidak ikut mengecil (${ed.view.get_left_margin()})`);
    });
    test('gambar tidak lebih lebar dari kolom teks', () => {
        ok(w.load(samplePath), 'load() gagal'); waitImages(); settle();
        const column = ed.widget.get_allocated_width() - 2 * ed.view.get_left_margin();
        for (const block of images())
            ok(block.box.get_allocated_width() <= column, `gambar ${block.box.get_allocated_width()}px > kolom ${column}px`);
        w.win.resize(1100, 700); settle();
    });
    buf.set_modified(false);
    w.file = null;

    section('Ketahanan (mencari crash)');
    test('kursor menyapu setiap baris dokumen contoh', () => {
        setText(WELCOME);
        const n = buf.get_line_count();
        for (let i = 0; i < n; i++) { cursorTo(i); cursorTo(i, -1); }
        for (let i = n - 1; i >= 0; i--) cursorTo(i);
    });
    test('mengetik di setiap baris dokumen contoh', () => {
        const n = buf.get_line_count();
        for (let i = 0; i < n; i++) { cursorTo(i); buf.insert_at_cursor('x', -1); pump(); }
    });
    test('menghapus seluruh dokumen sedikit demi sedikit', () => {
        setText(WELCOME);
        while (buf.get_char_count() > 0) {
            const e = buf.get_end_iter(), s = e.copy();
            s.backward_chars(7);
            buf.delete(s, e);
            pump();
        }
    });
    test('mode fokus dan typewriter aktif bersamaan', () => {
        setText(WELCOME);
        action('focus'); action('typewriter');
        for (let i = 0; i < buf.get_line_count(); i++) cursorTo(i);
        action('focus'); action('typewriter');
    });

    if (opt('mouse')) {
        section('Klik mouse sungguhan (XTest)');
        const tw = ed.view.get_window(Gtk.TextWindowType.TEXT)!;
        const xtest = (window: Gdk.Window, x: number, y: number) => {
            Gdk.test_simulate_button(window, x, y, 1, 0 as Gdk.ModifierType, Gdk.EventType.BUTTON_PRESS);
            Gdk.test_simulate_button(window, x, y, 1, 0 as Gdk.ModifierType, Gdk.EventType.BUTTON_RELEASE);
            for (let k = 0; k < 8; k++) { pump(); GLib.usleep(15000); }
        };

        // Pemeriksaan awal: di sebagian lingkungan (diuji di sini: XFCE/X11) gerak pointer XTest
        // sampai, tetapi tombol mouse tidak pernah diterima GTK. Tes klik di bawah ini tidak ada
        // artinya jika klik tidak sampai, jadi dilewati dengan keterangan, bukan lulus palsu.
        setText('baris satu\n\nbaris dua'); cursorTo(0);
        w.win.present_with_time(Gdk.CURRENT_TIME);
        for (let k = 0; k < 20; k++) { pump(); GLib.usleep(15000); }
        let delivered = 0;
        const probe = ed.view.connect('button-press-event', () => { delivered++; return false; });
        xtest(tw, 200, 140);
        ed.view.disconnect(probe);

        if (!delivered) {
            print(`  ${DIM}- dilewati: XTest tidak mengirim tombol mouse ke jendela di lingkungan ini${RESET}`);
        } else {
            test('klik ganda pada gambar di editor membuka penampil', () => {
                w.file = GLib.build_filenamev([tmp, 'dok.md']);
                setText('teks\n\n![uji](gambar/uji.png)\n\nakhir'); waitImages(); cursorTo(0);
                for (let i = 0; i < 30; i++) { pump(); GLib.usleep(10000); }
                let opened = false;
                const keep = ed.onViewImage;
                ed.onViewImage = () => { opened = true; };
                // Titik 60 px di bawah tepi atas gambar (tingginya 100): tetap di dalam gambar walau klik
                // pertama menggesernya ke bawah karena sintaks gambar muncul. Posisinya diambil dari
                // widget gambarnya, bukan dari rumus, supaya tidak bergantung pada margin editor.
                const widgetWindow = ed.view.get_window(Gtk.TextWindowType.WIDGET)!;
                const picture = ed.images.blocks[0].content.get_children()[0];
                const [, px, py] = picture.translate_coordinates(ed.view, 40, 60);
                xtest(widgetWindow, px, py);
                xtest(widgetWindow, px, py);
                ed.onViewImage = keep;
                w.file = null;
                ok(opened, 'klik ganda dengan mouse tidak membuka penampil');
            });
            test('klik di seluruh area teks tidak membuat editor error', () => {
                setText(WELCOME);
                for (let y = 20; y < tw.get_height(); y += 23)
                    for (const x of [20, 250, 600]) xtest(tw, x, y);
            });
        }
    }

    const shot = optVal('screenshot');
    if (shot) {
        setText(WELCOME);
        cursorTo(0);
        ed.view.scroll_to_iter(buf.get_start_iter(), 0, false, 0, 0);
        for (let i = 0; i < 20; i++) { pump(); GLib.usleep(20000); }
        const gw = w.win.get_window()!;
        Gdk.pixbuf_get_from_window(gw, 0, 0, gw.get_width(), gw.get_height())?.savev(shot, 'png', [], []);
        print(`\n${DIM}Tangkapan layar: ${shot}${RESET}`);
    }

    buf.set_modified(false);
    w.win.destroy();
}

// ───────────────────────── Jalankan ─────────────────────────

runUnitTests();

if (!opt('no-gui')) {
    if (!Gdk.Display.get_default() && !GLib.getenv('DISPLAY') && !GLib.getenv('WAYLAND_DISPLAY')) {
        print(`\n${DIM}Tes GUI dilewati: tidak ada display.${RESET}`);
    } else {
        const app = new Gtk.Application({ application_id: 'id.eka.Nyerat.Test', flags: Gio.ApplicationFlags.NON_UNIQUE });
        app.connect('activate', () => {
            app.hold();
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                try {
                    runGuiTests(app);
                } catch (e) {
                    failed++;
                    print(`${RED}Tes GUI berhenti: ${errorMessage(e)}${RESET}\n${e instanceof Error ? e.stack : ''}`);
                }
                app.release();
                app.quit();
                return GLib.SOURCE_REMOVE;
            });
        });
        app.run([System.programInvocationName]);
    }
}

print(`\n${failed ? RED : GREEN}${passed} lulus, ${failed} gagal${RESET}`);
System.exit(failed ? 1 : 0);
