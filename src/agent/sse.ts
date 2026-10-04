// Membaca satu baris aliran SSE dari API chat gaya OpenAI (dipakai DeepSeek).
// Murni TypeScript tanpa GTK supaya mudah diuji.

import type { Usage } from './provider.js';

// Potongan pemanggilan alat yang datang bertahap: `index` menentukan alat mana, argumennya disambung.
export interface ToolDelta {
    index: number;
    id?: string;
    name?: string;
    arguments?: string;
}

export type StreamEvent =
    | { kind: 'chunk'; text: string; reasoning: string; tools: ToolDelta[]; usage: Usage | null }
    | { kind: 'done' };

// null = baris yang diabaikan (kosong, komentar keep-alive, JSON rusak, atau potongan tanpa isi).
export function parseStreamLine(line: string): StreamEvent | null {
    if (!line.startsWith('data:')) return null;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return { kind: 'done' };
    let data: any;
    try {
        data = JSON.parse(payload);
    } catch (e) {
        return null;
    }
    const delta = data?.choices?.[0]?.delta;
    const text: string = delta?.content ?? '';
    const reasoning: string = delta?.reasoning_content ?? '';
    const tools: ToolDelta[] = Array.isArray(delta?.tool_calls)
        ? delta.tool_calls.map((t: any, i: number) => ({
            index: typeof t.index === 'number' ? t.index : i,
            id: t.id ?? undefined,
            name: t.function?.name ?? undefined,
            arguments: t.function?.arguments ?? undefined,
        }))
        : [];
    const u = data?.usage;
    const usage: Usage | null = u && typeof u.prompt_tokens === 'number'
        ? { prompt: u.prompt_tokens, cached: u.prompt_cache_hit_tokens ?? 0, completion: u.completion_tokens ?? 0 }
        : null;
    if (!text && !reasoning && !tools.length && !usage) return null;
    return { kind: 'chunk', text, reasoning, tools, usage };
}

// Pesan galat dari status HTTP; body (JSON {"error":{"message":…}}) dipakai sebagai keterangan tambahan.
export function httpErrorMessage(status: number, body: string): string {
    let detail = '';
    try {
        detail = JSON.parse(body)?.error?.message ?? '';
    } catch (e) {
        detail = body.slice(0, 200);
    }
    const base: Record<number, string> = {
        400: 'Permintaan ditolak (format, nama model, atau panjang konteks tidak valid)',
        401: 'API key ditolak; periksa kembali key di pengaturan asisten',
        402: 'Saldo akun DeepSeek tidak cukup',
        422: 'Parameter permintaan tidak valid',
        429: 'Terlalu banyak permintaan; coba lagi sebentar lagi',
        500: 'Server DeepSeek bermasalah; coba lagi nanti',
        503: 'Server DeepSeek sedang sibuk; coba lagi nanti',
    };
    const text = base[status] ?? `Server membalas dengan status ${status}`;
    return detail ? `${text}: ${detail}` : text;
}
