// Tes model inbox.

import { ageOf, captureItem, composeItem, deleteItem, isInbox, itemMeta, newInbox, parseInbox, serializeInbox, updateItem } from '../../src/markdown/inbox.js';
import { isKanban } from '../../src/markdown/kanban.js';
import { section, test, eq, ok } from '../framework.js';
import { INBOX } from '../fixtures.js';

export function inboxModelTests(): void {
    section('Inbox (model)');

    test('isInbox: hanya jika frontmatter memuat penanda inbox', () => {
        eq([isInbox(INBOX), isInbox('# Biasa\n\n- a'), isInbox('---\njudul: a\n---\n\n- a'), isInbox('- a\n\ninbox: true'),
            isInbox('---\nINBOX: "True"\n---'), isInbox('---\ninbox: false\n---'), isInbox('---\ninboxes: true\n---')],
            [true, false, false, false, true, false, false]);
        ok(!isKanban(INBOX), 'inbox bukan kanban');
    });
    test('parseInbox: head, item, catatan, dan outro', () => {
        const inbox = parseInbox(INBOX);
        eq(inbox.head, ['---', 'inbox: true', '---', '', '# Inbox', '', 'Tempat menangkap ide.'], 'head');
        eq(inbox.items.map(i => i.text), ['Ide SQLite #idea ➕ 2026-10-07 14:22', 'Baca artikel HIG #read #gnome ➕ 2026-10-07 13:32', 'Item tanpa waktu']);
        eq(inbox.items[0].notes, ['catatan satu', '', 'catatan dua'], 'catatan item');
        eq(inbox.outro, ['Penutup biasa'], 'outro');
    });
    test('serializeInbox(parseInbox(x)) = x untuk inbox baku', () => eq(serializeInbox(parseInbox(INBOX)), INBOX));
    test('butir daftar di frontmatter bukan item', () => {
        const text = '---\ninbox: true\ntags:\n- a\n- b\n---\n\n- satu\n';
        const inbox = parseInbox(text);
        eq(inbox.items.map(i => i.text), ['satu']);
        eq(serializeInbox(inbox), text, 'frontmatter utuh');
    });
    test('inbox baru ditulis dan dikenali lagi, tanpa item', () => {
        const text = serializeInbox(newInbox());
        ok(isInbox(text), 'tidak dikenali');
        eq(parseInbox(text).items, []);
        eq(serializeInbox(parseInbox(text)), text, 'stabil');
    });
    test('captureItem menyisipkan di atas dengan waktu tangkap, kecuali teks sudah memuatnya', () => {
        let inbox = parseInbox(INBOX);
        inbox = captureItem(inbox, '  Ide baru #x  ', new Date(2026, 9, 8, 9, 5));
        eq(inbox.items[0].text, 'Ide baru #x ➕ 2026-10-08 09:05', 'waktu lokal berformat dua digit');
        eq(inbox.items.length, 4);
        eq(captureItem(inbox, 'sudah ➕ 2026-01-01 10:00', new Date()).items[0].text, 'sudah ➕ 2026-01-01 10:00', 'tidak ditimpa');
        ok(captureItem(inbox, '   ', new Date()) === inbox, 'teks kosong diabaikan');
    });
    test('updateItem dan deleteItem tidak mengubah inbox asal', () => {
        const a = parseInbox(INBOX);
        const b = updateItem(a, 2, { text: 'Diubah' });
        eq([a.items[2].text, b.items[2].text], ['Item tanpa waktu', 'Diubah']);
        const c = deleteItem(a, 0);
        eq([a.items.length, c.items.length, c.items[0].text.startsWith('Baca')], [3, 2, true]);
    });
    test('itemMeta: judul, tag, dan waktu tangkap', () => {
        const m = itemMeta('Baca artikel HIG #read #gnome ➕ 2026-10-07 13:32');
        eq([m.title, m.tags], ['Baca artikel HIG', ['read', 'gnome']]);
        eq(m.captured?.getTime(), new Date(2026, 9, 7, 13, 32).getTime(), 'waktu');
        eq(itemMeta('Hanya tanggal ➕ 2026-10-07').captured?.getTime(), new Date(2026, 9, 7, 0, 0).getTime(), 'tanpa jam');
        eq(itemMeta('Tanpa waktu').captured, null);
    });
    test('composeItem mempertahankan waktu tangkap yang lama', () => {
        eq(composeItem(' Judul ', ['#a', 'b', ''], 'lama ➕ 2026-10-07 13:32'), 'Judul #a #b ➕ 2026-10-07 13:32');
        eq(composeItem('Judul', []), 'Judul');
    });
    test('ageOf: menit, jam, hari, lalu tanggal', () => {
        const now = new Date(2026, 9, 7, 15, 0);
        const ago = (min: number) => ageOf(new Date(now.getTime() - min * 60000), now);
        eq([ago(0), ago(10), ago(60), ago(150), ago(60 * 24 * 3), ago(60 * 24 * 8)],
            [{ unit: 'now', n: 0 }, { unit: 'minutes', n: 10 }, { unit: 'hours', n: 1 }, { unit: 'hours', n: 2 }, { unit: 'days', n: 3 }, { unit: 'date', n: 0 }]);
    });
}
