// Status pekerjaan disimpan bersama percakapan; tidak memuat proses berpikir model.
import type { Verification } from './verification.js';
import type { ToolSpec } from './provider.js';

export interface WorkStep { text: string; status: 'pending' | 'done' | 'blocked' }
export interface WorkState {
    goal: string;
    status: 'running' | 'paused' | 'failed' | 'complete';
    steps: WorkStep[];
    note: string;
    actionStart?: number;
    verification?: Verification;
}

export const WORK_TOOL: ToolSpec = {
    name: 'atur_pekerjaan',
    description: 'Catat tujuan dan rencana pekerjaan beberapa langkah. Perbarui status langkah saat ada kemajuan. Status ini tersimpan bersama percakapan untuk dilanjutkan setelah berhenti. Jangan nyatakan selesai sebelum hasil diperiksa.',
    parameters: { type: 'object', properties: {
        tujuan: { type: 'string' },
        langkah: { type: 'array', maxItems: 20, items: { type: 'object', properties: {
            teks: { type: 'string' }, status: { type: 'string', enum: ['pending', 'done', 'blocked'] },
        }, required: ['teks', 'status'], additionalProperties: false } },
        catatan: { type: 'string' },
    }, required: ['tujuan', 'langkah', 'catatan'], additionalProperties: false },
};

export function parseWork(raw: string): WorkState | null {
    try {
        const a = JSON.parse(raw);
        if (typeof a.tujuan !== 'string' || !a.tujuan.trim() || a.tujuan.length > 2000 ||
            typeof a.catatan !== 'string' || a.catatan.length > 4000 || !Array.isArray(a.langkah) ||
            !a.langkah.length || a.langkah.length > 20) return null;
        if (!a.langkah.every((s: any) => typeof s.teks === 'string' && s.teks.trim() && s.teks.length <= 1000 &&
            ['pending', 'done', 'blocked'].includes(s.status))) return null;
        return { goal: a.tujuan.trim(), status: 'running', steps: a.langkah.map((s: any) => ({ text: s.teks.trim(), status: s.status })), note: a.catatan };
    } catch { return null; }
}

export function workText(work: WorkState): string {
    const status = { running: 'berjalan', paused: 'tertunda', failed: 'gagal', complete: 'selesai dan terverifikasi' }[work.status];
    return `Pekerjaan: ${work.goal} (${status})\n${work.steps.map(s => `- [${s.status === 'done' ? 'x' : ' '}] ${s.text}${s.status === 'blocked' ? ' — tertunda' : ''}`).join('\n')}\n${work.note}`;
}
