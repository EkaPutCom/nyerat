// Paket direncanakan di salinan naskah: tindakan berikutnya melihat hasil tindakan sebelumnya.
import { applyToFiles, changeFiles, CHANGE_TOOLS, planChange, preflight, type Change } from './changes.js';
import type { SourceFile } from './context.js';
import type { ToolSpec } from './provider.js';

export const BATCH_TOOL: ToolSpec = {
    name: 'usulkan_paket',
    description: 'Usulkan tindakan yang saling bergantung sebagai satu paket (maksimal 20). Pengguna meninjau semua diff sekaligus dan boleh menerapkan sebagian berkas saja; hasil per berkas dikembalikan. Untuk beberapa perubahan satu berkas, gunakan isi hasil tindakan sebelumnya. Berkas yang dihapus atau dipindah tidak boleh disentuh tindakan lain di paket yang sama.',
    parameters: { type: 'object', properties: {
        tindakan: { type: 'array', minItems: 1, maxItems: 20, items: {
            type: 'object', properties: {
                alat: { type: 'string', enum: CHANGE_TOOLS.map(t => t.name) },
                argumen: { type: 'string', description: 'Objek JSON argumen alat yang dipilih' },
            }, required: ['alat', 'argumen'], additionalProperties: false,
        } },
    }, required: ['tindakan'], additionalProperties: false },
};

// Satu Change per berkas, dan berkas yang dihapus/dipindah hanya disentuh satu tindakan. Dengan begitu tiap
// Change dalam paket berdiri sendiri, sehingga pengguna aman menerapkan sebagian saja.
export function planBatch(raw: string, files: SourceFile[]): { changes: Change[]; error?: string } {
    try {
        const a = JSON.parse(raw);
        if (!Array.isArray(a.tindakan) || !a.tindakan.length || a.tindakan.length > 20) return { changes: [], error: 'Paket harus berisi 1–20 tindakan.' };
        const virtual = files.map(f => ({ ...f }));
        const changes = new Map<string, Change>();
        const locked = new Set<string>();
        for (const item of a.tindakan) {
            if (!item || !CHANGE_TOOLS.some(t => t.name === item.alat) || typeof item.argumen !== 'string') return { changes: [], error: 'Alat atau argumen paket tidak valid.' };
            const plan = planChange(item.alat, item.argumen, virtual);
            if (!plan.ok) return { changes: [], error: plan.message };
            const c = plan.change, touched = changeFiles(c);
            const busy = touched.find(f => locked.has(f) || (c.kind === 'delete' || c.kind === 'move') && changes.has(f));
            if (busy) return { changes: [], error: `${busy} dihapus atau dipindah bersama tindakan lain di paket yang sama. Usulkan hapus/pindah sebagai tindakan tersendiri untuk berkas itu.` };
            if (c.kind === 'delete' || c.kind === 'move') touched.forEach(f => locked.add(f));
            const prior = changes.get(c.file);
            changes.set(c.file, prior ? { ...prior, after: c.after, reason: `${prior.reason}; ${c.reason}` } : c);
            applyToFiles(virtual, c);
        }
        const result = [...changes.values()].filter(c => c.kind !== 'edit' || c.before !== c.after);
        return result.length ? { changes: result } : { changes: [], error: 'Paket tidak menghasilkan perubahan.' };
    } catch { return { changes: [], error: 'Argumen paket bukan JSON objek yang valid.' }; }
}

export interface BatchHost {
    read(file: string): string | null;
    write(change: Change): void;
    rollback(change: Change): void;
}

// Preflight seluruh paket sebelum menulis; kegagalan tulis dikembalikan bersama kegagalan rollback.
// Ini transaksi dalam proses, bukan jaminan atomik terhadap mati listrik atau proses lain.
export function applyBatch(changes: Change[], host: BatchHost): string | null {
    const written: Change[] = [];
    try {
        for (const c of changes) {
            const error = preflight(c, host.read);
            if (error) return changes.length > 1 ? `${error}; seluruh paket dibatalkan` : error;
        }
        for (const c of changes) { written.push(c); host.write(c); }
        return null;
    } catch (e) {
        const failures: string[] = [];
        for (const c of written.reverse()) {
            try { host.rollback(c); } catch (error) { failures.push(`${c.file}: ${String(error)}`); }
        }
        return `${String(e)}${failures.length ? `; pemulihan gagal: ${failures.join('; ')}` : '; perubahan paket dipulihkan'}`;
    }
}
