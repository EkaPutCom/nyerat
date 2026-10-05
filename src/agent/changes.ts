// Perubahan berkas yang diusulkan agent. Murni TypeScript tanpa GTK: modul ini hanya memvalidasi usulan dan
// menghitung hasilnya; tidak pernah menulis apa pun. Penerapannya ke disk atau editor dilakukan jendela setelah
// pengguna menyetujui selisihnya (ui/chat.ts), jadi model tidak pernah mengubah berkas sendirian.

import { matchMention, type SourceFile } from './context.js';
import { addCard, isKanban, moveCard, parseBoard, serializeBoard, updateCard, type Board, type Position } from '../markdown/kanban.js';
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
    {
        name: 'ubah_kanban',
        description: 'Usulkan perubahan pada papan kanban (berkas Markdown dengan "kanban: true" di frontmatter): tambah kartu ke sebuah daftar, pindahkan kartu ke daftar lain, atau tandai kartu selesai/belum. Lebih aman daripada ubah_berkas untuk papan. Tidak langsung ditulis: pengguna melihat selisihnya lalu menerapkan atau menolak.',
        parameters: {
            type: 'object',
            properties: {
                nama: { type: 'string', description: 'Nama berkas papan seperti di daftar_berkas' },
                aksi: { type: 'string', enum: ['tambah', 'pindah', 'tandai'], description: 'tambah = kartu baru di akhir daftar; pindah = pindahkan kartu ke akhir daftar lain; tandai = ubah status selesai' },
                kartu: { type: 'string', description: 'tambah: teks kartu baru (boleh memuat #tag dan @{2026-10-20}). pindah/tandai: potongan teks kartu yang ada (harus cocok dengan tepat satu kartu)' },
                daftar: { type: 'string', description: 'tambah: daftar tujuan. pindah: daftar tujuan. Nama daftar persis seperti heading di papan (huruf besar/kecil tidak dibedakan)' },
                selesai: { type: 'boolean', description: 'tandai saja: true = selesai, false = belum' },
                alasan: { type: 'string', description: 'Satu kalimat: mengapa perubahan ini' },
            },
            required: ['nama', 'aksi', 'kartu', 'alasan'],
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

    if (name === 'ubah_kanban') return planKanban(args, reason, files);

    return fail(`Alat "${name}" tidak dikenal.`, 'alat tidak dikenal');
}

// ---------- Papan kanban ----------

function planKanban(args: Record<string, unknown>, reason: string, files: SourceFile[]): PlanResult {
    const raw = asText(args.nama);
    if (!raw.trim()) return fail('Argumen "nama" wajib diisi.', 'nama kosong');
    const file = matchMention(raw, files);
    if (!file) return fail(`Berkas "${raw}" tidak ditemukan. Panggil daftar_berkas untuk melihat nama yang ada.`, 'berkas tidak ada');
    if (!isKanban(file.text)) return fail(`${file.name} bukan papan kanban (frontmatter tanpa "kanban: true"). Pakai ubah_berkas untuk berkas biasa.`, 'bukan papan');
    const board = parseBoard(file.text);
    const titles = board.columns.map(c => c.title).join(', ') || '(belum ada daftar)';
    const action = asText(args.aksi);
    const cardText = asText(args.kartu).trim();
    if (!cardText) return fail('Argumen "kartu" wajib diisi.', 'kartu kosong');

    const findColumn = (wanted: string): number | string => {
        const w = wanted.trim().toLowerCase();
        if (!w) return 'Argumen "daftar" wajib diisi.';
        const exact = board.columns.map((c, i) => c.title.toLowerCase() === w ? i : -1).filter(i => i >= 0);
        const hits = exact.length ? exact : board.columns.map((c, i) => c.title.toLowerCase().includes(w) ? i : -1).filter(i => i >= 0);
        if (hits.length === 1) return hits[0];
        return `Daftar "${wanted}" ${hits.length ? 'cocok dengan lebih dari satu daftar' : 'tidak ada'}. Daftar di papan: ${titles}.`;
    };
    const findCard = (): Position | string => {
        const w = cardText.toLowerCase();
        const hits: Position[] = [];
        board.columns.forEach((c, column) => c.cards.forEach((card, index) => { if (card.text.toLowerCase().includes(w)) hits.push({ column, index }); }));
        if (hits.length === 1) return hits[0];
        const list = hits.slice(0, 5).map(p => `"${board.columns[p.column].cards[p.index].text}" (${board.columns[p.column].title})`).join('; ');
        return hits.length ? `"${cardText}" cocok dengan ${hits.length} kartu: ${list}. Perpanjang teksnya sampai unik.` : `Tidak ada kartu yang memuat "${cardText}" di ${file.name}.`;
    };

    let next: Board;
    if (action === 'tambah') {
        const column = findColumn(asText(args.daftar));
        if (typeof column === 'string') return fail(column, 'daftar tidak cocok');
        if (cardText.includes('\n')) return fail('Teks kartu baru harus satu baris.', 'kartu tidak valid');
        next = addCard(board, column, cardText);
    } else if (action === 'pindah') {
        const from = findCard();
        if (typeof from === 'string') return fail(from, 'kartu tidak cocok');
        const column = findColumn(asText(args.daftar));
        if (typeof column === 'string') return fail(column, 'daftar tidak cocok');
        if (column === from.column) return fail('Kartu itu sudah ada di daftar tersebut.', 'tidak ada perubahan');
        next = moveCard(board, from, { column, index: Infinity });
    } else if (action === 'tandai') {
        const at = findCard();
        if (typeof at === 'string') return fail(at, 'kartu tidak cocok');
        if (typeof args.selesai !== 'boolean') return fail('Argumen "selesai" (true/false) wajib diisi untuk aksi tandai.', 'selesai kosong');
        if (board.columns[at.column].cards[at.index].done === args.selesai) return fail('Kartu itu sudah berstatus demikian.', 'tidak ada perubahan');
        next = updateCard(board, at, { done: args.selesai });
    } else {
        return fail('Argumen "aksi" harus salah satu dari: tambah, pindah, tandai.', 'aksi tidak valid');
    }
    const after = serializeBoard(next);
    if (after === file.text) return fail('Tidak ada yang berubah di papan.', 'tidak ada perubahan');
    return { ok: true, change: { kind: 'edit', file: file.name, before: file.text, after, reason } };
}

export const describeChange = (c: Change): string => `${c.kind === 'create' ? 'Berkas baru' : 'Ubah'} ${c.file}`;

// ---------- Pratinjau selisih ----------

// ---------- Diff ----------

interface Op {
    sign: ' ' | '-' | '+';
    text: string;
}

const MAX_LCS_CELLS = 4_000_000;

const splitLines = (text: string): string[] => text ? text.replace(/\n$/, '').split('\n') : [];

// Diff per baris: awalan dan akhiran yang sama dipangkas, bagian tengahnya dibandingkan dengan LCS supaya
// perubahan yang terpisah (mis. kartu kanban pindah daftar) tidak tampil sebagai satu blok hapus-tambah.
// Bagian tengah yang terlalu besar untuk LCS jatuh ke satu blok hapus lalu tambah.
function diffOps(before: string, after: string): Op[] {
    const a = splitLines(before), b = splitLines(after);
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    const ma = a.slice(head, a.length - tail), mb = b.slice(head, b.length - tail);

    const ops: Op[] = a.slice(0, head).map(text => ({ sign: ' ' as const, text }));
    const n = ma.length, m = mb.length;
    if (!n || !m || (n + 1) * (m + 1) > MAX_LCS_CELLS) {
        ops.push(...ma.map(text => ({ sign: '-' as const, text })), ...mb.map(text => ({ sign: '+' as const, text })));
    } else {
        // lcs[i][j] = panjang LCS dari ma[i..] dan mb[j..]
        const w = m + 1;
        const lcs = new Int32Array((n + 1) * w);
        for (let i = n - 1; i >= 0; i--) {
            for (let j = m - 1; j >= 0; j--) {
                lcs[i * w + j] = ma[i] === mb[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
            }
        }
        let i = 0, j = 0;
        while (i < n || j < m) {
            if (i < n && j < m && ma[i] === mb[j]) { ops.push({ sign: ' ', text: ma[i] }); i++; j++; }
            else if (i < n && (j === m || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) ops.push({ sign: '-', text: ma[i++] });   // hapus dulu, baru tambah (seperti git)
            else ops.push({ sign: '+', text: mb[j++] });
        }
    }
    ops.push(...a.slice(a.length - tail).map(text => ({ sign: ' ' as const, text })));
    return ops;
}

interface Hunk {
    oldStart: number;   // nomor baris mulai (1-based; 0 bila kosong)
    oldCount: number;
    newStart: number;
    newCount: number;
    ops: Op[];
}

// Kelompokkan perubahan menjadi hunk dengan `context` baris di sekitarnya; hunk yang berdekatan digabung.
function hunksOf(ops: Op[], context: number): Hunk[] {
    const changed = ops.map((o, i) => o.sign === ' ' ? -1 : i).filter(i => i >= 0);
    if (!changed.length) return [];
    const ranges: [number, number][] = [];
    for (const i of changed) {
        const from = Math.max(0, i - context), to = Math.min(ops.length, i + context + 1);
        const last = ranges[ranges.length - 1];
        if (last && from <= last[1]) last[1] = to;
        else ranges.push([from, to]);
    }
    return ranges.map(([from, to]) => {
        const slice = ops.slice(from, to);
        const before = ops.slice(0, from);
        const oldBefore = before.filter(o => o.sign !== '+').length, newBefore = before.filter(o => o.sign !== '-').length;
        const oldCount = slice.filter(o => o.sign !== '+').length, newCount = slice.filter(o => o.sign !== '-').length;
        return { oldStart: oldCount ? oldBefore + 1 : oldBefore, oldCount, newStart: newCount ? newBefore + 1 : newBefore, newCount, ops: slice };
    });
}

// Diff gaya git untuk jendela tinjauan: hunk dengan 3 baris konteks. Kosong bila tidak ada perbedaan.
export function unifiedDiff(before: string, after: string, context = 3): string {
    return hunksOf(diffOps(before, after), context).map(h =>
        [`@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`, ...h.ops.map(o => `${o.sign}${o.text}`)].join('\n')).join('\n');
}

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

// Ringkasan singkat: jumlah baris tambah/hapus dan baris-barisnya (konteks 2 baris, dipotong bila panjang).
export function diffPreview(before: string, after: string): DiffPreview {
    const ops = diffOps(before, after);
    const hunks = hunksOf(ops, CONTEXT_LINES);
    const lines: DiffLine[] = [];
    hunks.forEach((h, i) => {
        if (i > 0 || h.oldStart > 1) lines.push({ sign: '…', text: '' });
        lines.push(...h.ops.map(o => ({ sign: o.sign, text: o.text })));
    });
    const last = hunks[hunks.length - 1];
    if (last && last.oldStart + last.oldCount - 1 < splitLines(before).length) lines.push({ sign: '…', text: '' });
    if (lines.length > MAX_PREVIEW_LINES) {
        const hidden = lines.length - MAX_PREVIEW_LINES;
        lines.length = MAX_PREVIEW_LINES;
        lines.push({ sign: '…', text: `${hidden} baris lagi` });
    }
    return { lines, added: ops.filter(o => o.sign === '+').length, removed: ops.filter(o => o.sign === '-').length };
}
