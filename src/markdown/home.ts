// Data halaman Beranda: tenggat dari papan kanban, item inbox yang belum diproses, berkas terbaru,
// dan salam menurut jam. Murni TypeScript tanpa GTK; jendela yang membaca berkas dan pengaturan.
// Sumber kebenarannya tetap berkas Markdown, jadi tidak ada indeks atau database yang bisa basi:
// semuanya dihitung ulang setiap kali Beranda ditampilkan.

import { cardMeta, dueStatus, isKanban, parseBoard, type Board, type Card, type DueStatus, type Position } from './kanban.js';
import { isInbox, parseInbox } from './inbox.js';

export interface HomeFile {
    name: string;    // relatif terhadap folder kerja
    text: string;
}

export interface Task {
    file: string;           // nama relatif papan
    at: Position;
    card: string;           // teks kartu saat dibaca, untuk memastikan kartunya belum berubah sebelum ditulis
    box: boolean;           // kartu punya kotak centang ("- [ ]"); tanpa itu, batal centang mengembalikan butir biasa
    title: string;
    project: string | null;
    due: string;            // "YYYY-MM-DD"
    status: DueStatus;
    days: number;           // selisih hari dari hari ini; negatif = terlambat
}

// Kolom yang judulnya seperti ini berisi kartu yang sudah beres walau tanpa kotak centang.
const DONE_COLUMN = /^(selesai|done|complete(d)?|beres)$/i;
const DAY = 24 * 60 * 60 * 1000;

const daysBetween = (from: string, to: string): number =>
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

// Kartu yang belum selesai dengan tenggat terlambat, hari ini, atau dalam dua hari ke depan, urut menurut tenggat.
// projectOf menentukan nama proyek kartu (lihat cardProject di agent/harness.ts); lapisan ini tidak mengenalnya.
export function dueTasks(files: HomeFile[], today: string, projectOf: (board: Board, card: Card) => string | null = () => null): Task[] {
    const tasks: Task[] = [];
    for (const file of files) {
        if (!isKanban(file.text)) continue;
        const board = parseBoard(file.text);
        board.columns.forEach((column, c) => {
            if (DONE_COLUMN.test(column.title.trim())) return;
            column.cards.forEach((card, index) => {
                if (card.done === true) return;
                const meta = cardMeta(card.text);
                if (!meta.due) return;
                const status = dueStatus(meta.due, today);
                if (status === 'later') return;
                tasks.push({
                    file: file.name, at: { column: c, index }, card: card.text, box: card.done === false, title: meta.title,
                    project: projectOf(board, card), due: meta.due, status, days: daysBetween(today, meta.due),
                });
            });
        });
    }
    return tasks.sort((a, b) => a.due.localeCompare(b.due) || a.file.localeCompare(b.file) || a.at.column - b.at.column || a.at.index - b.at.index);
}

export interface InboxCount {
    file: string;
    open: number;    // item yang belum dicentang
}

// Inbox yang masih punya item belum diproses, yang terbanyak dulu.
export function openInboxes(files: HomeFile[]): InboxCount[] {
    return files
        .filter(f => isInbox(f.text))
        .map(f => ({ file: f.name, open: parseInbox(f.text).items.filter(i => i.done !== true).length }))
        .filter(i => i.open > 0)
        .sort((a, b) => b.open - a.open || a.file.localeCompare(b.file));
}

// ---------- Berkas terbaru ----------

export interface RecentFile {
    path: string;
    time: number;    // detik Unix saat terakhir dibuka
}

export const MAX_RECENT = 30;

// Catat path sebagai yang terakhir dibuka: pindah ke paling depan tanpa duplikat.
export function rememberRecent(list: RecentFile[], path: string, time: number, max = MAX_RECENT): RecentFile[] {
    return [{ path, time }, ...list.filter(r => r.path !== path)].slice(0, max);
}

// Ganti path setelah berkas dipindah atau folder induknya diganti nama.
export function moveRecent(list: RecentFile[], from: string, to: string): RecentFile[] {
    return list.map(r => r.path === from ? { ...r, path: to } : r.path.startsWith(`${from}/`) ? { ...r, path: to + r.path.slice(from.length) } : r);
}

const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));

export interface RecentSplit {
    resume: RecentFile[];    // kartu "Lanjutkan": berkas terakhir dari folder yang berbeda-beda
    others: RecentFile[];    // sisanya untuk daftar "Berkas terbaru"
}

// Kartu Lanjutkan mewakili tempat kerja yang berbeda (satu per folder), supaya beberapa berkas dari
// folder yang sama tidak memenuhi semua kartu. Berkas yang tidak masuk kartu tampil di daftar terbaru.
export function splitRecent(list: RecentFile[], cards = 4, rows = 6): RecentSplit {
    const resume: RecentFile[] = [];
    const folders = new Set<string>();
    for (const r of list) {
        if (resume.length >= cards) break;
        const folder = parentOf(r.path);
        if (folders.has(folder)) continue;
        folders.add(folder);
        resume.push(r);
    }
    return { resume, others: list.filter(r => !resume.includes(r)).slice(0, rows) };
}

// ---------- Salam ----------

export type DayPart = 'morning' | 'midday' | 'afternoon' | 'evening';

// Pembagian waktu sapaan bahasa Indonesia: pagi, siang, sore, malam.
export function dayPart(hour: number): DayPart {
    if (hour >= 4 && hour < 11) return 'morning';
    if (hour >= 11 && hour < 15) return 'midday';
    if (hour >= 15 && hour < 18) return 'afternoon';
    return 'evening';
}

// Tanggal lokal "YYYY-MM-DD", sama dengan format tenggat kartu.
export function localDate(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
