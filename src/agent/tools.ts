// Alat yang boleh dipanggil model untuk membaca dokumen di ruang kerja sendiri (function calling). Semuanya hanya-baca dan murni:
// bekerja di atas daftar berkas yang diberikan pemanggil (bukan disk), jadi mudah diuji dan tidak bisa keluar dari proyek.
// Murni TypeScript tanpa GTK.

import { estimateTokens, matchMention, projectMap, rankChunks, splitChunks, tokenize, type SourceFile } from './context.js';
import type { ToolSpec } from './provider.js';

// Batas per panggilan; anggaran total per pertanyaan dijaga pemanggil (session.ts).
export const MAX_RESULT_TOKENS = 6000;
const MAX_SEARCH_HITS = 15;
const MAX_TEXT_MATCHES = 40;
const MAX_SNIPPET_CHARS = 900;

export const TOOLS: ToolSpec[] = [
    {
        name: 'daftar_berkas',
        description: 'Daftar semua berkas dokumen di folder kerja beserta jumlah kata dan heading-nya (kerangka isi). Pakai untuk mengetahui berkas dan bagian apa yang ada.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'cari_dokumen',
        description: 'Cari bagian dokumen yang paling relevan dengan sebuah topik atau pertanyaan (pencarian kata kunci berperingkat). Mengembalikan potongan per bagian dengan nama berkas, heading, dan nomor baris. Cocok untuk topik, keputusan, rencana, kejadian, atau gagasan.',
        parameters: {
            type: 'object',
            properties: {
                kueri: { type: 'string', description: 'Kata kunci atau kalimat pendek tentang yang dicari' },
                maks: { type: 'integer', description: `Jumlah potongan maksimal (1–${MAX_SEARCH_HITS}, bawaan 8)` },
            },
            required: ['kueri'],
            additionalProperties: false,
        },
    },
    {
        name: 'cari_teks',
        description: 'Cari kemunculan teks persis (tanpa membedakan huruf besar/kecil) di seluruh dokumen atau satu berkas, dan kembalikan baris tempatnya muncul. Cocok untuk nama, tempat, angka, tanggal, atau istilah tertentu, mis. memeriksa konsistensi.',
        parameters: {
            type: 'object',
            properties: {
                teks: { type: 'string', description: 'Teks yang dicari, persis seperti tertulis' },
                berkas: { type: 'string', description: 'Batasi ke satu berkas (opsional)' },
            },
            required: ['teks'],
            additionalProperties: false,
        },
    },
    {
        name: 'baca_berkas',
        description: 'Baca isi sebuah berkas dokumen (bisa sebagian: dari_baris sampai sampai_baris, nomor baris mulai dari 1). Hasil memuat nomor baris. Berkas panjang dipotong; lanjutkan dengan dari_baris berikutnya.',
        parameters: {
            type: 'object',
            properties: {
                nama: { type: 'string', description: 'Nama berkas seperti di daftar_berkas' },
                dari_baris: { type: 'integer', description: 'Baris awal (bawaan 1)' },
                sampai_baris: { type: 'integer', description: 'Baris akhir (bawaan: sampai habis atau batas panjang)' },
            },
            required: ['nama'],
            additionalProperties: false,
        },
    },
];

export interface ToolOutcome {
    content: string;   // dikirim kembali ke model
    summary: string;   // satu frasa singkat untuk antarmuka, mis. "5 potongan"
}

const clip = (text: string, maxTokens: number): { text: string; clipped: boolean } => {
    if (estimateTokens(text) <= maxTokens) return { text, clipped: false };
    return { text: text.slice(0, maxTokens * 3), clipped: true };
};

const asString = (v: unknown): string => typeof v === 'string' ? v.trim() : '';
const asInt = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null;

function suggest(name: string, files: SourceFile[]): string {
    const wanted = tokenize(name);
    const close = files.map(f => f.name).filter(n => wanted.some(t => tokenize(n).includes(t))).slice(0, 5);
    return close.length ? ` Mungkin maksudnya: ${close.join(', ')}.` : ' Panggil daftar_berkas untuk melihat nama yang ada.';
}

const listFiles = (files: SourceFile[]): ToolOutcome => ({
    content: files.length ? projectMap(files.map(f => ({ ...f, opened: false })), MAX_RESULT_TOKENS) : 'Belum ada berkas naskah di proyek.',
    summary: `${files.length} berkas`,
});

function searchDocuments(files: SourceFile[], args: Record<string, unknown>): ToolOutcome {
    const query = asString(args.kueri);
    if (!query) return { content: 'Argumen "kueri" wajib diisi.', summary: 'kueri kosong' };
    const limit = Math.min(Math.max(asInt(args.maks) ?? 8, 1), MAX_SEARCH_HITS);
    const terms = new Map(tokenize(query).map(t => [t, 1] as const));
    const ranked = rankChunks(files.flatMap(f => splitChunks(f.name, f.text)), terms).slice(0, limit);
    if (!ranked.length) return { content: `Tidak ada bagian naskah yang cocok dengan "${query}". Coba kata kunci lain atau cari_teks.`, summary: 'tidak ada hasil' };
    const body = ranked.map(({ chunk: c }) => {
        const text = c.text.length > MAX_SNIPPET_CHARS ? `${c.text.slice(0, MAX_SNIPPET_CHARS)} […]` : c.text;
        return `[${c.file} › ${c.heading || 'awal berkas'} · baris ${c.start + 1}–${c.end + 1}]\n${text}`;
    }).join('\n\n');
    const { text, clipped } = clip(body, MAX_RESULT_TOKENS);
    return { content: clipped ? `${text}\n[… hasil dipotong; persempit kueri …]` : text, summary: `${ranked.length} potongan` };
}

