// Tes data Beranda.

import { dayPart, dueTasks, localDate, moveRecent, openInboxes, rememberRecent, splitRecent, type RecentFile } from '../../src/markdown/home.js';
import { section, test, eq } from '../framework.js';

const BOARD = `---
kanban: true
---

## Rencana

- [ ] Terlambat @{2026-10-05}
- [ ] Hari ini #proyek/muara @{2026-10-07}
- [ ] Minggu depan @{2026-10-14}
- [ ] Tanpa tenggat
- [x] Sudah dicentang @{2026-10-07}
- Butir biasa lusa @{2026-10-09 10:00}

## Selesai

- Beres tanpa centang @{2026-10-07}
`;

const INBOX = `---
inbox: true
---

- satu
- [x] sudah diproses
- [ ] dua
`;

export function homeModelTests(): void {
    section('Beranda (model)');

    test('dueTasks: terlambat, hari ini, dan dua hari ke depan yang belum selesai, urut tenggat', () => {
        const tasks = dueTasks([{ name: 'papan.md', text: BOARD }, { name: 'catatan.md', text: '# Biasa\n\n- [ ] a @{2026-10-07}' }], '2026-10-07');
        eq(tasks.map(t => [t.title, t.status, t.days]), [['Terlambat', 'overdue', -2], ['Hari ini', 'today', 0], ['Butir biasa lusa', 'soon', 2]]);
        eq(tasks[1].at, { column: 0, index: 1 }, 'posisi kartu');
        eq(tasks[1].card, 'Hari ini #proyek/muara @{2026-10-07}', 'teks kartu asli');
        eq(tasks[0].file, 'papan.md', 'berkas papan');
    });
    test('dueTasks: nama proyek dari projectOf', () => {
        const tasks = dueTasks([{ name: 'papan.md', text: BOARD }], '2026-10-07', (_b, card) => /#proyek\/(\S+)/.exec(card.text)?.[1] ?? null);
        eq(tasks.map(t => t.project), [null, 'muara', null]);
    });
    test('openInboxes: hanya item yang belum dicentang, inbox kosong dilewati', () => {
        eq(openInboxes([{ name: 'inbox.md', text: INBOX }, { name: 'kosong.md', text: '---\ninbox: true\n---\n\n- [x] a\n' }, { name: 'papan.md', text: BOARD }]),
            [{ file: 'inbox.md', open: 2 }]);
    });
    test('rememberRecent: paling depan, tanpa duplikat, dibatasi', () => {
        let list: RecentFile[] = [];
        list = rememberRecent(list, '/a.md', 1);
        list = rememberRecent(list, '/b.md', 2);
        list = rememberRecent(list, '/a.md', 3);
        eq(list, [{ path: '/a.md', time: 3 }, { path: '/b.md', time: 2 }]);
        eq(rememberRecent(list, '/c.md', 4, 2).map(r => r.path), ['/c.md', '/a.md'], 'batas');
    });
    test('moveRecent: berkas dan isi folder yang dipindah', () => {
        const list = [{ path: '/k/a.md', time: 1 }, { path: '/k/sub/b.md', time: 2 }, { path: '/k/subx.md', time: 3 }];
        eq(moveRecent(list, '/k/sub', '/k/baru').map(r => r.path), ['/k/a.md', '/k/baru/b.md', '/k/subx.md']);
        eq(moveRecent(list, '/k/a.md', '/k/c.md')[0].path, '/k/c.md');
    });
    test('splitRecent: satu kartu per folder, sisanya ke daftar', () => {
        const at = (path: string, time: number) => ({ path, time });
        const list = [at('/k/muara/a.md', 9), at('/k/muara/b.md', 8), at('/k/nyerat/c.md', 7), at('/k/d.md', 6), at('/k/nyerat/e.md', 5)];
        const { resume, others } = splitRecent(list, 2, 2);
        eq(resume.map(r => r.path), ['/k/muara/a.md', '/k/nyerat/c.md']);
        eq(others.map(r => r.path), ['/k/muara/b.md', '/k/d.md']);
    });
    test('dayPart dan localDate', () => {
        eq([3, 4, 10, 11, 14, 15, 17, 18, 23].map(dayPart), ['evening', 'morning', 'morning', 'midday', 'midday', 'afternoon', 'afternoon', 'evening', 'evening']);
        eq(localDate(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
    });
}
