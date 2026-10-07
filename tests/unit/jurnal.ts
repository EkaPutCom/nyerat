// Tes model jurnal harian: template, catat cepat, penggabungan aktivitas, dan kejadian papan.

import {
    activityLines, addNote, agentActivity, boardEvents, clock, commitActivity, harnessActivity, journalDate, journalName,
    journalStats, mergeActivity, newJournal, parseActivity, serializeActivity, type Activity,
} from '../../src/markdown/jurnal.js';
import { parseBoard } from '../../src/markdown/kanban.js';
import { section, test, eq, ok } from '../framework.js';

const KOSONG = newJournal('Kamis, 8 Oktober 2026');
const at = (h: number, m: number) => Math.floor(new Date(2026, 9, 8, h, m).getTime() / 1000);

const PAPAN = `---
kanban: true
---

## Rencana

- [ ] Materi rilis #proyek/web
- [ ] Riset harga
- [ ] Riset harga

## Dikerjakan

- [ ] Fix checkout

## Selesai
`;

export function jurnalModelTests(): void {
    section('Jurnal (model)');

    test('nama berkas dan tanggal jurnal', () => {
        eq(journalName('2026-10-08'), 'jurnal/2026-10-08.md');
        eq(journalDate('jurnal/2026-10-08.md'), '2026-10-08');
        eq(journalDate('jurnal/catatan.md'), null);
        eq(journalDate('lain/jurnal/2026-10-08.md'), null);
    });

    test('template berisi judul tanggal dan empat bagian', () => {
        eq(KOSONG, '# Kamis, 8 Oktober 2026\n\n## Fokus hari ini\n\n## Catatan\n\n## Aktivitas\n\n## Ringkasan\n');
        eq(clock(new Date(2026, 9, 8, 9, 5)), '09:05');
    });

    test('addNote: butir berstempel jam di akhir bagian Catatan, berurutan', () => {
        let text = addNote(KOSONG, '09:12', 'Buka berkas jadi lebih cepat');
        text = addNote(text, '11:40', '! Flatpak belum bisa diuji\n  di mesin ini');
        eq(text, '# Kamis, 8 Oktober 2026\n\n## Fokus hari ini\n\n## Catatan\n\n- 09:12 Buka berkas jadi lebih cepat\n- 11:40 ! Flatpak belum bisa diuji di mesin ini\n\n## Aktivitas\n\n## Ringkasan\n');
        eq(addNote(KOSONG, '09:00', '   '), KOSONG, 'catatan kosong diabaikan');
    });

    test('addNote: bagian Catatan dibuat bila belum ada; isi lain tidak tersentuh', () => {
        eq(addNote('# Hari ini\n\nBebas menulis.\n', '08:00', 'mulai'), '# Hari ini\n\nBebas menulis.\n\n## Catatan\n\n- 08:00 mulai\n');
        eq(addNote('', '08:00', 'mulai'), '## Catatan\n\n- 08:00 mulai\n');
        // Catatan di akhir dokumen tanpa baris baru penutup, dan judul di dalam blok kode tidak dianggap bagian.
        eq(addNote('## Catatan\n\n- a\n```\n## Aktivitas\n```', '10:00', 'b'), '## Catatan\n\n- a\n```\n## Aktivitas\n```\n- 10:00 b');
    });

    test('mergeActivity: hanya menambah baris yang belum ada; suntingan pengguna tetap', () => {
        const first = mergeActivity(KOSONG, ['- 10:42 Kartu “A” → Dikerjakan', '- 16:05 Commit `dd831a6` Percepat']);
        ok(first.includes('## Aktivitas\n\n- 10:42 Kartu “A” → Dikerjakan\n- 16:05 Commit `dd831a6` Percepat\n\n## Ringkasan'), first);
        const edited = first.replace('- 10:42 Kartu “A” → Dikerjakan', '- 10:42 Kartu “A” → Dikerjakan (dibantu Rina)');
        const again = mergeActivity(edited, ['- 16:05 Commit `dd831a6` Percepat', '- 17:00 Agent mengubah [[rencana]]']);
        ok(again.includes('(dibantu Rina)\n- 16:05 Commit `dd831a6` Percepat\n- 17:00 Agent mengubah [[rencana]]\n\n## Ringkasan'), again);
        eq(mergeActivity(again, ['- 17:00 Agent mengubah [[rencana]]']), again, 'tanpa baris baru, teks sama persis');
        eq(mergeActivity(KOSONG, []), KOSONG);
    });

    test('mergeActivity: bagian Aktivitas yang dihapus dibuat lagi sebelum Ringkasan', () => {
        const text = '# J\n\n## Catatan\n\n- a\n\n## Ringkasan\n\nSelesai.\n';
        eq(mergeActivity(text, ['- 09:00 x']), '# J\n\n## Catatan\n\n- a\n\n## Aktivitas\n\n- 09:00 x\n\n## Ringkasan\n\nSelesai.\n');
    });

    test('journalStats menghitung butir Catatan dan Aktivitas', () => {
        const text = mergeActivity(addNote(addNote(KOSONG, '09:00', 'a'), '10:00', 'b'), ['- 11:00 c']);
        eq(journalStats(text), { notes: 2, activity: 1 });
        eq(journalStats('# bebas\n'), { notes: 0, activity: 0 });
    });

    test('log aktivitas: serialisasi bolak-balik, baris rusak dilewati, urut waktu', () => {
        const events: Activity[] = [
            { time: at(16, 5), kind: 'commit', text: commitActivity('dd831a6', 'Percepat\nmembuka') },
            { time: at(10, 42), kind: 'card', text: 'Kartu “A” → Dikerjakan' },
        ];
        const log = events.map(serializeActivity).join('\n') + '\n{"time": 1, "kind": "card"\n{"time":2,"kind":"lain","text":"x"}\n';
        const parsed = parseActivity(log);
        eq(parsed.length, 2, 'baris rusak/jenis asing ikut');
        eq(activityLines(parsed), ['- 10:42 Kartu “A” → Dikerjakan', '- 16:05 Commit `dd831a6` Percepat membuka']);
    });

    test('boardEvents: pindah kolom, centang selesai, dan kartu baru', () => {
        const before = parseBoard(PAPAN);
        const moved = parseBoard(PAPAN.replace('- [ ] Materi rilis #proyek/web\n', '').replace('- [ ] Fix checkout', '- [ ] Fix checkout\n- [ ] Materi rilis #proyek/web'));
        eq(boardEvents(before, moved, 'tugas.md'), ['Kartu “Materi rilis” → Dikerjakan · [[tugas]]']);
        const done = parseBoard(PAPAN.replace('- [ ] Fix checkout', '- [x] Fix checkout'));
        eq(boardEvents(before, done, 'proyek/papan.md'), ['Kartu “Fix checkout” selesai · [[proyek/papan]]']);
        const added = parseBoard(PAPAN.replace('## Selesai\n', '## Selesai\n\n- Rilis 1.0\n'));
        eq(boardEvents(before, added, 'tugas.md'), ['Kartu baru “Rilis 1.0” di Selesai · [[tugas]]']);
    });

    test('boardEvents: kartu disunting, dihapus, atau kembar tidak menghasilkan kejadian palsu', () => {
        const before = parseBoard(PAPAN);
        eq(boardEvents(before, parseBoard(PAPAN.replace('Fix checkout', 'Fix checkout v2')), 'tugas.md'), [], 'sunting teks');
        eq(boardEvents(before, parseBoard(PAPAN.replace('- [ ] Fix checkout\n', '')), 'tugas.md'), [], 'hapus kartu');
        // Salah satu dari dua kartu kembar pindah: hanya satu kejadian.
        const twin = parseBoard(PAPAN.replace('- [ ] Riset harga\n- [ ] Riset harga', '- [ ] Riset harga').replace('- [ ] Fix checkout', '- [ ] Fix checkout\n- [ ] Riset harga'));
        eq(boardEvents(before, twin, 'tugas.md'), ['Kartu “Riset harga” → Dikerjakan · [[tugas]]']);
        eq(boardEvents(before, before, 'tugas.md'), []);
    });

    test('ringkasan perubahan agent dan hasil harness', () => {
        eq(agentActivity([
            { kind: 'edit', file: 'rencana/peluncuran.md' }, { kind: 'edit', file: 'tugas.md' }, { kind: 'edit', file: 'tugas.md' },
            { kind: 'create', file: 'catatan/baru.md' }, { kind: 'delete', file: 'lama.md' }, { kind: 'move', file: 'a.md', to: 'arsip/a.md' },
        ]), 'Agent mengubah [[rencana/peluncuran]], [[tugas]]; membuat [[catatan/baru]]; membuang `lama.md`; memindah [[a]] ke [[arsip/a]]');
        eq(agentActivity([]), null);
        eq(harnessActivity('pi', 'Fix checkout', 'toko', true), 'pi selesai “Fix checkout” di proyek toko');
        eq(harnessActivity('pi', 'Fix checkout', 'toko', false), 'pi gagal “Fix checkout” di proyek toko');
    });
}
