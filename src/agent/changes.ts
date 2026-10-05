// Perubahan berkas yang diusulkan agent. Murni TypeScript tanpa GTK: modul ini hanya memvalidasi usulan dan
// menghitung hasilnya; tidak pernah menulis apa pun. Penerapannya ke disk atau editor dilakukan jendela setelah
// pengguna menyetujui selisihnya (ui/chat.ts), jadi model tidak pernah mengubah berkas sendirian.

import { matchMention, type SourceFile } from './context.js';
import type { ToolSpec } from './provider.js';

export interface Change {
    kind: 'create' | 'edit';
    file: string;      // path relatif terhadap folder proyek
    before: string;    // isi sebelumnya ('' untuk berkas baru)
    after: string;     // isi sesudah perubahan diterapkan
    reason: string;    // alasan dari model, ditampilkan di kartu persetujuan
}

export const MAX_NEW_FILE_CHARS = 100_000;
const MARKDOWN_EXTENSION = /\.(md|markdown|mdown|mkd)$/i;

export const CHANGE_TOOLS: ToolSpec[] = [
    {
        name: 'buat_berkas',
        description: 'Usulkan berkas Markdown baru di folder kerja (mis. catatan, rencana, ringkasan riset). Tidak langsung ditulis: pengguna melihat isinya lalu menerapkan atau menolak. Gagal bila nama sudah dipakai.',
        parameters: {
            type: 'object',
            properties: {
                nama: { type: 'string', description: 'Path relatif di folder kerja, mis. "rencana/oktober.md" (folder dibuat bila perlu; berkas bertitik tidak boleh)' },
                isi: { type: 'string', description: 'Isi lengkap berkas dalam Markdown' },
                alasan: { type: 'string', description: 'Satu kalimat: untuk apa berkas ini' },
            },
            required: ['nama', 'isi', 'alasan'],
            additionalProperties: false,
        },
    },
    {
        name: 'ubah_berkas',
        description: 'Usulkan penggantian satu potongan teks di berkas yang ada. teks_lama harus persis seperti di berkas dan muncul tepat satu kali (baca dulu dengan baca_berkas; tambahkan baris di sekitarnya bila perlu). Tidak langsung ditulis: pengguna melihat selisihnya lalu menerapkan atau menolak.',
        parameters: {
            type: 'object',
            properties: {
                nama: { type: 'string', description: 'Nama berkas seperti di daftar_berkas' },
                teks_lama: { type: 'string', description: 'Teks yang diganti, persis seperti tertulis (tanpa nomor baris)' },
                teks_baru: { type: 'string', description: 'Pengganti teks_lama; kosong berarti menghapusnya' },
                alasan: { type: 'string', description: 'Satu kalimat: mengapa perubahan ini' },
            },
            required: ['nama', 'teks_lama', 'teks_baru', 'alasan'],
            additionalProperties: false,
        },
    },
];

export const isChangeTool = (name: string): boolean => CHANGE_TOOLS.some(t => t.name === name);

export type PlanResult =
    | { ok: true; change: Change }
    | { ok: false; message: string; summary: string };   // message kembali ke model; summary tampil di antarmuka

const fail = (message: string, summary: string): PlanResult => ({ ok: false, message, summary });
const asText = (v: unknown): string => typeof v === 'string' ? v : '';

