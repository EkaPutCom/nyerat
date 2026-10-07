// Jurnal harian: satu berkas Markdown biasa per hari (jurnal/2026-10-08.md) berisi catatan pengguna
// dan aktivitas kerja hari itu.
//
//   # Kamis, 8 Oktober 2026
//
//   ## Fokus hari ini
//
//   ## Catatan
//
//   - 09:12 Iter yang dipakai ulang membuat buka berkas ~2x lebih cepat      ← catat cepat (Ctrl+Shift+J)
//
//   ## Aktivitas
//
//   - 10:42 Kartu “Materi rilis” → Dikerjakan di [[tugas]]                  ← dari log aktivitas dan git
//   - 16:05 Commit `dd831a6` Percepat membuka…
//
//   ## Ringkasan
//
// Aktivitas (kartu dipindah, perubahan agent, hasil harness) dicatat sepanjang hari ke log JSONL di
// .nyerat/aktivitas, lalu digabung ke bagian Aktivitas saat jurnal dibuka. Penggabungan hanya menambah baris
// yang belum ada, jadi suntingan pengguna di bagian itu tidak pernah tertimpa.
//
// Murni TypeScript tanpa GTK. Judul bagian adalah isi dokumen, bukan teks antarmuka, jadi tidak diterjemahkan.

import { cardMeta, type Board } from './kanban.js';

export const JOURNAL_DIR = 'jurnal';
export const NOTES = 'Catatan';
export const ACTIVITY = 'Aktivitas';
const SECTIONS = ['Fokus hari ini', NOTES, ACTIVITY, 'Ringkasan'];

// Nama relatif berkas jurnal untuk tanggal "YYYY-MM-DD".
export const journalName = (date: string): string => `${JOURNAL_DIR}/${date}.md`;

// Tanggal dari nama relatif berkas jurnal; null jika bukan berkas jurnal.
export function journalDate(name: string): string | null {
    const m = /^jurnal\/(\d{4}-\d{2}-\d{2})\.md$/.exec(name);
    return m ? m[1] : null;
}

// Isi awal jurnal. title = tanggal yang mudah dibaca, disusun pemanggil sesuai lokal.
export function newJournal(title: string): string {
    return [`# ${title}`, ...SECTIONS.flatMap(s => ['', `## ${s}`])].join('\n') + '\n';
}

// Jam lokal "HH:MM" untuk stempel baris.
export function clock(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ---------- Bagian ----------

interface Span {
    head: number;   // indeks baris judul bagian
    end: number;    // indeks baris setelah isi bagian (judul berikutnya, atau panjang dokumen)
}

const FENCE = /^\s*(```|~~~)/;
const TOP_HEADING = /^#{1,2}\s/;

// Bagian "## <heading>" (tanpa membedakan huruf besar); berakhir di judul tingkat 1–2 berikutnya. Baris di dalam blok kode dilewati.
function findSection(lines: string[], heading: string): Span | null {
    const want = heading.toLowerCase();
    let fenced = false, head = -1;
    for (let i = 0; i < lines.length; i++) {
        if (FENCE.test(lines[i])) { fenced = !fenced; continue; }
        if (fenced || !TOP_HEADING.test(lines[i])) continue;
        if (head >= 0) return { head, end: i };
        if (/^##\s/.test(lines[i]) && lines[i].slice(3).trim().toLowerCase() === want) head = i;
    }
    return head >= 0 ? { head, end: lines.length } : null;
}

// Indeks setelah baris berisi terakhir di bagian (tepat setelah judul bila bagian kosong).
function lastFilled(lines: string[], span: Span): number {
    let at = span.end;
    while (at > span.head + 1 && !lines[at - 1].trim()) at--;
    return at;
}

// Tambahkan baris ke akhir isi bagian; bagian yang belum ada dibuat. Bagian Aktivitas yang baru diletakkan
// sebelum Ringkasan supaya urutan template tetap; bagian lain di akhir dokumen.
function appendToSection(text: string, heading: string, added: string[]): string {
    if (!added.length) return text;
    const lines = text.split('\n');
    const span = findSection(lines, heading);
    if (!span) {
        const before = heading === ACTIVITY ? findSection(lines, 'Ringkasan') : null;
        const block = [`## ${heading}`, '', ...added, ''];
        if (before) {
            lines.splice(before.head, 0, ...block);
            return lines.join('\n');
        }
        const body = text.replace(/\s+$/, '');
        return `${body ? `${body}\n\n` : ''}${block.join('\n')}`;
    }
    const at = lastFilled(lines, span);
    // Bagian kosong: satu baris kosong setelah judul. Sesudahnya selalu ada satu baris kosong sebelum judul berikutnya.
    const insert = at === span.head + 1 ? ['', ...added] : added;
    const rest = lines.slice(at);
    const gap = rest.length && rest[0].trim() ? [''] : [];
    return [...lines.slice(0, at), ...insert, ...gap, ...rest].join('\n');
}

// Catat cepat: "- HH:MM teks" di akhir bagian Catatan. Baris baru di teks diganti spasi (satu catatan = satu butir).
export function addNote(text: string, time: string, note: string): string {
    const line = note.replace(/\s*\n\s*/g, ' ').trim();
    return line ? appendToSection(text, NOTES, [`- ${time} ${line}`]) : text;
}

// Tambahkan baris aktivitas yang belum ada di bagian Aktivitas (dibandingkan tanpa spasi di tepi).
export function mergeActivity(text: string, lines: string[]): string {
    const span = findSection(text.split('\n'), ACTIVITY);
    const present = new Set(span ? text.split('\n').slice(span.head + 1, span.end).map(l => l.trim()) : []);
    const seen = new Set<string>();
    const added = lines.filter(l => !present.has(l.trim()) && !seen.has(l) && seen.add(l));
    return appendToSection(text, ACTIVITY, added);
}

