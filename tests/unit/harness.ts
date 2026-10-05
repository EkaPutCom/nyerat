// Tes orkestrasi harness eksternal (murni): penugasan kartu, proyek, prompt, pembaca JSON pi, dan antrean.

import { assignCard, cardMeta, composeCard, parseBoard, splitCard } from '../../src/markdown/kanban.js';
import { boardProject, buildPrompt, cardProject, checkProjectFolder, locateCard, PiReader, resultNote, RunQueue, stageColumn } from '../../src/agent/harness.js';
import { AgentTrace } from '../../src/agent/trace.js';
import { section, test, eq, ok, contains } from '../framework.js';

const PAPAN = `---
kanban: true
proyek: web-ecommerce
---

## Rencana

- [ ] Checkout pakai QRIS @pi #fitur
  Pakai SDK resmi.
- [ ] Tes keranjang @pi #proyek/toko-admin @{2026-10-20}

## Dikerjakan

## Review

## Selesai
`;

const lines = (...events: object[]) => events.map(e => JSON.stringify(e));

export function harnessTests(): void {
    section('Harness eksternal (model)');

    test('cardMeta: @nama adalah penugasan, bukan email atau @{tanggal}', () => {
        eq(cardMeta('Checkout QRIS @pi #fitur @{2026-10-20}'), { title: 'Checkout QRIS', tags: ['fitur'], due: '2026-10-20', agent: 'pi' });
        eq(cardMeta('Kirim ke budi@contoh.id').agent, null, 'alamat email');
        eq(cardMeta('Kirim ke budi@contoh.id').title, 'Kirim ke budi@contoh.id');
        eq(cardMeta('@pi').title, '@pi', 'teks yang hanya penugasan tetap tampil');
        eq(cardMeta('A @pi @claude').agent, 'pi', 'yang pertama dipakai');
    });

    test('assignCard dan composeCard menjaga bagian lain kartu', () => {
        eq(assignCard('Checkout #fitur @{2026-10-20}', 'pi'), 'Checkout @pi #fitur @{2026-10-20}');
        eq(assignCard('Checkout @pi #fitur', 'pi'), 'Checkout @pi #fitur', 'sudah ditugaskan');
        eq(assignCard('Checkout @pi #fitur', null), 'Checkout #fitur', 'lepas penugasan');
        eq(composeCard({ title: 'Checkout', tags: ['fitur'], due: '', agent: '@Pi' }), 'Checkout @pi #fitur');
        eq(composeCard({ title: 'Checkout', tags: [], due: '', agent: 'bukan nama!' }), 'Checkout', 'nama tidak valid dibuang');
        const parts = splitCard('Checkout @pi #fitur @{2026-10-20 09:00}');
        eq(parts, { title: 'Checkout', tags: ['fitur'], due: '2026-10-20 09:00', agent: 'pi' });
        eq(composeCard(parts), 'Checkout @pi #fitur @{2026-10-20 09:00}', 'pulang-pergi lewat dialog sunting');
    });

    test('proyek dari frontmatter papan, tag #proyek/… pada kartu menang', () => {
        const b = parseBoard(PAPAN);
        eq(boardProject(b), 'web-ecommerce');
        eq(cardProject(b, b.columns[0].cards[0]), 'web-ecommerce');
        eq(cardProject(b, b.columns[0].cards[1]), 'toko-admin');
        eq(boardProject(parseBoard('---\nkanban: true\nproyek: "toko"\n---\n\n## A\n')), 'toko', 'nilai dikutip');
        eq(boardProject(parseBoard('---\nkanban: true\n---\n\nproyek: luar\n\n## A\n')), null, 'di luar frontmatter diabaikan');
    });

    test('folder proyek tidak boleh folder kerja Nyerat, isinya, atau induknya', () => {
        eq(checkProjectFolder('/home/eka/web', '/home/eka/nyerat'), null);
        eq(checkProjectFolder('/home/eka/nyerat-lain', '/home/eka/nyerat'), null, 'awalan nama sama bukan berarti di dalam');
        ok(checkProjectFolder('/home/eka/nyerat', '/home/eka/nyerat/'), 'folder kerja sendiri');
        ok(checkProjectFolder('/home/eka/nyerat/kode', '/home/eka/nyerat'), 'di dalam folder kerja');
        ok(checkProjectFolder('/home/eka', '/home/eka/nyerat'), 'induk folder kerja');
        ok(checkProjectFolder('relatif/web', null), 'path relatif');
        ok(checkProjectFolder('/', null), 'root');
    });

    test('prompt memuat judul, catatan, tag (tanpa tag proyek), tenggat, dan batas tugas', () => {
        const b = parseBoard(PAPAN);
        const p1 = buildPrompt(b.columns[0].cards[0], 'web-ecommerce', 'papan.md');
        contains(p1, '# Checkout pakai QRIS');
        contains(p1, 'Pakai SDK resmi.');
        contains(p1, 'Tag: #fitur');
        contains(p1, 'proyek "web-ecommerce"');
        contains(p1, 'Jangan membuat commit');
        const p2 = buildPrompt(b.columns[0].cards[1], 'toko-admin', 'papan.md');
        ok(!p2.includes('#proyek/'), 'tag proyek tidak ikut prompt');
        contains(p2, 'Tenggat: 2026-10-20');
        ok(!p2.includes('@pi'), 'penugasan tidak ikut judul');
    });

    test('stageColumn dan locateCard', () => {
        const b = parseBoard(PAPAN);
        eq([stageColumn(b, 'doing'), stageColumn(b, 'review')], [1, 2]);
        eq(stageColumn(parseBoard('---\nkanban: true\n---\n\n## A\n\n## B\n'), 'review'), -1);
        eq(locateCard(b, 'Checkout pakai QRIS @pi #fitur'), { column: 0, index: 0 });
        eq(locateCard(b, 'tidak ada'), null);
        const dup = parseBoard('---\nkanban: true\n---\n\n## A\n\n- [ ] X\n- [ ] X\n');
        eq(locateCard(dup, 'X'), null, 'kartu kembar tidak dipilih sembarang');
    });

    test('PiReader: alat, jawaban, biaya, dan sesi menjadi log dan hasil', () => {
        const trace = new AgentTrace(() => 0, () => '2026-10-05T10:00:00');
        const r = new PiReader(trace);
        for (const l of lines(
            { type: 'session', version: 3, id: 'sesi-1', cwd: '/x' },
            { type: 'agent_start' },
            { type: 'turn_start' },
            { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'Cek dulu.' } },
            { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } },
            { type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', result: { content: [{ type: 'text', text: 'a.ts' }] }, isError: false },
            { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '' }], stopReason: 'toolUse', usage: { totalTokens: 100, cost: { total: 0.001 } } } },
            { type: 'turn_start' },
            { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Selesai: ' } },
            { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Selesai: ubah a.ts\nDetail lain' }], stopReason: 'stop', usage: { totalTokens: 50, cost: { total: 0.0005 } } } },
            { type: 'agent_end', messages: [], willRetry: false },
            { type: 'agent_settled' },
        )) r.line(l);
        r.line('bukan json');
        const result = r.finish(0, '');
        eq(result.ok, true);
        eq(result.summary, 'Selesai: ubah a.ts\nDetail lain');
        eq(result.sessionId, 'sesi-1');
        eq(result.tokens, 150);
        ok(Math.abs(result.cost - 0.0015) < 1e-9, `biaya ${result.cost}`);
        const tool = trace.events.find(e => e.kind === 'tool')!;
        eq([tool.title, tool.status], ['bash', 'ok']);
        contains(tool.detail, '"command": "ls"');
        contains(tool.detail, 'a.ts');
        ok(trace.events.some(e => e.kind === 'reasoning' && e.detail === 'Cek dulu.'), 'penalaran tercatat');
        ok(trace.events.some(e => e.kind === 'note' && e.detail === 'bukan json'), 'baris bukan JSON dicatat');
        contains(trace.events.find(e => e.title === 'Sesi pi dimulai')!.detail, 'pi --session sesi-1');
    });

    test('PiReader: galat model, kode keluar, dan dihentikan', () => {
        const fail = new PiReader(new AgentTrace());
        fail.line(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'kunci API tidak valid' } }));
        eq(fail.finish(1, '').error, 'kunci API tidak valid');
        eq(new PiReader(new AgentTrace()).finish(2, 'peringatan\nNo API key found\n').error, 'No API key found', 'baris stderr terakhir');
        eq(new PiReader(new AgentTrace()).finish(0, '').error, 'pi selesai tanpa jawaban');
        eq(new PiReader(new AgentTrace()).finish(143, '', true).error, 'dihentikan pengguna');
    });

    test('resultNote: satu baris ringkas', () => {
        const base = { cost: 0, tokens: 0, sessionId: null };
        eq(resultNote('pi', { ...base, ok: true, summary: '## Ringkasan\n- Ubah a.ts', error: null }, '05/10 10:00'), '↳ pi selesai 05/10 10:00: Ringkasan');
        eq(resultNote('pi', { ...base, ok: false, summary: '', error: 'galat' }, '05/10 10:00'), '↳ pi gagal 05/10 10:00: galat');
        eq(resultNote('pi', { ...base, ok: true, summary: 'Selesai.\n\n**Yang diubah:**\n- Membuat berkas baru `HALO.txt`.', error: null }, 's'), '↳ pi selesai s: Membuat berkas baru `HALO.txt`.', 'pembuka dan judul bagian dilewati');
        eq(resultNote('pi', { ...base, ok: true, summary: '1. 2 berkas diubah', error: null }, 's'), '↳ pi selesai s: 2 berkas diubah', 'angka di isi tidak dibuang');
        ok(resultNote('pi', { ...base, ok: true, summary: 'x'.repeat(400), error: null }, 's').length < 200, 'dipotong');
    });

    test('RunQueue: satu run per folder, sisanya antre berurutan', () => {
        const q = new RunQueue();
        const base = { board: '/p.md', title: 't', agent: 'pi', project: 'a', prompt: '' };
        const a = q.add({ ...base, card: 'A', folder: '/a' });
        const b = q.add({ ...base, card: 'B', folder: '/a' });
        const c = q.add({ ...base, card: 'C', folder: '/b' });
        const d = q.add({ ...base, card: 'D', folder: '/a' });
        eq([a.status, b.status, c.status, d.status], ['working', 'queued', 'working', 'queued']);
        eq(q.end(d, 'stopped'), null, 'membatalkan antrean tidak memberi giliran');
        eq(q.end(a, 'done'), b);
        eq(b.status, 'working');
        eq(q.end(b, 'failed'), null);
        eq(q.active('/p.md', 'B'), null);
        eq(q.find('/p.md', 'B')?.status, 'failed');
        const again = q.add({ ...base, card: 'B', folder: '/a' });
        eq(q.find('/p.md', 'B'), again, 'run aktif didahulukan');
    });
}