// Nama berkas baru: relatif, tanpa "..", tanpa segmen bertitik (disembunyikan dari pohon dan tidak dibaca asisten).
export function cleanNewName(raw: string): string | null {
    let name = raw.trim().replace(/^\.\//, '');
    if (!name || name.startsWith('/') || name.includes('\\') || name.includes('\0')) return null;
    const parts = name.split('/');
    if (parts.some(p => !p || p === '.' || p === '..' || p.startsWith('.'))) return null;
    if (!MARKDOWN_EXTENSION.test(name)) name += '.md';
    return name;
}

// Ubah panggilan alat menjadi Change, atau pesan galat yang bisa dipakai model untuk memperbaiki usulannya.
export function planChange(name: string, rawArguments: string, files: SourceFile[]): PlanResult {
    let args: Record<string, unknown>;
    try {
        const parsed = JSON.parse(rawArguments || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bukan objek');
        args = parsed;
    } catch (e) {
        return fail('Argumen bukan JSON objek yang valid.', 'argumen tidak valid');
    }
    const reason = asText(args.alasan).trim();
    const raw = asText(args.nama);

    if (name === 'buat_berkas') {
        const file = cleanNewName(raw);
        if (!file) return fail(`Nama "${raw}" tidak valid. Pakai path relatif tanpa "..", tanpa awalan titik atau "/".`, 'nama tidak valid');
        const taken = files.find(f => f.name.toLowerCase() === file.toLowerCase());
        if (taken) return fail(`Berkas "${taken.name}" sudah ada. Pakai ubah_berkas untuk mengubahnya, atau pilih nama lain.`, 'sudah ada');
        const text = asText(args.isi);
        if (!text.trim()) return fail('Argumen "isi" wajib diisi.', 'isi kosong');
        if (text.length > MAX_NEW_FILE_CHARS) return fail('Isi terlalu panjang untuk satu berkas usulan. Pecah menjadi beberapa berkas.', 'terlalu panjang');
        return { ok: true, change: { kind: 'create', file, before: '', after: text.endsWith('\n') ? text : `${text}\n`, reason } };
    }

    if (name === 'ubah_berkas') {
        if (!raw.trim()) return fail('Argumen "nama" wajib diisi.', 'nama kosong');
        const file = matchMention(raw, files);
        if (!file) return fail(`Berkas "${raw}" tidak ditemukan. Panggil daftar_berkas untuk melihat nama yang ada, atau pakai buat_berkas untuk berkas baru.`, 'berkas tidak ada');
        const oldText = asText(args.teks_lama);
        if (!oldText) return fail('Argumen "teks_lama" wajib diisi (potongan persis yang diganti).', 'teks_lama kosong');
        const count = file.text.split(oldText).length - 1;
        if (!count) return fail(`teks_lama tidak ditemukan di ${file.name}. Baca ulang bagian itu dengan baca_berkas dan salin persis, tanpa nomor baris.`, 'teks tidak cocok');
        if (count > 1) return fail(`teks_lama muncul ${count} kali di ${file.name}. Perpanjang dengan baris di sekitarnya sampai unik.`, 'tidak unik');
        const newText = asText(args.teks_baru);
        if (newText === oldText) return fail('teks_baru sama dengan teks_lama; tidak ada yang berubah.', 'tidak ada perubahan');
        const at = file.text.indexOf(oldText);
        const after = file.text.slice(0, at) + newText + file.text.slice(at + oldText.length);
        return { ok: true, change: { kind: 'edit', file: file.name, before: file.text, after, reason } };
    }

    return fail(`Alat "${name}" tidak dikenal.`, 'alat tidak dikenal');
}

export const describeChange = (c: Change): string => `${c.kind === 'create' ? 'Berkas baru' : 'Ubah'} ${c.file}`;

// ---------- Pratinjau selisih ----------

export interface DiffLine {
    sign: ' ' | '+' | '-' | '…';
    text: string;
}

export interface DiffPreview {
    lines: DiffLine[];
    added: number;
    removed: number;
}

const CONTEXT_LINES = 2;
const MAX_PREVIEW_LINES = 60;

// Selisih per baris: awalan dan akhiran yang sama dipangkas, sisanya ditampilkan sebagai hapus lalu tambah,
// dengan beberapa baris konteks. Cukup untuk satu penggantian yang berurutan, yang memang bentuk usulan agent.
export function diffPreview(before: string, after: string): DiffPreview {
    const a = before ? before.replace(/\n$/, '').split('\n') : [];
    const b = after ? after.replace(/\n$/, '').split('\n') : [];
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

    const removed = a.slice(head, a.length - tail);
    const added = b.slice(head, b.length - tail);
    const lines: DiffLine[] = [];
    if (head > CONTEXT_LINES) lines.push({ sign: '…', text: '' });
    for (const text of a.slice(Math.max(0, head - CONTEXT_LINES), head)) lines.push({ sign: ' ', text });
    for (const text of removed) lines.push({ sign: '-', text });
    for (const text of added) lines.push({ sign: '+', text });
    for (const text of a.slice(a.length - tail, a.length - tail + CONTEXT_LINES)) lines.push({ sign: ' ', text });
    if (tail > CONTEXT_LINES) lines.push({ sign: '…', text: '' });

    if (lines.length > MAX_PREVIEW_LINES) {
        const hidden = lines.length - MAX_PREVIEW_LINES;
        lines.length = MAX_PREVIEW_LINES;
        lines.push({ sign: '…', text: `${hidden} baris lagi` });
    }
    return { lines, added: added.length, removed: removed.length };
}
