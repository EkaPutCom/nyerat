import { cleanNewName, type Change } from './changes.js';
import type { SourceFile } from './context.js';

export interface ActionEvent {
    id: string;
    question: string;
    tool: string;
    status: 'proposed' | 'applied' | 'rejected' | 'failed' | 'interrupted' | 'read';
    changes: Change[];
    summary: string;
    time: string;
}

// Metadata dapat disunting pengguna: hanya data yang valid dipulihkan, tidak pernah dieksekusi.
export function parseEvents(value: unknown): ActionEvent[] {
    if (!Array.isArray(value)) return [];
    return value.filter((e: any) => e && typeof e.id === 'string' && typeof e.question === 'string' &&
        typeof e.tool === 'string' && typeof e.summary === 'string' && typeof e.time === 'string' &&
        ['proposed', 'applied', 'rejected', 'failed', 'interrupted', 'read'].includes(e.status) && Array.isArray(e.changes) &&
        e.changes.every((c: any) => c && ['create', 'edit'].includes(c.kind) && typeof c.file === 'string' && cleanNewName(c.file) === c.file &&
            typeof c.before === 'string' && typeof c.after === 'string' && typeof c.reason === 'string'));
}

export function reconcileEvents(events: ActionEvent[], files: SourceFile[]): void {
    for (const e of events) {
        if (e.status !== 'proposed') continue;
        const values = e.changes.map(c => files.find(f => f.name === c.file)?.text ?? null);
        if (e.changes.length && e.changes.every((c, i) => values[i] === c.after)) {
            e.status = 'applied'; e.summary = 'Hasil aktual cocok dengan seluruh usulan; dipulihkan setelah interupsi.';
        } else if (e.changes.every((c, i) => c.kind === 'create' ? values[i] === null : values[i] === c.before)) {
            e.status = 'interrupted'; e.summary = 'Proses berhenti sebelum penerapan; perlu usulan dan persetujuan baru.';
        } else {
            e.status = 'failed'; e.summary = 'Isi aktual berbeda atau paket diterapkan sebagian; periksa berkas sebelum melanjutkan.';
        }
    }
}

export function journalText(events: ActionEvent[], maxChars = 8000): string {
    const lines: string[] = [];
    let size = 0;
    for (const e of [...events].reverse()) {
        const status = { proposed: 'Diusulkan', applied: 'Diterapkan', rejected: 'Ditolak', failed: 'Gagal', interrupted: 'Terputus', read: 'Penelusuran' }[e.status];
        const line = `${status}: ${e.tool} ${e.changes.map(c => c.file).join(', ')} — ${e.summary}`.slice(0, 1500);
        if (size + line.length > maxChars) break;
        lines.unshift(line); size += line.length;
    }
    return lines.join('\n');
}
