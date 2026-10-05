// Pemeriksaan deterministik atas isi aktual; tidak mengklaim membuktikan makna seluruh dokumen.
import type { SourceFile } from './context.js';
import type { ToolSpec } from './provider.js';
import { isKanban, parseBoard } from '../markdown/kanban.js';
import { newIssues, resolveLink, scanDocument, type Issue } from '../markdown/lint.js';

export interface Verification {
    passed: boolean;
    checks: { file: string; label: string; passed: boolean }[];
}

const MARKDOWN_EXTENSION = /\.(md|markdown|mdown|mkd)$/i;
const MAX_LISTED = 8;

export const VERIFY_TOOL: ToolSpec = {
    name: 'verifikasi_pekerjaan',
    description: 'Periksa hasil aktual setelah perubahan. Nyatakan kriteria dari permintaan pengguna: teks wajib ada/tidak ada, kartu kanban pada daftar dan status tertentu, atau struktur Markdown (tabel, heading, blok kode, tautan ke berkas lain) tanpa masalah baru. berkas "*" berarti seluruh folder, mis. memastikan tanggal lama tidak tersisa di berkas mana pun. Periksa seluruh berkas yang diubah. Hasil gagal berarti pekerjaan belum selesai.',
    parameters: { type: 'object', properties: {
        pemeriksaan: { type: 'array', minItems: 1, maxItems: 40, items: { type: 'object', properties: {
            berkas: { type: 'string', description: 'Nama berkas, atau "*" untuk seluruh folder (ada/tidak_ada saja)' },
            jenis: { type: 'string', enum: ['ada', 'tidak_ada', 'kanban', 'struktur'] },
            teks: { type: 'string', description: 'ada/tidak_ada: teks persis; kanban: teks kartu. Tidak dipakai untuk struktur' },
            daftar: { type: 'string' }, selesai: { type: 'boolean' },
        }, required: ['berkas', 'jenis'], additionalProperties: false } },
    }, required: ['pemeriksaan'], additionalProperties: false },
};

const listLines = (hits: string[]): string => `${hits.slice(0, MAX_LISTED).join('; ')}${hits.length > MAX_LISTED ? `; +${hits.length - MAX_LISTED} lagi` : ''}`;

// Baris berkas yang memuat teks, sebagai "berkas:baris".
function occurrences(file: SourceFile, text: string): string[] {
    if (!file.text.includes(text)) return [];
    return file.text.split('\n').flatMap((line, i) => line.includes(text) ? [`${file.name}:${i + 1}`] : []);
}

// Masalah struktur satu berkas, termasuk tautan ke berkas Markdown yang tidak ada di folder.
export function fileIssues(name: string, text: string, files: SourceFile[]): Issue[] {
    const { issues, links } = scanDocument(text);
    const names = new Set(files.map(f => f.name));
    for (const link of links) {
        if (!MARKDOWN_EXTENSION.test(link.target)) continue;   // gambar dan berkas lain tidak terlihat oleh agent
        const path = resolveLink(name, link.target);
        if (path === null || !names.has(path)) issues.push({ line: link.line, key: `link:${link.target}`, text: `tautan ke "${link.target}" (baris ${link.line}) tidak menuju berkas di folder` });
    }
    return issues;
}

// baseline(berkas) = isi sebelum pekerjaan dimulai (null = tidak diketahui; '' = berkas baru). Dengan baseline, pemeriksaan
// struktur hanya menggagalkan masalah yang muncul karena perubahan, bukan masalah lama yang sudah ada.
export function structureCheck(file: SourceFile, files: SourceFile[], baseline: string | null): { label: string; passed: boolean } {
    const after = fileIssues(file.name, file.text, files);
    // Isi yang tidak berubah tidak mungkin punya masalah baru; lewati penguraian kedua.
    const found = baseline === null ? after : baseline === file.text ? [] : newIssues(fileIssues(file.name, baseline, files), after);
    const old = after.length - found.length;
    const label = found.length
        ? `struktur: ${found.length} masalah${baseline === null ? '' : ' baru'} (${listLines(found.map(i => i.text))})`
        : `struktur: tidak ada masalah${baseline === null ? '' : ' baru'}${old ? ` (${old} masalah lama dibiarkan)` : ''}`;
    return { label, passed: !found.length };
}

export function verifyWork(raw: string, files: SourceFile[], baseline: (file: string) => string | null = () => null): Verification {
    try {
        const a = JSON.parse(raw);
        if (!Array.isArray(a.pemeriksaan) || !a.pemeriksaan.length || a.pemeriksaan.length > 40) throw Error();
        const checks = a.pemeriksaan.map((c: any) => {
            if (!c || typeof c.berkas !== 'string' || !['ada', 'tidak_ada', 'kanban', 'struktur'].includes(c.jenis)) throw Error();
            const text: string = typeof c.teks === 'string' ? c.teks : '';
            if (c.jenis !== 'struktur' && (!text.trim() || text.length > 10000)) throw Error();
            if (c.berkas === '*') {
                if (c.jenis !== 'ada' && c.jenis !== 'tidak_ada') throw Error();
                const hits = files.flatMap(f => occurrences(f, text));
                const passed = c.jenis === 'ada' ? hits.length > 0 : !hits.length;
                return { file: '*', label: `${c.jenis} di seluruh folder: ${text}${hits.length && c.jenis === 'tidak_ada' ? ` — masih ada di ${listLines(hits)}` : ''}`, passed };
            }
            const file = files.find(f => f.name === c.berkas);
            if (!file) return { file: c.berkas, label: `${c.jenis}: berkas tidak ada`, passed: false };
            if (c.jenis === 'struktur') return { file: c.berkas, ...structureCheck(file, files, baseline(c.berkas)) };
            let passed = false;
            if (c.jenis === 'ada') passed = file.text.includes(text);
            if (c.jenis === 'tidak_ada') passed = !file.text.includes(text);
            if (c.jenis === 'kanban' && isKanban(file.text) && typeof c.daftar === 'string' && typeof c.selesai === 'boolean') {
                const cards = parseBoard(file.text).columns.filter(l => l.title === c.daftar).flatMap(l => l.cards).filter(card => card.text === text);
                passed = cards.length === 1 && cards[0].done === c.selesai;
            }
            const where = !passed && c.jenis === 'tidak_ada' ? ` — masih ada di ${listLines(occurrences(file, text))}` : '';
            return { file: c.berkas, label: `${c.jenis}: ${text}${c.jenis === 'kanban' ? ` → ${c.daftar} (${c.selesai ? 'selesai' : 'belum'})` : ''}${where}`, passed };
        });
        return { passed: checks.every((c: { passed: boolean }) => c.passed), checks };
    } catch { return { passed: false, checks: [{ file: '', label: 'Pemeriksaan tidak valid', passed: false }] }; }
}
