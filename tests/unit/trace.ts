// Agent activity log: pure recording and real results from the agent loop with a fake provider.
import { AgentTrace } from '../../src/agent/trace.js';
import { ChatSession } from '../../src/agent/session.js';
import type { ChatResult, Provider, ToolCall } from '../../src/agent/provider.js';
import { section, test, eq, ok, contains, settle } from '../framework.js';

const files = [{ name: 'a.md', text: '# A\nRelease November 15\n' }];
const input = { question: 'When is the release?', active: null, selection: '', files, mentions: [], options: { activeDocument: true, selection: true, project: true }, budget: 8000 };
const handlers = { onContext: () => {}, onText: () => {}, onReasoning: () => {} };

export function traceTests(): void {
    section('Agent: activity log');
    test('streaming reasoning and answers are joined; tools are completed with a result and duration', () => {
        let t = 0;
        const trace = new AgentTrace(() => (t += 50), () => '2026-10-05T10:00:00');
        trace.append('reasoning', 1, 'Check ');
        trace.append('reasoning', 1, 'manuscript');
        eq(trace.events.length, 1);
        eq(trace.events[0].detail, 'Check manuscript');
        trace.begin('tool', '1:x', 'Tool: read', 'Arguments:\n{}', 1);
        eq(trace.events[1].status, 'running');
        trace.finish('tool', '1:x', 'ok', 'content');
        eq(trace.events[1].status, 'ok');
        eq(trace.events[1].ms, 50);
        contains(trace.events[1].detail, 'content');
        trace.finish('tool', '1:x', 'failed', 'double');   // without a pair: ignored
        eq(trace.events[1].status, 'ok');
    });
    test('a huge detail is truncated and the log is limited in count', () => {
        const trace = new AgentTrace();
        trace.add('note', 'big', 'x'.repeat(50000));
        ok(trace.events[0].detail.length < 21000, 'not truncated');
        for (let i = 0; i < 2100; i++) trace.add('note', `n${i}`);
        eq(trace.events.length, 2000);
        eq(trace.jsonl().trim().split('\n').length, 2000);
    });
    test('a turn with tools records rounds, reasoning, arguments, results, and tokens', () => {
        const session = new ChatSession();
        let n = 0;
        const call: ToolCall = { id: 'c1', name: 'search_text', arguments: JSON.stringify({ query: 'release' }) };
        const provider: Provider = { chat: async req => {
            req.onReasoning?.('Need to look up the word release. ');
            if (n++ === 0) return { usage: { prompt: 100, cached: 0, completion: 5 }, cancelled: false, toolCalls: [call], reasoning: 'Need to look up' } as ChatResult;
            req.onText('November 15.');
            return { usage: { prompt: 150, cached: 100, completion: 8 }, cancelled: false, toolCalls: [], reasoning: '' } as ChatResult;
        } };
        settle(session.ask(input, provider, 'fake', handlers));
        const events = session.trace.events;
        const kinds = events.map(e => e.kind);
        for (const k of ['turn', 'round', 'reasoning', 'tool', 'text', 'note'] as const) ok(kinds.includes(k), `no event ${k}`);
        eq(events.filter(e => e.kind === 'round').length, 2);
        const tool = events.find(e => e.kind === 'tool')!;
        eq(tool.status, 'ok');
        contains(tool.detail, '"query": "release"');
        contains(tool.detail, 'Result for the model');
        contains(events.find(e => e.kind === 'round')!.detail, 'search_text');
        contains(events.filter(e => e.kind === 'round')[1].detail, '150 in (100 from cache)');
        contains(events.find(e => e.kind === 'reasoning')!.detail, 'look up the word release');
        session.clear();
        eq(session.trace.events.length, 0);
    });
    test('a provider error is recorded as a failed event', () => {
        const session = new ChatSession();
        const provider: Provider = { chat: async () => { throw Error('connection dropped'); } };
        let threw = false;
        try { settle(session.ask(input, provider, 'fake', handlers)); } catch { threw = true; }
        ok(threw, 'the error was not propagated');
        const last = session.trace.events[session.trace.events.length - 1];
        eq(last.kind, 'error');
        contains(last.detail, 'connection dropped');
        eq(session.trace.events.find(e => e.kind === 'round')?.status, 'failed');
    });
}
