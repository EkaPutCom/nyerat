import { TemporaryProviderError, requestWithRetry, compactHistory } from '../../src/agent/recovery.js';
import { reconcileEvents, type ActionEvent } from '../../src/agent/journal.js';
import { verifyWork } from '../../src/agent/verification.js';
import { planBatch, applyBatch } from '../../src/agent/batch.js';
import { parseWork, workText } from '../../src/agent/work.js';
import { parseChat, serializeChat } from '../../src/agent/transcript.js';
import { section, test, eq, ok, contains, settle } from '../framework.js';

export function workTests(): void {
    section('Agent: pekerjaan tersimpan');
    test('checkpoint rencana dipulihkan sebagai tertunda setelah proses berhenti', () => {
        const work = parseWork(JSON.stringify({ tujuan: 'Sinkronkan jadwal', langkah: [{ teks: 'Baca rapat', status: 'done' }, { teks: 'Ubah rencana', status: 'pending' }], catatan: 'Tanggal baru 22 November' }));
        ok(work, 'rencana ditolak');
        if (!work) return;
        const chat = parseChat(serializeChat({ title: 'Jadwal', model: 'm', created: '2026-10-05', turns: [], work }));
        eq(chat?.work?.status, 'paused');
        eq(chat?.work?.steps, work.steps);
        contains(workText(work), '[x] Baca rapat');
    });
    test('paket menggabungkan perubahan berantai dan menolak satu tindakan rusak tanpa hasil parsial', () => {
        const actions = [{ alat: 'ubah_berkas', argumen: JSON.stringify({ nama: 'a.md', teks_lama: 'lama', teks_baru: 'baru', alasan: 'jadwal' }) },
            { alat: 'ubah_berkas', argumen: JSON.stringify({ nama: 'a.md', teks_lama: 'baru', teks_baru: 'akhir', alasan: 'rapikan' }) }];
        const p = planBatch(JSON.stringify({ tindakan: actions }), [{ name: 'a.md', text: 'lama' }]);
        eq(p.changes.map(c => [c.before, c.after]), [['lama', 'akhir']]);
        actions[1].argumen = '{}';
        eq(planBatch(JSON.stringify({ tindakan: actions }), [{ name: 'a.md', text: 'lama' }]).changes, []);
    });
    test('paket preflight menolak konflik sebelum menulis dan memulihkan ketika tulis gagal', () => {
        const p = planBatch(JSON.stringify({ tindakan: ['a', 'b'].map(n => ({ alat: 'ubah_berkas', argumen: JSON.stringify({ nama: n + '.md', teks_lama: 'lama', teks_baru: 'baru', alasan: 'x' }) })) }), ['a', 'b'].map(n => ({ name: n + '.md', text: 'lama' })));
        const disk = new Map([['a.md', 'lama'], ['b.md', 'konflik']]);
        let writes = 0;
        const host = { read: (f: string) => disk.get(f) ?? null, write: (c: any) => { writes++; if (c.file === 'b.md') throw Error('disk penuh'); disk.set(c.file, c.after); }, rollback: (c: any) => { disk.set(c.file, c.before); } };
        contains(applyBatch(p.changes, host) ?? '', 'dibatalkan');
        eq(writes, 0);
        disk.set('b.md', 'lama');
        contains(applyBatch(p.changes, host) ?? '', 'dipulihkan');
        eq([...disk.values()], ['lama', 'lama']);
    });
    test('verifikasi memeriksa isi aktual, berkas hilang dan posisi/status kanban', () => {
        const files = [{ name: 'rencana.md', text: 'Rilis 22 November' }, { name: 'papan.md', text: '---\nkanban: true\n---\n\n## Selesai\n\n- [x] Materi rilis\n' }];
        const checks = [{ berkas: 'rencana.md', teks: '22 November', jenis: 'ada' }, { berkas: 'rencana.md', teks: '15 November', jenis: 'tidak_ada' }, { berkas: 'papan.md', teks: 'Materi rilis', jenis: 'kanban', daftar: 'Selesai', selesai: true }];
        eq(verifyWork(JSON.stringify({ pemeriksaan: checks }), files).passed, true);
        eq(verifyWork(JSON.stringify({ pemeriksaan: checks }), files.slice(1)).passed, false);
        checks[2].daftar = 'Rencana';
        eq(verifyWork(JSON.stringify({ pemeriksaan: checks }), files).passed, false);
        eq(verifyWork('{', files).passed, false);
    });
    test('journal menyimpan diff dan keputusan; interupsi dipulihkan dari isi aktual tanpa menulis', () => {
        const event: ActionEvent = { id: '1', question: 'Ubah jadwal', tool: 'ubah_berkas', status: 'proposed', changes: [{ kind: 'edit', file: 'a.md', before: 'lama', after: 'baru', reason: 'rapat' }], summary: '', time: '2026-10-05' };
        const saved = parseChat(serializeChat({ title: 'Jadwal', model: 'm', created: '2026-10-05', turns: [], events: [event] }));
        eq(saved?.events, [event]);
        reconcileEvents(saved!.events!, [{ name: 'a.md', text: 'baru' }]);
        eq(saved?.events?.[0].status, 'applied');
        event.status = 'proposed';
        reconcileEvents([event], [{ name: 'a.md', text: 'lama' }]);
        eq(event.status, 'interrupted');
        event.status = 'proposed';
        reconcileEvents([event], [{ name: 'a.md', text: 'konflik' }]);
        eq(event.status, 'failed');
    });
    test('retry dibatasi dan tidak mengulang keluaran yang sudah tampil', () => {
        let calls = 0;
        const request = { model: 'm', messages: [], onText: (_d: string) => {} };
        const result = { usage: null, cancelled: false, toolCalls: [], reasoning: '' };
        settle(requestWithRetry({ chat: async () => { calls++; if (calls < 3) throw new TemporaryProviderError('sementara'); return result; } }, request, async () => {}));
        eq(calls, 3);
        calls = 0;
        let failed = false;
        try { settle(requestWithRetry({ chat: async r => { calls++; r.onText('sebagian'); throw new TemporaryProviderError('putus'); } }, request, async () => {})); } catch { failed = true; }
        eq(calls, 1); eq(failed, true);
        calls = 0;
        try { settle(requestWithRetry({ chat: async () => { calls++; throw Error('key ditolak'); } }, request, async () => {})); } catch { /* diharapkan */ }
        eq(calls, 1);
    });
    test('konteks lama diringkas tanpa menghapus riwayat sumber', () => {
        const history = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, content: `Giliran ${i} ` + 'x'.repeat(500) }));
        const compact = compactHistory(history, 800);
        ok(compact.recent.length < history.length, 'tidak dipangkas');
        contains(compact.summary, 'Giliran');
        eq(history.length, 20);
        eq(compact.recent[compact.recent.length - 1], history[19]);
    });
    test('rencana rusak dan langkah tak dikenal ditolak', () => {
        eq(parseWork('{'), null);
        eq(parseWork(JSON.stringify({ tujuan: 'x', langkah: [{ teks: 'x', status: 'complete' }], catatan: '' })), null);
    });
}
