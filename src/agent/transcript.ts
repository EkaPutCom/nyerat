// Percakapan dengan asisten sebagai berkas Markdown biasa (murni, tanpa GTK), supaya riwayat bisa
// dibuka di editor, dicari, dan di-diff seperti naskah:
//
//   ---
//   judul: "Kontradiksi usia Raka"
//   model: deepseek-flash
//   dibuat: 2026-10-04T14:20:00
//   ---
//
//   ## Anda
//   Adakah kontradiksi usia Raka?
//
//   ## Asisten
//   Ya. Di `bab-01.md:12` …
//
// Jawaban asisten sendiri bisa memuat baris "## Anda"; baris seperti itu diberi garis miring terbalik
// di depannya saat disimpan dan dikembalikan saat dibaca.

import { parseEvents, type ActionEvent } from './journal.js';
import type { WorkState } from './work.js';
import { parseWork } from './work.js';
import type { Turn } from './context.js';

export interface SavedChat {
    title: string;
    model: string;
    created: string;   // ISO lokal tanpa zona, mis. 2026-10-04T14:20:00
    turns: Turn[];
    events?: ActionEvent[];
    work?: WorkState | null;
}

const HEADINGS: Record<Turn['role'], string> = { user: 'Anda', assistant: 'Asisten' };
const MARKER = /^(\\*)## (Anda|Asisten)[ \t]*$/;
const TITLE_MAX = 60;

const escapeLine = (line: string): string => MARKER.test(line) ? `\\${line}` : line;
const unescapeLine = (line: string): string => {
    const m = MARKER.exec(line);
    return m && m[1] ? line.slice(1) : line;
};

// Judul dari pertanyaan pertama: baris pertama, spasi dirapatkan, dipotong.
export function titleFrom(question: string): string {
    const first = question.trim().split('\n')[0].replace(/\s+/g, ' ').trim();
    if (!first) return 'Percakapan';
    return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1).trimEnd()}…` : first;
}

// Nama berkas: tanggal + judul yang disederhanakan, mis. "2026-10-04-kontradiksi-usia-raka.md".
export function chatFileName(created: string, title: string): string {
    const slug = title.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
    return `${created.slice(0, 10)}-${slug || 'percakapan'}.md`;
}

export function serializeChat(chat: SavedChat): string {
    const head = ['---', `judul: ${JSON.stringify(chat.title)}`, `model: ${chat.model}`, `dibuat: ${chat.created}`, '---'];
    if (chat.work) head.splice(4, 0, `pekerjaan: ${JSON.stringify(chat.work)}`);
    if (chat.events?.length) head.splice(head.length - 1, 0, `tindakan: ${JSON.stringify(chat.events)}`);
    const body = chat.turns.map(t => `## ${HEADINGS[t.role]}\n${t.content.replace(/\n+$/, '').split('\n').map(escapeLine).join('\n')}`);
    return `${head.join('\n')}\n\n${body.join('\n\n')}\n`;
}

// null jika bukan berkas percakapan (tanpa satu pun giliran).
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
            current = { role: m[2] === 'Anda' ? 'user' : 'assistant', lines: [] };
        } else if (current) {
            current.lines.push(unescapeLine(line));
        }
    }
    close();
    let work: WorkState | null = null;
    try {
        const a = JSON.parse(meta.pekerjaan ?? 'null');
        if (a) {
            work = parseWork(JSON.stringify({ tujuan: a.goal, langkah: a.steps.map((s: any) => ({ teks: s.text, status: s.status })), catatan: a.note }));
            if (work && Number.isInteger(a.actionStart) && a.actionStart >= 0) work.actionStart = a.actionStart;
            if (work && a.verification && typeof a.verification.passed === 'boolean' && Array.isArray(a.verification.checks)) {
                const checks = a.verification.checks.filter((c: any) => c && typeof c.file === 'string' && typeof c.label === 'string' && typeof c.passed === 'boolean');
                if (checks.length === a.verification.checks.length) work.verification = { passed: checks.length > 0 && checks.every((c: any) => c.passed), checks };
            }
            if (work && ['running', 'paused', 'failed', 'complete'].includes(a.status)) work.status = a.status === 'running' || a.status === 'complete' && (!work.verification?.passed || !work.steps.every(s => s.status === 'done')) ? 'paused' : a.status;
        }
    } catch { /* Metadata rusak tidak menghalangi teks percakapan. */ }
    let events: ActionEvent[] = [];
    try { events = parseEvents(JSON.parse(meta.tindakan ?? '[]')); } catch { /* Journal rusak dilewati. */ }
    if (!turns.length && !work && !events.length) return null;
    let title = meta.judul ?? '';
    try {
        if (title.startsWith('"')) title = JSON.parse(title);
    } catch (e) {
        // judul rusak (disunting tangan): pakai pertanyaan pertama
        title = '';
    }
    return {
        title: title || titleFrom(turns.find(t => t.role === 'user')?.content ?? ''),
        model: meta.model ?? '',
        created: meta.dibuat ?? '',
        turns,
        ...(work ? { work } : {}),
        ...(events.length ? { events } : {}),
    };
}
