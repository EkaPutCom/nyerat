// Log kegiatan agent: perekaman murni dan hasil nyata dari loop agen dengan penyedia palsu.
import { AgentTrace } from '../../src/agent/trace.js';
import { ChatSession } from '../../src/agent/session.js';
import type { ChatResult, Provider, ToolCall } from '../../src/agent/provider.js';
import { section, test, eq, ok, contains, settle } from '../framework.js';

const files = [{ name: 'a.md', text: '# A\nRilis 15 November\n' }];
const input = { question: 'Kapan rilis?', active: null, selection: '', files, mentions: [], options: { activeDocument: true, selection: true, project: true }, budget: 8000 };
const handlers = { onContext: () => {}, onText: () => {}, onReasoning: () => {} };

export function traceTests(): void {
    section('Agent: log kegiatan');
    test('penalaran dan jawaban yang mengalir disambung; alat dilengkapi dengan hasil dan lama', () => {
        let t = 0;
        const trace = new AgentTrace(() => (t += 50), () => '2026-10-05T10:00:00');
        trace.append('reasoning', 1, 'Cek ');
        trace.append('reasoning', 1, 'naskah');
        eq(trace.events.length, 1);
        eq(trace.events[0].detail, 'Cek naskah');
        trace.begin('tool', '1:x', 'Alat: baca', 'Argumen:\n{}', 1);
        eq(trace.events[1].status, 'running');
        trace.finish('tool', '1:x', 'ok', 'isi');
        eq(trace.events[1].status, 'ok');
        eq(trace.events[1].ms, 50);
        contains(trace.events[1].detail, 'isi');
        trace.finish('tool', '1:x', 'failed', 'dobel');   // tanpa pasangan: diabaikan
        eq(trace.events[1].status, 'ok');
    });
    test('detail raksasa dipotong dan log dibatasi jumlahnya', () => {
        const trace = new AgentTrace();
        trace.add('note', 'besar', 'x'.repeat(50000));
        ok(trace.events[0].detail.length < 21000, 'tidak dipotong');
        for (let i = 0; i < 2100; i++) trace.add('note', `n${i}`);
        eq(trace.events.length, 2000);
        eq(trace.jsonl().trim().split('\n').length, 2000);
    });
    test('giliran dengan alat merekam putaran, penalaran, argumen, hasil, dan token', () => {
        const session = new ChatSession();
        let n = 0;
        const call: ToolCall = { id: 'c1', name: 'cari_teks', arguments: JSON.stringify({ kueri: 'rilis' }) };
        const provider: Provider = { chat: async req => {
            req.onReasoning?.('Perlu mencari kata rilis. ');
            if (n++ === 0) return { usage: { prompt: 100, cached: 0, completion: 5 }, cancelled: false, toolCalls: [call], reasoning: 'Perlu mencari' } as ChatResult;
            req.onText('15 November.');
            return { usage: { prompt: 150, cached: 100, completion: 8 }, cancelled: false, toolCalls: [], reasoning: '' } as ChatResult;
        } };
        settle(session.ask(input, provider, 'fake', handlers));
        const events = session.trace.events;
        const kinds = events.map(e => e.kind);
        for (const k of ['turn', 'round', 'reasoning', 'tool', 'text', 'note'] as const) ok(kinds.includes(k), `tidak ada kejadian ${k}`);
        eq(events.filter(e => e.kind === 'round').length, 2);
        const tool = events.find(e => e.kind === 'tool')!;
        eq(tool.status, 'ok');
        contains(tool.detail, '"kueri": "rilis"');
        contains(tool.detail, 'Hasil untuk model');
        contains(events.find(e => e.kind === 'round')!.detail, 'cari_teks');
        contains(events.filter(e => e.kind === 'round')[1].detail, '150 masuk (100 dari cache)');
        contains(events.find(e => e.kind === 'reasoning')!.detail, 'mencari kata rilis');
        session.clear();
        eq(session.trace.events.length, 0);
    });
    test('galat provider tercatat sebagai kejadian gagal', () => {
        const session = new ChatSession();
        const provider: Provider = { chat: async () => { throw Error('koneksi putus'); } };
        let threw = false;
        try { settle(session.ask(input, provider, 'fake', handlers)); } catch { threw = true; }
        ok(threw, 'galat tidak diteruskan');
        const last = session.trace.events[session.trace.events.length - 1];
        eq(last.kind, 'error');
        contains(last.detail, 'koneksi putus');
        eq(session.trace.events.find(e => e.kind === 'round')?.status, 'failed');
    });
}
