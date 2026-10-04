// Tes pengurai keluaran git.

import { parseDiff, parseLog, relativeTime } from '../../src/gitlog.js';
import { section, test, eq } from '../framework.js';

const record = (hash: string, short: string, author: string, time: number, subject: string, ...files: string[]) =>
    `\x1e${hash}\x1f${short}\x1f${author}\x1f${time}\x1f${subject}\n\n${files.join('\n')}\n`;

export function gitLogTests(): void {
    section('Riwayat git (pengurai)');
    test('log dibaca menjadi commit beserta path file', () => {
        const out = record('a'.repeat(40), 'aaaaaaa', 'Eka Putra', 1700000000, 'Ubah catatan', 'catatan/a.md')
            + record('b'.repeat(40), 'bbbbbbb', 'Eka', 1690000000, 'Buat catatan', 'a.md');
        eq(parseLog(out), [
            { hash: 'a'.repeat(40), short: 'aaaaaaa', author: 'Eka Putra', time: 1700000000, subject: 'Ubah catatan', path: 'catatan/a.md' },
            { hash: 'b'.repeat(40), short: 'bbbbbbb', author: 'Eka', time: 1690000000, subject: 'Buat catatan', path: 'a.md' },
        ]);
    });
    test('keluaran kosong tidak menghasilkan commit', () => {
        eq(parseLog(''), []);
        eq(parseLog('\n'), []);
    });
    test('path yang dikutip git tidak dipakai mentah-mentah', () => {
        eq(parseLog(record('c'.repeat(40), 'ccccccc', 'E', 1, 'x', '"a\\tb.md"'))[0].path, null);
    });
    test('pesan commit boleh memuat titik dua dan tab', () => {
        eq(parseLog(record('d'.repeat(40), 'ddddddd', 'E', 1, 'Perbaiki: a\tb', 'a.md'))[0].subject, 'Perbaiki: a\tb');
    });
    test('waktu relatif', () => {
        const now = 1_000_000_000;
        eq(relativeTime(now - 10, now), 'baru saja');
        eq(relativeTime(now - 5 * 60, now), '5 menit lalu');
        eq(relativeTime(now - 3 * 3600, now), '3 jam lalu');
        eq(relativeTime(now - 2 * 86400, now), '2 hari lalu');
        eq(relativeTime(now - 15 * 86400, now), '2 minggu lalu');
        eq(relativeTime(now - 90 * 86400, now), '3 bulan lalu');
        eq(relativeTime(now - 800 * 86400, now), '2 tahun lalu');
        eq(relativeTime(now + 500, now), 'baru saja', 'jam komputer lebih lambat dari commit');
    });
    test('diff: kepala dibuang, baris diberi jenis', () => {
        const diff = 'diff --git a/a.md b/a.md\nindex 1..2 100644\n--- a/a.md\n+++ b/a.md\n@@ -1,2 +1,2 @@\n # Judul\n-lama\n+baru\n\\ No newline at end of file\n';
        eq(parseDiff(diff), [
            { kind: 'hunk', text: '@@ -1,2 +1,2 @@' },
            { kind: 'context', text: ' # Judul' },
            { kind: 'del', text: '-lama' },
            { kind: 'add', text: '+baru' },
            { kind: 'context', text: '\\ No newline at end of file' },
        ]);
    });
    test('diff tanpa hunk (hanya ganti nama) kosong', () => {
        eq(parseDiff('diff --git a/a.md b/b.md\nsimilarity index 100%\nrename from a.md\nrename to b.md\n'), []);
        eq(parseDiff(''), []);
    });
}
