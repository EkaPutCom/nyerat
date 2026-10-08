// A conversation with the assistant as a plain Markdown file (pure, no GTK), so the history can be
// opened in the editor, searched, and diffed like a manuscript:
//
//   ---
//   title: "Contradiction in Raka's age"
//   model: deepseek-flash
//   created: 2026-10-04T14:20:00
//   ---
//
//   ## You
//   Is there a contradiction in Raka's age?
//
//   ## Assistant
//   Yes. In `chapter-01.md:12` …
//
// The assistant's own answer may contain a "## You" line; such a line gets a backslash
// in front of it when saved and the backslash is removed when read.

import { parseEvents, type ActionEvent } from './journal.js';
import type { WorkState } from './work.js';
import { parseWork } from './work.js';
import type { Turn } from './context.js';

export interface SavedChat {
    title: string;
    model: string;
    created: string;   // local ISO without a zone, e.g. 2026-10-04T14:20:00
    turns: Turn[];
    events?: ActionEvent[];
    work?: WorkState | null;
}

const HEADINGS: Record<Turn['role'], string> = { user: 'You', assistant: 'Assistant' };
const MARKER = /^(\\*)## (You|Assistant)[ \t]*$/;
const TITLE_MAX = 60;

const escapeLine = (line: string): string => MARKER.test(line) ? `\\${line}` : line;
const unescapeLine = (line: string): string => {
    const m = MARKER.exec(line);
    return m && m[1] ? line.slice(1) : line;
};

// Title from the first question: the first line, whitespace collapsed, truncated.
export function titleFrom(question: string): string {
    const first = question.trim().split('\n')[0].replace(/\s+/g, ' ').trim();
    if (!first) return 'Conversation';
    return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1).trimEnd()}…` : first;
}

// File name: date + simplified title, e.g. "2026-10-04-contradiction-in-rakas-age.md".
export function chatFileName(created: string, title: string): string {
    const slug = title.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
    return `${created.slice(0, 10)}-${slug || 'conversation'}.md`;
}

export function serializeChat(chat: SavedChat): string {
    const head = ['---', `title: ${JSON.stringify(chat.title)}`, `model: ${chat.model}`, `created: ${chat.created}`, '---'];
    if (chat.work) head.splice(4, 0, `work: ${JSON.stringify(chat.work)}`);
    if (chat.events?.length) head.splice(head.length - 1, 0, `actions: ${JSON.stringify(chat.events)}`);
    const body = chat.turns.map(t => `## ${HEADINGS[t.role]}\n${t.content.replace(/\n+$/, '').split('\n').map(escapeLine).join('\n')}`);
    return `${head.join('\n')}\n\n${body.join('\n\n')}\n`;
}

// null if it is not a conversation file (without a single turn).
export function parseChat(text: string): SavedChat | null {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const meta: Record<string, string> = {};
    let start = 0;
    if (lines[0] === '---') {
        const end = lines.indexOf('---', 1);
        if (end > 0) {
            for (const line of lines.slice(1, end)) {
                const m = /^([a-z]+):\s*(.*)$/.exec(line);
                if (m) meta[m[1]] = m[2];
            }
            start = end + 1;
        }
    }
    const turns: Turn[] = [];
    let current: { role: Turn['role']; lines: string[] } | null = null;
    const close = () => {
        if (current) turns.push({ role: current.role, content: current.lines.join('\n').replace(/^\n+|\n+$/g, '') });
    };
    for (const line of lines.slice(start)) {
        const m = MARKER.exec(line);
        if (m && !m[1]) {
            close();
            current = { role: m[2] === 'You' ? 'user' : 'assistant', lines: [] };
        } else if (current) {
            current.lines.push(unescapeLine(line));
        }
    }
    close();
    let work: WorkState | null = null;
    try {
        const a = JSON.parse(meta.work ?? 'null');
        if (a) {
            work = parseWork(JSON.stringify({ goal: a.goal, steps: a.steps.map((s: any) => ({ text: s.text, status: s.status })), note: a.note }));
            if (work && Number.isInteger(a.actionStart) && a.actionStart >= 0) work.actionStart = a.actionStart;
            if (work && a.verification && typeof a.verification.passed === 'boolean' && Array.isArray(a.verification.checks)) {
                const checks = a.verification.checks.filter((c: any) => c && typeof c.file === 'string' && typeof c.label === 'string' && typeof c.passed === 'boolean');
                if (checks.length === a.verification.checks.length) work.verification = { passed: checks.length > 0 && checks.every((c: any) => c.passed), checks };
            }
            if (work && ['running', 'paused', 'failed', 'complete'].includes(a.status)) work.status = a.status === 'running' || a.status === 'complete' && (!work.verification?.passed || !work.steps.every(s => s.status === 'done')) ? 'paused' : a.status;
        }
    } catch { /* Broken metadata does not block the conversation text. */ }
    let events: ActionEvent[] = [];
    try { events = parseEvents(JSON.parse(meta.actions ?? '[]')); } catch { /* A broken journal is skipped. */ }
    if (!turns.length && !work && !events.length) return null;
    let title = meta.title ?? '';
    try {
        if (title.startsWith('"')) title = JSON.parse(title);
    } catch (e) {
        // broken title (edited by hand): use the first question
        title = '';
    }
    return {
        title: title || titleFrom(turns.find(t => t.role === 'user')?.content ?? ''),
        model: meta.model ?? '',
        created: meta.created ?? '',
        turns,
        ...(work ? { work } : {}),
        ...(events.length ? { events } : {}),
    };
}
