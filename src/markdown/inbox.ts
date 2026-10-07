// Inbox: tempat menangkap ide, tautan, dan catatan cepat dalam file Markdown. Frontmatter
// menandai dokumen sebagai inbox:
//
//   ---
//   inbox: true
//   ---
//
//   # Inbox                          ← judul dan deskripsi (apa pun sebelum item pertama) dipertahankan
//
//   - Baca artikel GNOME HIG #read ➕ 2026-10-07 14:32
//     catatan item (diindentasi)     ← baris yang diindentasi = catatan item
//   - [x] Ide nama workbench #nyerat ➕ 2026-10-07 09:10
//
// Satu item = satu butir daftar; "➕ tanggal jam" adalah waktu tangkap (sama dengan tanda
// "dibuat" di plugin Tasks Obsidian). Item tanpa waktu tetap sah. Murni TypeScript tanpa
// GTK; semua operasi mengembalikan inbox baru.

import { cardMeta, parseColumn, trimBlankEnds, type Card } from './kanban.js';

export type InboxItem = Card;

export interface Inbox {
    head: string[];        // frontmatter, judul, dan deskripsi: semua baris sebelum item pertama
    items: InboxItem[];    // dari yang paling atas; item baru disisipkan di atas
    outro: string[];       // baris biasa setelah item terakhir, dipertahankan apa adanya
}

export const DEFAULT_HEAD = ['---', 'inbox: true', '---'];

const MARKER = /^inbox:\s*["']?(?:true|yes)["']?\s*$/i;
const ITEM = /^[-*+]\s/;
// Waktu tangkap; jam boleh tidak ada.
const CAPTURED = /\s*➕\s*(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?/;

export function isInbox(text: string): boolean {
    const lines = text.split('\n', 40);
    if (lines[0]?.trim() !== '---') return false;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === '---') return false;
        if (MARKER.test(lines[i])) return true;
    }
    return false;
}

export function parseInbox(text: string): Inbox {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    // Butir daftar di dalam frontmatter (mis. "tags:\n- a") bukan item.
    let from = 0;
    if (lines[0]?.trim() === '---') {
        const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
        from = close < 0 ? lines.length : close + 1;
    }
    const first = lines.findIndex((l, i) => i >= from && ITEM.test(l));
    if (first < 0) return { head: trimBlankEnds(lines), items: [], outro: [] };
    const column = parseColumn('', lines.slice(first));
    return { head: trimBlankEnds(lines.slice(0, first)), items: column.cards, outro: column.outro };
}

export function serializeInbox(inbox: Inbox): string {
    const out: string[] = [...(inbox.head.length ? inbox.head : DEFAULT_HEAD), ''];
    for (const item of inbox.items) {
        const box = item.done === null ? '' : item.done ? '[x] ' : '[ ] ';
        out.push(`- ${box}${item.text}`, ...item.notes.map(n => (n ? `  ${n}` : '')));
    }
    if (inbox.items.length) out.push('');
    if (inbox.outro.length) out.push(...inbox.outro, '');
    return `${trimBlankEnds(out).join('\n')}\n`;
}

export function newInbox(title = 'Inbox'): Inbox {
    return { head: [...DEFAULT_HEAD, '', `# ${title}`], items: [], outro: [] };
}

// ---------- Operasi ----------

const pad = (n: number): string => String(n).padStart(2, '0');

// "2026-10-07 14:32" untuk waktu lokal `date`.
export const stamp = (date: Date): string =>
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;

// Item baru di paling atas dengan waktu tangkap `now`. Teks sudah memuat waktu tangkap → dipakai apa adanya.
export function captureItem(inbox: Inbox, text: string, now: Date, notes: string[] = []): Inbox {
    const body = text.trim();
    if (!body) return inbox;
    const full = CAPTURED.test(body) ? body : `${body} ➕ ${stamp(now)}`;
    return { ...inbox, items: [{ done: null, text: full, notes }, ...inbox.items] };
}

export function updateItem(inbox: Inbox, index: number, patch: Partial<InboxItem>): Inbox {
    return { ...inbox, items: inbox.items.map((item, i) => (i === index ? { ...item, ...patch } : item)) };
}

export const deleteItem = (inbox: Inbox, index: number): Inbox =>
    ({ ...inbox, items: inbox.items.filter((_, i) => i !== index) });

// ---------- Isi item ----------

export interface ItemMeta {
    title: string;            // teks tanpa #tag dan waktu tangkap
    tags: string[];
    captured: Date | null;    // waktu lokal; item tanpa jam dianggap tengah malam
}

export function itemMeta(text: string): ItemMeta {
    const m = CAPTURED.exec(text);
    const meta = cardMeta(text.replace(CAPTURED, ''));
    let captured: Date | null = null;
    if (m) {
        const [y, mo, d] = m[1].split('-').map(Number);
        const [h, mi] = (m[2] ?? '0:0').split(':').map(Number);
        captured = new Date(y, mo - 1, d, h, mi);
    }
    return { title: meta.title, tags: meta.tags, captured };
}

// Susun teks item dari judul dan tag hasil sunting; waktu tangkap dari `oldText` dipertahankan.
export function composeItem(title: string, tags: string[], oldText = ''): string {
    const tagText = tags.map(t => t.replace(/^#+/, '')).filter(Boolean).map(t => `#${t}`);
    const old = CAPTURED.exec(oldText);
    const when = old ? `➕ ${old[1]}${old[2] ? ` ${old[2]}` : ''}` : '';
    return [title.trim(), ...tagText, when].filter(Boolean).join(' ');
}

export type AgeUnit = 'now' | 'minutes' | 'hours' | 'days' | 'date';
export interface Age { unit: AgeUnit; n: number }

// Usia item untuk label "10 menit lalu"; lebih dari seminggu jatuh ke tanggal.
export function ageOf(captured: Date, now: Date): Age {
    const minutes = Math.floor((now.getTime() - captured.getTime()) / 60000);
    if (minutes < 1) return { unit: 'now', n: 0 };
    if (minutes < 60) return { unit: 'minutes', n: minutes };
    if (minutes < 60 * 24) return { unit: 'hours', n: Math.floor(minutes / 60) };
    if (minutes < 60 * 24 * 7) return { unit: 'days', n: Math.floor(minutes / (60 * 24)) };
    return { unit: 'date', n: 0 };
}
