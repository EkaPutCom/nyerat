// Alat baca-saja riwayat Git untuk model: daftar commit, isi perubahan satu commit, dan isi berkas pada commit lama.
// Modul ini murni: memvalidasi argumen menjadi GitRequest dan merapikan keluaran git. Menjalankan git dilakukan
// pemanggil (src/git.ts lewat ChatHost), yang membatasi pathspec ke berkas Markdown tidak tersembunyi di folder kerja.

import { cleanNewName } from './changes.js';
import { estimateTokens } from './context.js';
import type { ToolSpec } from './provider.js';
import type { ToolOutcome } from './tools.js';

export const MAX_GIT_TOKENS = 6000;
const MAX_LOG = 50;

export type GitRequest =
    | { kind: 'log'; file: string | null; limit: number }
    | { kind: 'show'; commit: string; file: string | null }
    | { kind: 'file'; commit: string; file: string };

export type GitAnswer = { ok: true; text: string } | { ok: false; message: string };

// Format record `git log` yang dipakai runner: pemisah record \x1e dan field \x1f, lalu baris --name-status.
export const AGENT_LOG_FORMAT = '%x1e%h%x1f%ad%x1f%an%x1f%s';

export const GIT_TOOLS: ToolSpec[] = [
    {
        name: 'riwayat_git',
        description: 'Daftar commit Git terbaru di folder kerja (atau untuk satu berkas, mengikuti ganti nama): hash, tanggal, penulis, pesan, dan berkas Markdown yang berubah. Pakai untuk pertanyaan seperti "apa yang berubah minggu ini" atau "kapan tanggal ini diubah". Perubahan yang belum di-commit tidak tampil.',
        parameters: {
            type: 'object',
            properties: {
                berkas: { type: 'string', description: 'Batasi ke satu berkas (opsional)' },
                maks: { type: 'integer', description: `Jumlah commit (1–${MAX_LOG}, bawaan 15)` },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'lihat_commit',
        description: 'Tampilkan perubahan (diff) berkas Markdown pada satu commit, dari hash di riwayat_git. Bisa dibatasi ke satu berkas.',
        parameters: {
            type: 'object',
            properties: {
                commit: { type: 'string', description: 'Hash commit (minimal 4 karakter) atau HEAD, HEAD~1, …' },
                berkas: { type: 'string', description: 'Batasi ke satu berkas (opsional)' },
            },
            required: ['commit'],
            additionalProperties: false,
        },
    },
    {
        name: 'isi_versi',
        description: 'Baca isi lengkap sebuah berkas seperti pada commit tertentu (termasuk berkas yang sudah dihapus atau dipindah sejak itu). Hasil memuat nomor baris.',
        parameters: {
            type: 'object',
            properties: {
                commit: { type: 'string', description: 'Hash commit atau HEAD, HEAD~1, …' },
                berkas: { type: 'string', description: 'Path berkas pada commit itu' },
            },
            required: ['commit', 'berkas'],
            additionalProperties: false,
        },
    },
];

export const isGitTool = (name: string): boolean => GIT_TOOLS.some(t => t.name === name);

const asString = (v: unknown): string => typeof v === 'string' ? v.trim() : '';

// Hash dan HEAD~n saja: tidak ada yang diawali "-" sehingga tidak bisa menjadi opsi git.
const COMMIT = /^(?:[0-9a-f]{4,40}|HEAD(?:~\d{1,4}|\^{1,4})?)$/i;

// Galat dikembalikan sebagai string supaya model bisa memperbaiki argumennya.
export function parseGitCall(name: string, rawArguments: string): GitRequest | string {
    let a: Record<string, unknown> = {};
    try {
        const parsed = JSON.parse(rawArguments || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error();
        a = parsed;
    } catch { return 'Argumen bukan JSON objek yang valid.'; }
    const rawFile = asString(a.berkas);
    const file = rawFile ? cleanNewName(rawFile) : null;
    if (rawFile && file !== rawFile) return `Berkas "${rawFile}" tidak valid: pakai path Markdown relatif seperti di daftar_berkas.`;
    if (name === 'riwayat_git') {
        const limit = typeof a.maks === 'number' && Number.isFinite(a.maks) ? Math.min(Math.max(Math.trunc(a.maks), 1), MAX_LOG) : 15;
        return { kind: 'log', file, limit };
    }
    const commit = asString(a.commit);
    if (!COMMIT.test(commit)) return `Commit "${commit}" tidak valid. Pakai hash dari riwayat_git atau HEAD, HEAD~1, …`;
    if (name === 'lihat_commit') return { kind: 'show', commit, file };
    if (name === 'isi_versi') return file ? { kind: 'file', commit, file } : 'Argumen "berkas" wajib diisi.';
    return `Alat "${name}" tidak dikenal.`;
}

const clip = (text: string, hint: string): string =>
    estimateTokens(text) <= MAX_GIT_TOKENS ? text : `${text.slice(0, MAX_GIT_TOKENS * 3)}\n[… dipotong; ${hint} …]`;

const STATUS: Record<string, string> = { A: 'baru', M: 'ubah', D: 'hapus', R: 'pindah', C: 'salin', T: 'ubah' };

// Keluaran runner → teks untuk model dan ringkasan untuk antarmuka.
export function formatGit(request: GitRequest, answer: GitAnswer): ToolOutcome {
    if (!answer.ok) {
        const message = /not a git repository/i.test(answer.message) ? 'Folder kerja bukan repositori Git.'
            : /does not have any commits/i.test(answer.message) ? 'Repositori belum punya commit.'
            : `git gagal: ${answer.message.split('\n')[0].slice(0, 300)}`;
        return { content: message, summary: 'gagal' };
    }
    if (request.kind === 'log') {
        const commits = answer.text.split('\x1e').filter(r => r.trim()).map(record => {
            const [head, ...rest] = record.split('\n');
            const [hash, date, author, ...subject] = head.split('\x1f');
            const files = rest.filter(l => l.trim()).map(l => {
                const [code, ...paths] = l.split('\t');
                return `  ${STATUS[code[0]] ?? code} ${paths.join(' → ')}`;
            });
            return [`${hash} ${date} · ${author} · ${subject.join(' ')}`, ...files].join('\n');
        });
        if (!commits.length) return { content: request.file ? `Belum ada commit untuk ${request.file}.` : 'Belum ada commit yang menyentuh berkas Markdown di folder ini.', summary: '0 commit' };
        return { content: clip(commits.join('\n'), 'kurangi maks atau batasi ke satu berkas'), summary: `${commits.length} commit` };
    }
    if (request.kind === 'show') {
        if (!/^diff --git /m.test(answer.text)) return { content: `Commit ${request.commit} tidak mengubah berkas Markdown${request.file ? ` ${request.file}` : ''} di folder ini.`, summary: 'tanpa perubahan' };
        const lines = answer.text.split('\n').filter(l => !/^(index |diff --git |similarity index|dissimilarity index)/.test(l));
        return { content: clip(lines.join('\n'), 'batasi ke satu berkas'), summary: `${lines.filter(l => /^[+-](?![+-])/.test(l)).length} baris berubah` };
    }
    const lines = answer.text.replace(/\n$/, '').split('\n');
    const body = lines.map((l, i) => `${i + 1}│ ${l}`).join('\n');
    return { content: clip(`[${request.file} pada ${request.commit}, ${lines.length} baris]\n${body}`, 'bagian awal saja yang ditampilkan'), summary: `${lines.length} baris` };
}

export function describeGitCall(request: GitRequest | string, name: string): string {
    if (typeof request === 'string') return name;
    if (request.kind === 'log') return `Melihat riwayat Git${request.file ? ` ${request.file}` : ''}`;
    if (request.kind === 'show') return `Melihat commit ${request.commit}${request.file ? ` (${request.file})` : ''}`;
    return `Membaca ${request.file} pada ${request.commit}`;
}
