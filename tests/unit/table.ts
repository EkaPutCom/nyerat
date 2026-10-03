// Tes model tabel Markdown.

import { fitColumns } from '../../src/editor/tablelayer.js';
import { cellMarkup } from '../../src/markdown/pango.js';
import { cellIndexAt, cellStart, deleteColumn, deleteRow, displayWidth, findTables, insertColumn, insertRow, parseTable, renderTable, setAlign, splitRow, tableEnd } from '../../src/markdown/table.js';
import { section, test, eq, ok } from '../framework.js';

export function tableTests(): void {
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
}
