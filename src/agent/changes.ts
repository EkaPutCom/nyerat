// Perubahan berkas yang diusulkan agent. Murni TypeScript tanpa GTK: modul ini hanya memvalidasi usulan dan
// menghitung hasilnya; tidak pernah menulis apa pun. Penerapannya ke disk atau editor dilakukan jendela setelah
// pengguna menyetujui selisihnya (ui/chat.ts), jadi model tidak pernah mengubah berkas sendirian.

import { matchMention, type SourceFile } from './context.js';
import { addCard, addColumn, deleteCard, deleteColumn, isKanban, moveCard, parseBoard, renameColumn, serializeBoard, updateCard, type Board, type Position } from '../markdown/kanban.js';
import type { ToolSpec } from './provider.js';

export interface Change {
    kind: 'create' | 'edit' | 'delete' | 'move';
    file: string;      // path relatif terhadap folder proyek (untuk move: path asal)
    before: string;    // isi sebelumnya ('' untuk berkas baru)
    after: string;     // isi sesudah perubahan diterapkan ('' untuk hapus; sama dengan before untuk pindah)
    reason: string;    // alasan dari model, ditampilkan di kartu persetujuan
    to?: string;       // move saja: path tujuan
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
        description: 'Usulkan penggantian potongan teks di berkas yang ada. teks_lama harus persis seperti di berkas (baca dulu dengan baca_berkas). Bawaannya teks_lama harus muncul tepat satu kali (tambahkan baris di sekitarnya bila perlu); dengan semua=true setiap kemunculan diganti, mis. mengganti nama atau tanggal di seluruh berkas. Tidak langsung ditulis: pengguna melihat selisihnya lalu menerapkan atau menolak.',
        parameters: {
            type: 'object',
            properties: {
                nama: { type: 'string', description: 'Nama berkas seperti di daftar_berkas' },
                teks_lama: { type: 'string', description: 'Teks yang diganti, persis seperti tertulis (tanpa nomor baris)' },
                teks_baru: { type: 'string', description: 'Pengganti teks_lama; kosong berarti menghapusnya' },
                semua: { type: 'boolean', description: 'true = ganti semua kemunculan (bawaan false: harus tepat satu)' },
                alasan: { type: 'string', description: 'Satu kalimat: mengapa perubahan ini' },
            },
            required: ['nama', 'teks_lama', 'teks_baru', 'alasan'],
            additionalProperties: false,
        },
    },
    {
        name: 'sisip_teks',
        description: 'Usulkan penyisipan teks baru ke berkas yang ada tanpa mengganti apa pun: di awal (setelah frontmatter bila ada), di akhir, atau setelah baris tertentu. Untuk setelah_baris, isi_baris wajib berisi isi baris itu seperti hasil baca_berkas (tanpa nomor) sebagai pengaman salah hitung. Tidak langsung ditulis: pengguna melihat selisihnya lalu menerapkan atau menolak.',
        parameters: {
            type: 'object',
            properties: {
                nama: { type: 'string', description: 'Nama berkas seperti di daftar_berkas' },
                posisi: { type: 'string', enum: ['awal', 'akhir', 'setelah_baris'] },
                baris: { type: 'integer', description: 'setelah_baris saja: nomor baris (mulai 1) yang diikuti teks baru' },
                isi_baris: { type: 'string', description: 'setelah_baris saja: isi baris itu, untuk memastikan nomornya benar' },
                teks: { type: 'string', description: 'Teks Markdown yang disisipkan (satu baris atau lebih)' },
                alasan: { type: 'string', description: 'Satu kalimat: mengapa perubahan ini' },
            },
            required: ['nama', 'posisi', 'teks', 'alasan'],
            additionalProperties: false,
        },
    },
    {
        name: 'hapus_berkas',
        description: 'Usulkan membuang berkas Markdown ke Tempat Sampah (bisa dipulihkan pengguna). Hanya bila pengguna memintanya atau jelas berkas itu duplikat/usang. Tidak langsung dijalankan: pengguna melihat isinya lalu menerapkan atau menolak.',
        parameters: {
            type: 'object',
            properties: {
                nama: { type: 'string', description: 'Nama berkas seperti di daftar_berkas' },
                alasan: { type: 'string', description: 'Satu kalimat: mengapa berkas ini dibuang' },
            },
            required: ['nama', 'alasan'],
            additionalProperties: false,
        },
    },
    {
        name: 'pindah_berkas',
        description: 'Usulkan mengganti nama atau memindahkan berkas Markdown ke path lain di folder kerja (folder dibuat bila perlu). Isinya tidak berubah; tautan di berkas lain tidak ikut diperbarui, jadi usulkan perubahannya terpisah bila perlu. Gagal bila tujuan sudah ada.',
        parameters: {
            type: 'object',
            properties: {
                nama: { type: 'string', description: 'Nama berkas seperti di daftar_berkas' },
                tujuan: { type: 'string', description: 'Path relatif baru, mis. "arsip/rapat-1-okt.md"' },
                alasan: { type: 'string', description: 'Satu kalimat: mengapa dipindah' },
            },
            required: ['nama', 'tujuan', 'alasan'],
            additionalProperties: false,
        },
    },
    {
        name: 'ubah_kanban',
        description: 'Usulkan perubahan pada papan kanban (berkas Markdown dengan "kanban: true" di frontmatter). Lebih aman daripada ubah_berkas untuk papan. Aksi kartu: tambah, pindah, tandai (selesai/belum), ubah (ganti teks kartu), hapus. Aksi daftar: tambah_daftar, ganti_nama_daftar, hapus_daftar (hanya daftar kosong). Tidak langsung ditulis: pengguna melihat selisihnya lalu menerapkan atau menolak.',
        parameters: {
            type: 'object',
            properties: {
                nama: { type: 'string', description: 'Nama berkas papan seperti di daftar_berkas' },
                aksi: { type: 'string', enum: ['tambah', 'pindah', 'tandai', 'ubah', 'hapus', 'tambah_daftar', 'ganti_nama_daftar', 'hapus_daftar'], description: 'tambah = kartu baru di akhir daftar; pindah = pindahkan kartu ke akhir daftar lain; tandai = ubah status selesai; ubah = ganti teks kartu dengan teks_baru; hapus = buang kartu; tambah_daftar/ganti_nama_daftar/hapus_daftar = kelola daftar' },
                kartu: { type: 'string', description: 'tambah: teks kartu baru (boleh memuat #tag dan @{2026-10-20}). pindah/tandai/ubah/hapus: potongan teks kartu yang ada (harus cocok dengan tepat satu kartu). Tidak dipakai untuk aksi daftar' },
                daftar: { type: 'string', description: 'tambah/pindah: daftar tujuan. tambah_daftar: nama daftar baru. ganti_nama_daftar/hapus_daftar: daftar yang ada. Nama persis seperti heading di papan (huruf besar/kecil tidak dibedakan)' },
                teks_baru: { type: 'string', description: 'ubah: teks kartu pengganti. ganti_nama_daftar: nama daftar baru' },
                selesai: { type: 'boolean', description: 'tandai saja: true = selesai, false = belum' },
                alasan: { type: 'string', description: 'Satu kalimat: mengapa perubahan ini' },
            },
            required: ['nama', 'aksi', 'alasan'],
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

    if (!isChangeTool(name)) return fail(`Alat "${name}" tidak dikenal.`, 'alat tidak dikenal');
    if (!raw.trim()) return fail('Argumen "nama" wajib diisi.', 'nama kosong');
    const file = matchMention(raw, files);
    if (!file) return fail(`Berkas "${raw}" tidak ditemukan. Panggil daftar_berkas untuk melihat nama yang ada${name === 'ubah_berkas' || name === 'sisip_teks' ? ', atau pakai buat_berkas untuk berkas baru' : ''}.`, 'berkas tidak ada');
    const edit = (after: string): PlanResult => after === file.text
        ? fail('Tidak ada yang berubah.', 'tidak ada perubahan')
        : { ok: true, change: { kind: 'edit', file: file.name, before: file.text, after, reason } };

    if (name === 'ubah_berkas') {
        const oldText = asText(args.teks_lama);
        if (!oldText) return fail('Argumen "teks_lama" wajib diisi (potongan persis yang diganti).', 'teks_lama kosong');
        const count = file.text.split(oldText).length - 1;
        if (!count) return fail(`teks_lama tidak ditemukan di ${file.name}. Baca ulang bagian itu dengan baca_berkas dan salin persis, tanpa nomor baris.`, 'teks tidak cocok');
        const all = args.semua === true;
        if (count > 1 && !all) return fail(`teks_lama muncul ${count} kali di ${file.name}. Perpanjang dengan baris di sekitarnya sampai unik, atau pakai semua=true bila setiap kemunculan memang harus diganti.`, 'tidak unik');
        const newText = asText(args.teks_baru);
        if (newText === oldText) return fail('teks_baru sama dengan teks_lama; tidak ada yang berubah.', 'tidak ada perubahan');
        if (all) return edit(file.text.split(oldText).join(newText));
        const at = file.text.indexOf(oldText);
        return edit(file.text.slice(0, at) + newText + file.text.slice(at + oldText.length));
    }

    if (name === 'sisip_teks') {
        const text = asText(args.teks).replace(/\n+$/, '');
        if (!text.trim()) return fail('Argumen "teks" wajib diisi.', 'teks kosong');
        const lines = file.text ? file.text.split('\n') : [];
        // Baris kosong terakhir hanyalah penutup berkas, bukan baris yang bisa diikuti.
        const count = file.text.endsWith('\n') ? lines.length - 1 : lines.length;
        // Berkas tanpa baris baru di akhir mendapatkannya hanya bila teks ditambahkan di ujungnya.
        const insertAt = (index: number): PlanResult => edit([...lines.slice(0, index), ...text.split('\n'), ...lines.slice(index)].join('\n') + (index === count && count === lines.length ? '\n' : ''));
        const position = asText(args.posisi);
        if (position === 'awal') {
            const front = /^---\n[\s\S]*?\n---(?:\n|$)/.exec(file.text);
            return insertAt(front ? front[0].replace(/\n$/, '').split('\n').length : 0);
        }
        if (position === 'akhir') return insertAt(count);
        if (position === 'setelah_baris') {
            const line = typeof args.baris === 'number' && Number.isInteger(args.baris) ? args.baris : 0;
            if (line < 1 || line > count) return fail(`Argumen "baris" harus 1–${count} untuk ${file.name}.`, 'baris tidak valid');
            if (typeof args.isi_baris !== 'string') return fail('Argumen "isi_baris" wajib diisi untuk setelah_baris: salin isi baris itu dari baca_berkas.', 'isi_baris kosong');
            const actual = lines[line - 1];
            if (actual.trim() !== args.isi_baris.trim()) {
                const near = lines.map((l, i) => l.trim() === (args.isi_baris as string).trim() ? i + 1 : 0).filter(n => n).slice(0, 5);
                return fail(`Baris ${line} di ${file.name} berisi "${actual.slice(0, 200)}", bukan isi_baris.${near.length ? ` isi_baris ada di baris ${near.join(', ')}.` : ' Baca ulang berkasnya dengan baca_berkas.'}`, 'baris tidak cocok');
            }
            return insertAt(line);
        }
        return fail('Argumen "posisi" harus salah satu dari: awal, akhir, setelah_baris.', 'posisi tidak valid');
    }

    if (name === 'hapus_berkas') return { ok: true, change: { kind: 'delete', file: file.name, before: file.text, after: '', reason } };

    if (name === 'pindah_berkas') {
        const rawTarget = asText(args.tujuan);
        const to = cleanNewName(rawTarget);
        if (!to) return fail(`Tujuan "${rawTarget}" tidak valid. Pakai path relatif tanpa "..", tanpa awalan titik atau "/".`, 'tujuan tidak valid');
        if (to === file.name) return fail('Tujuan sama dengan nama sekarang.', 'tidak ada perubahan');
        const taken = files.find(f => f.name.toLowerCase() === to.toLowerCase() && f !== file);
        if (taken) return fail(`Berkas "${taken.name}" sudah ada; pilih tujuan lain.`, 'tujuan sudah ada');
        return { ok: true, change: { kind: 'move', file: file.name, to, before: file.text, after: file.text, reason } };
    }

    return planKanban(args, reason, file);
}

// ---------- Papan kanban ----------

function planKanban(args: Record<string, unknown>, reason: string, file: SourceFile): PlanResult {
    if (!isKanban(file.text)) return fail(`${file.name} bukan papan kanban (frontmatter tanpa "kanban: true"). Pakai ubah_berkas untuk berkas biasa.`, 'bukan papan');
    const board = parseBoard(file.text);
    const titles = board.columns.map(c => c.title).join(', ') || '(belum ada daftar)';
    const action = asText(args.aksi);
    const cardText = asText(args.kartu).trim();
    const newText = asText(args.teks_baru).trim();
    const listName = asText(args.daftar);

    const findColumn = (wanted: string): number | string => {
        const w = wanted.trim().toLowerCase();
        if (!w) return 'Argumen "daftar" wajib diisi.';
        const exact = board.columns.map((c, i) => c.title.toLowerCase() === w ? i : -1).filter(i => i >= 0);
        const hits = exact.length ? exact : board.columns.map((c, i) => c.title.toLowerCase().includes(w) ? i : -1).filter(i => i >= 0);
        if (hits.length === 1) return hits[0];
        return `Daftar "${wanted}" ${hits.length ? 'cocok dengan lebih dari satu daftar' : 'tidak ada'}. Daftar di papan: ${titles}.`;
    };
    const findCard = (): Position | string => {
        if (!cardText) return 'Argumen "kartu" wajib diisi.';
        const w = cardText.toLowerCase();
        const hits: Position[] = [];
        board.columns.forEach((c, column) => c.cards.forEach((card, index) => { if (card.text.toLowerCase().includes(w)) hits.push({ column, index }); }));
        if (hits.length === 1) return hits[0];
        const list = hits.slice(0, 5).map(p => `"${board.columns[p.column].cards[p.index].text}" (${board.columns[p.column].title})`).join('; ');
        return hits.length ? `"${cardText}" cocok dengan ${hits.length} kartu: ${list}. Perpanjang teksnya sampai unik.` : `Tidak ada kartu yang memuat "${cardText}" di ${file.name}.`;
    };

    let next: Board;
    if (action === 'tambah') {
        if (!cardText) return fail('Argumen "kartu" wajib diisi.', 'kartu kosong');
        const column = findColumn(listName);
        if (typeof column === 'string') return fail(column, 'daftar tidak cocok');
        if (cardText.includes('\n')) return fail('Teks kartu baru harus satu baris.', 'kartu tidak valid');
        next = addCard(board, column, cardText);
    } else if (action === 'pindah') {
        const from = findCard();
        if (typeof from === 'string') return fail(from, 'kartu tidak cocok');
        const column = findColumn(listName);
        if (typeof column === 'string') return fail(column, 'daftar tidak cocok');
        if (column === from.column) return fail('Kartu itu sudah ada di daftar tersebut.', 'tidak ada perubahan');
        next = moveCard(board, from, { column, index: Infinity });
    } else if (action === 'tandai') {
        const at = findCard();
        if (typeof at === 'string') return fail(at, 'kartu tidak cocok');
        if (typeof args.selesai !== 'boolean') return fail('Argumen "selesai" (true/false) wajib diisi untuk aksi tandai.', 'selesai kosong');
        if (board.columns[at.column].cards[at.index].done === args.selesai) return fail('Kartu itu sudah berstatus demikian.', 'tidak ada perubahan');
        next = updateCard(board, at, { done: args.selesai });
    } else if (action === 'ubah') {
        const at = findCard();
        if (typeof at === 'string') return fail(at, 'kartu tidak cocok');
        if (!newText || newText.includes('\n')) return fail('Argumen "teks_baru" wajib diisi dan harus satu baris.', 'teks_baru tidak valid');
        next = updateCard(board, at, { text: newText });
    } else if (action === 'hapus') {
        const at = findCard();
        if (typeof at === 'string') return fail(at, 'kartu tidak cocok');
        next = deleteCard(board, at);
    } else if (action === 'tambah_daftar') {
        const title = listName.trim();
        if (!title || title.includes('\n')) return fail('Argumen "daftar" wajib diisi dengan nama daftar baru (satu baris).', 'daftar kosong');
        if (board.columns.some(c => c.title.toLowerCase() === title.toLowerCase())) return fail(`Daftar "${title}" sudah ada. Daftar di papan: ${titles}.`, 'daftar sudah ada');
        next = addColumn(board, title);
    } else if (action === 'ganti_nama_daftar') {
        const column = findColumn(listName);
        if (typeof column === 'string') return fail(column, 'daftar tidak cocok');
        if (!newText || newText.includes('\n')) return fail('Argumen "teks_baru" wajib diisi dengan nama daftar baru (satu baris).', 'teks_baru tidak valid');
        if (board.columns.some((c, i) => i !== column && c.title.toLowerCase() === newText.toLowerCase())) return fail(`Daftar "${newText}" sudah ada.`, 'daftar sudah ada');
        next = renameColumn(board, column, newText);
    } else if (action === 'hapus_daftar') {
        const column = findColumn(listName);
        if (typeof column === 'string') return fail(column, 'daftar tidak cocok');
        // Kartu tidak boleh ikut hilang diam-diam bersama daftarnya.
        const cards = board.columns[column].cards.length;
        if (cards) return fail(`Daftar "${board.columns[column].title}" masih berisi ${cards} kartu. Pindahkan atau hapus kartunya dulu.`, 'daftar tidak kosong');
        next = deleteColumn(board, column);
    } else {
        return fail('Argumen "aksi" harus salah satu dari: tambah, pindah, tandai, ubah, hapus, tambah_daftar, ganti_nama_daftar, hapus_daftar.', 'aksi tidak valid');
    }
    const after = serializeBoard(next);
    if (after === file.text) return fail('Tidak ada yang berubah di papan.', 'tidak ada perubahan');
    return { ok: true, change: { kind: 'edit', file: file.name, before: file.text, after, reason } };
}

export function describeChange(c: Change): string {
    switch (c.kind) {
        case 'create': return `Berkas baru ${c.file}`;
        case 'delete': return `Hapus ${c.file}`;
        case 'move': return `Pindah ${c.file} → ${c.to}`;
        default: return `Ubah ${c.file}`;
    }
}

// ---------- Keadaan berkas terhadap usulan ----------

// Path yang disentuh perubahan; pindah menyentuh asal dan tujuan.
export const changeFiles = (c: Change): string[] => c.kind === 'move' && c.to ? [c.file, c.to] : [c.file];

// Terapkan perubahan ke daftar berkas di memori (salinan naskah agent); tidak menyentuh disk.
export function applyToFiles(files: SourceFile[], c: Change): void {
    const index = files.findIndex(f => f.name === c.file);
    if (c.kind === 'delete' || c.kind === 'move') {
        if (index >= 0) files.splice(index, 1);
        if (c.kind === 'move' && c.to) files.push({ name: c.to, text: c.after });
    } else if (index >= 0) files[index].text = c.after;
    else files.push({ name: c.file, text: c.after });
}

// Kebalikan perubahan yang sudah diterapkan, untuk tombol Urungkan. Penerapannya tetap lewat preflight yang sama.
export function invertChange(c: Change): Change {
    const reason = `Urungkan: ${c.reason}`;
    switch (c.kind) {
        case 'create': return { kind: 'delete', file: c.file, before: c.after, after: '', reason };
        case 'delete': return { kind: 'create', file: c.file, before: '', after: c.before, reason };
        case 'move': return { kind: 'move', file: c.to ?? c.file, to: c.file, before: c.after, after: c.before, reason };
        default: return { kind: 'edit', file: c.file, before: c.after, after: c.before, reason };
    }
}

type Reader = (file: string) => string | null;   // null = berkas tidak ada

// Apakah isi aktual sama dengan keadaan sebelum atau sesudah perubahan.
export function changeState(c: Change, read: Reader): 'before' | 'after' | 'other' {
    const at = read(c.file);
    switch (c.kind) {
        case 'create': return at === c.after ? 'after' : at === null ? 'before' : 'other';
        case 'delete': return at === null ? 'after' : at === c.before ? 'before' : 'other';
        case 'move': {
            const target = c.to ? read(c.to) : null;
            if (at === null && target === c.after) return 'after';
            return at === c.before && target === null ? 'before' : 'other';
        }
        default: return at === c.after ? 'after' : at === c.before ? 'before' : 'other';
    }
}

// Pesan galat bila perubahan tidak lagi bisa diterapkan dengan aman (isi berubah sejak diusulkan), atau null.
export function preflight(c: Change, read: Reader): string | null {
    const at = read(c.file);
    if (c.kind === 'create') return at === null ? null : `${c.file} sudah ada`;
    if (at === null) return `${c.file} tidak ada lagi`;
    if (at !== c.before) return `${c.file} berubah sejak diusulkan; minta usulan baru`;
    if (c.kind === 'move' && c.to && read(c.to) !== null) return `${c.to} sudah ada`;
    return null;
}

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
