// Tes model papan kanban.

import { addCard, addColumn, cardMeta, countCards, deleteCard, deleteColumn as deleteList, dropIndex, dueStatus, isKanban, moveCard, moveColumn, newBoard, parseBoard, renameColumn, serializeBoard, toggleDone, updateCard, withDueDate, type Board } from '../../src/markdown/kanban.js';
import { section, test, eq, ok } from '../framework.js';
import { BOARD } from '../fixtures.js';

export function kanbanModelTests(): void {
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
        eq(cardMeta('Tulis laporan #penting #kerja/besar @{2026-10-20}'), { title: 'Tulis laporan', tags: ['penting', 'kerja/besar'], due: '2026-10-20', agent: null });
        eq(cardMeta('Tanpa meta'), { title: 'Tanpa meta', tags: [], due: null, agent: null });
        eq(cardMeta('http://x.y/#bagian').tags, [], 'tanda # di dalam URL bukan tag');
        eq(cardMeta('#saja').title, '#saja', 'teks yang hanya tag tetap tampil');
    });
    test('dueStatus dan dropIndex', () => {
        eq(['2026-10-01', '2026-10-03', '2026-10-05', '2026-10-09'].map(d => dueStatus(d, '2026-10-03')), ['overdue', 'today', 'soon', 'later']);
        eq([dropIndex([10, 50, 90], 0), dropIndex([10, 50, 90], 60), dropIndex([10, 50, 90], 200), dropIndex([], 5)], [0, 2, 3, 0]);
    });
    test('withDueDate mengganti tanggal tenggat dan mempertahankan jam', () => {
        eq(withDueDate('', '2026-10-20'), '2026-10-20');
        eq(withDueDate('2026-10-01', '2026-10-20'), '2026-10-20');
        eq(withDueDate(' 2026-10-01 09:30 ', '2026-10-20'), '2026-10-20 09:30', 'jam dipertahankan');
        eq(withDueDate('besok', '2026-10-20'), '2026-10-20', 'teks tidak valid diganti');
    });
}