function searchText(files: SourceFile[], args: Record<string, unknown>): ToolOutcome {
    const needle = asString(args.teks);
    if (!needle) return { content: 'Argumen "teks" wajib diisi.', summary: 'teks kosong' };
    let scope = files;
    const only = asString(args.berkas);
    if (only) {
        const file = matchMention(only, files);
        if (!file) return { content: `Berkas "${only}" tidak ditemukan.${suggest(only, files)}`, summary: 'berkas tidak ada' };
        scope = [file];
    }
    const lower = needle.toLowerCase();
    const lines: string[] = [];
    let total = 0;
    for (const f of scope) {
        f.text.split('\n').forEach((line, i) => {
            if (!line.toLowerCase().includes(lower)) return;
            total++;
            if (lines.length < MAX_TEXT_MATCHES) lines.push(`${f.name}:${i + 1}: ${line.trim().slice(0, 240)}`);
        });
    }
    if (!total) return { content: `Teks "${needle}" tidak ditemukan${only ? ` di ${only}` : ''}.`, summary: 'tidak ditemukan' };
    const more = total > lines.length ? `\n[… ${total - lines.length} kemunculan lagi tidak ditampilkan; persempit dengan parameter berkas …]` : '';
    return { content: `${total} baris memuat "${needle}":\n${lines.join('\n')}${more}`, summary: `${total} baris` };
}

function readFile(files: SourceFile[], args: Record<string, unknown>): ToolOutcome {
    const name = asString(args.nama);
    if (!name) return { content: 'Argumen "nama" wajib diisi.', summary: 'nama kosong' };
    const file = matchMention(name, files);
    if (!file) return { content: `Berkas "${name}" tidak ditemukan.${suggest(name, files)}`, summary: 'berkas tidak ada' };
    const lines = file.text.split('\n');
    const from = Math.min(Math.max(asInt(args.dari_baris) ?? 1, 1), lines.length);
    const to = Math.min(Math.max(asInt(args.sampai_baris) ?? lines.length, from), lines.length);
    const out: string[] = [];
    let size = 0, last = from - 1;
    for (let i = from - 1; i < to; i++) {
        const line = `${i + 1}│ ${lines[i]}`;
        size += estimateTokens(line) + 1;
        if (size > MAX_RESULT_TOKENS && out.length) break;
        out.push(line);
        last = i + 1;
    }
    const head = `[${file.name}, baris ${from}–${last} dari ${lines.length}]`;
    const tail = last < to ? `\n[… dipotong; lanjutkan dengan dari_baris=${last + 1} …]` : '';
    return { content: `${head}\n${out.join('\n')}${tail}`, summary: `baris ${from}–${last}` };
}

// Jalankan satu panggilan. Tidak pernah melempar: galat argumen dikembalikan sebagai teks supaya model bisa memperbaikinya.
export function runTool(name: string, rawArguments: string, files: SourceFile[]): ToolOutcome {
    let args: Record<string, unknown> = {};
    if (rawArguments.trim()) {
        try {
            const parsed = JSON.parse(rawArguments);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
            else throw new Error('bukan objek');
        } catch (e) {
            return { content: 'Argumen bukan JSON objek yang valid.', summary: 'argumen tidak valid' };
        }
    }
    switch (name) {
        case 'daftar_berkas': return listFiles(files);
        case 'cari_dokumen': return searchDocuments(files, args);
        case 'cari_teks': return searchText(files, args);
        case 'baca_berkas': return readFile(files, args);
        default: return { content: `Alat "${name}" tidak dikenal. Alat yang tersedia: ${TOOLS.map(t => t.name).join(', ')}.`, summary: 'alat tidak dikenal' };
    }
}

// Frasa untuk antarmuka: apa yang sedang dikerjakan asisten.
export function describeCall(name: string, rawArguments: string): string {
    let a: Record<string, unknown> = {};
    try { a = JSON.parse(rawArguments || '{}') ?? {}; } catch (e) { /* tampilkan nama alatnya saja */ }
    switch (name) {
        case 'daftar_berkas': return 'Melihat daftar berkas';
        case 'cari_dokumen': return `Mencari “${asString(a.kueri)}”`;
        case 'cari_teks': return `Mencari teks “${asString(a.teks)}”${asString(a.berkas) ? ` di ${asString(a.berkas)}` : ''}`;
        case 'baca_berkas': return `Membaca ${asString(a.nama) || 'berkas'}${asInt(a.dari_baris) ? ` (dari baris ${asInt(a.dari_baris)})` : ''}`;
        case 'buat_berkas': return `Mengusulkan berkas baru ${asString(a.nama)}`;
        case 'ubah_berkas': return `Mengusulkan perubahan pada ${asString(a.nama)}`;
        default: return name;
    }
}
