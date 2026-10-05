// Pemeriksaan deterministik atas isi aktual; tidak mengklaim membuktikan makna seluruh dokumen.
import type { SourceFile } from './context.js';
import type { ToolSpec } from './provider.js';
import { isKanban, parseBoard } from '../markdown/kanban.js';

export interface Verification {
    passed: boolean;
    checks: { file: string; label: string; passed: boolean }[];
}

export const VERIFY_TOOL: ToolSpec = {
    name: 'verifikasi_pekerjaan',
    description: 'Periksa hasil aktual setelah perubahan. Nyatakan kriteria dari permintaan pengguna: teks wajib ada/tidak ada atau kartu kanban pada daftar dan status tertentu. Periksa seluruh berkas yang diubah. Hasil gagal berarti pekerjaan belum selesai.',
    parameters: { type: 'object', properties: {
        pemeriksaan: { type: 'array', minItems: 1, maxItems: 40, items: { type: 'object', properties: {
            berkas: { type: 'string' }, teks: { type: 'string' },
            jenis: { type: 'string', enum: ['ada', 'tidak_ada', 'kanban'] },
            daftar: { type: 'string' }, selesai: { type: 'boolean' },
        }, required: ['berkas', 'teks', 'jenis'], additionalProperties: false } },
    }, required: ['pemeriksaan'], additionalProperties: false },
};

export function verifyWork(raw: string, files: SourceFile[]): Verification {
    try {
        const a = JSON.parse(raw);
        if (!Array.isArray(a.pemeriksaan) || !a.pemeriksaan.length || a.pemeriksaan.length > 40) throw Error();
        const checks = a.pemeriksaan.map((c: any) => {
            if (!c || typeof c.berkas !== 'string' || typeof c.teks !== 'string' || !c.teks.trim() || c.teks.length > 10000 || !['ada', 'tidak_ada', 'kanban'].includes(c.jenis)) throw Error();
            const file = files.find(f => f.name === c.berkas);
            let passed = false;
            if (file && c.jenis === 'ada') passed = file.text.includes(c.teks);
            if (file && c.jenis === 'tidak_ada') passed = !file.text.includes(c.teks);
            if (file && c.jenis === 'kanban' && isKanban(file.text) && typeof c.daftar === 'string' && typeof c.selesai === 'boolean') {
                const cards = parseBoard(file.text).columns.filter(l => l.title === c.daftar).flatMap(l => l.cards).filter(card => card.text === c.teks);
                passed = cards.length === 1 && cards[0].done === c.selesai;
            }
            return { file: c.berkas, label: `${c.jenis}: ${c.teks}${c.jenis === 'kanban' ? ` → ${c.daftar} (${c.selesai ? 'selesai' : 'belum'})` : ''}`, passed };
        });
        return { passed: checks.every((c: { passed: boolean }) => c.passed), checks };
    } catch { return { passed: false, checks: [{ file: '', label: 'Pemeriksaan tidak valid', passed: false }] }; }
}