export interface JournalStats {
    notes: number;      // butir di bagian Catatan
    activity: number;   // butir di bagian Aktivitas
}

export function journalStats(text: string): JournalStats {
    const lines = text.split('\n');
    const count = (heading: string) => {
        const span = findSection(lines, heading);
        return span ? lines.slice(span.head + 1, span.end).filter(l => /^\s*[-*+]\s+\S/.test(l)).length : 0;
    };
    return { notes: count(NOTES), activity: count(ACTIVITY) };
}

// ---------- Aktivitas ----------

export type ActivityKind = 'card' | 'agent' | 'harness' | 'commit';

export interface Activity {
    time: number;       // detik Unix
    kind: ActivityKind;
    text: string;       // satu baris Markdown, tanpa jam
}

const KINDS = new Set<string>(['card', 'agent', 'harness', 'commit']);

// Satu baris log JSONL.
export const serializeActivity = (a: Activity): string => JSON.stringify({ time: a.time, kind: a.kind, text: a.text });

// Isi log JSONL → aktivitas. Baris rusak (mis. tulisan terpotong) dilewati.
export function parseActivity(text: string): Activity[] {
    const out: Activity[] = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
            const v = JSON.parse(line) as Partial<Activity>;
            if (typeof v.time === 'number' && typeof v.text === 'string' && v.text && typeof v.kind === 'string' && KINDS.has(v.kind))
                out.push({ time: v.time, kind: v.kind, text: v.text.replace(/\n/g, ' ') });
        } catch {
            // lewati
        }
    }
    return out;
}

// Aktivitas → baris "- HH:MM teks" urut waktu (urutan asal dipertahankan untuk waktu yang sama).
export function activityLines(events: Activity[]): string[] {
    return events
        .map((a, i) => ({ a, i }))
        .sort((x, y) => x.a.time - y.a.time || x.i - y.i)
        .map(({ a }) => `- ${clock(new Date(a.time * 1000))} ${a.text}`);
}

// Tautan [[...]] ke berkas relatif tanpa ekstensi Markdown, supaya bisa dibuka dengan Ctrl+klik dari jurnal.
export const fileLink = (name: string): string => `[[${name.replace(/\.(md|markdown|mdown|mkd)$/i, '')}]]`;

const quote = (title: string): string => `“${title.length > 80 ? `${title.slice(0, 77)}…` : title}”`;

// Perubahan papan yang layak dicatat: kartu pindah kolom, kartu dicentang selesai, dan kartu baru.
// Kartu dikenali dari teksnya; kartu yang teksnya disunting tidak dicatat (bukan kejadian kerja).
export function boardEvents(before: Board, after: Board, board: string): string[] {
    const where = new Map<string, { column: string; done: boolean | null }[]>();
    for (const column of before.columns)
        for (const card of column.cards) where.set(card.text, [...(where.get(card.text) ?? []), { column: column.title, done: card.done }]);
    const total = (b: Board) => b.columns.reduce((n, c) => n + c.cards.length, 0);
    let added = Math.max(0, total(after) - total(before));
    const link = fileLink(board);
    const events: string[] = [];
    const fresh: string[] = [];
    for (const column of after.columns) {
        for (const card of column.cards) {
            const title = quote(cardMeta(card.text).title);
            const list = where.get(card.text);
            const was = list?.find(w => w.column === column.title) ?? list?.[0];
            if (!was) {
                fresh.push(`Kartu baru ${title} di ${column.title.trim()} · ${link}`);
                continue;
            }
            list!.splice(list!.indexOf(was), 1);
            if (was.column !== column.title) events.push(`Kartu ${title} → ${column.title.trim()} · ${link}`);
            else if (was.done !== true && card.done === true) events.push(`Kartu ${title} selesai · ${link}`);
        }
    }
    // Kartu yang teksnya disunting juga tampak "baru"; hanya pertambahan jumlah kartu yang dihitung.
    for (const line of fresh.reverse()) if (added-- > 0) events.push(line);
    return events;
}

export interface ChangeSummary {
    kind: 'create' | 'edit' | 'delete' | 'move';
    file: string;
    to?: string;
}

// Perubahan agent yang diterapkan pengguna → satu baris ringkas.
export function agentActivity(changes: ChangeSummary[]): string | null {
    if (!changes.length) return null;
    const verb = (c: ChangeSummary) => c.kind === 'create' ? 'membuat' : c.kind === 'delete' ? 'membuang' : c.kind === 'move' ? 'memindah' : 'mengubah';
    const parts = new Map<string, string[]>();
    for (const c of changes) {
        const target = c.kind === 'move' && c.to ? `${fileLink(c.file)} ke ${fileLink(c.to)}` : c.kind === 'delete' ? `\`${c.file}\`` : fileLink(c.file);
        const list = parts.get(verb(c)) ?? [];
        if (!list.includes(target)) list.push(target);
        parts.set(verb(c), list);
    }
    return `Agent ${[...parts].map(([v, files]) => `${v} ${files.join(', ')}`).join('; ')}`;
}

export function commitActivity(hash: string, subject: string): string {
    return `Commit \`${hash}\` ${subject.replace(/\s+/g, ' ').trim()}`;
}

export function harnessActivity(agent: string, title: string, project: string, ok: boolean): string {
    return `${agent} ${ok ? 'selesai' : 'gagal'} ${quote(title)} di proyek ${project}`;
}
