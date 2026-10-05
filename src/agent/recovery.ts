import { estimateTokens, type Turn } from './context.js';
import type { ChatRequest, ChatResult, Provider } from './provider.js';

export class TemporaryProviderError extends Error {}

// Hanya ulangi request yang belum menampilkan keluaran; jangan menggandakan potongan teks/penalaran.
export async function requestWithRetry(provider: Provider, request: ChatRequest, wait: (ms: number) => Promise<void>): Promise<ChatResult> {
    for (let attempt = 0; ; attempt++) {
        if (request.cancellable?.is_cancelled()) return { usage: null, cancelled: true, toolCalls: [], reasoning: '' };
        let emitted = false;
        try {
            return await provider.chat({ ...request,
                onText: d => { if (d) emitted = true; request.onText(d); },
                onReasoning: d => { if (d) emitted = true; request.onReasoning?.(d); },
            });
        } catch (e) {
            if (!(e instanceof TemporaryProviderError) || emitted || attempt >= 2 || request.cancellable?.is_cancelled()) throw e;
            await wait(attempt === 0 ? 300 : 900);
        }
    }
}

// Ringkasan ekstraktif: tidak menambah fakta. Riwayat lengkap tetap disimpan di disk.
export function compactHistory(history: Turn[], budget: number): { recent: Turn[]; summary: string } {
    let start = 0;
    let size = history.reduce((n, t) => n + estimateTokens(t.content), 0);
    while (history.length - start > 2 && size > budget) {
        size -= estimateTokens(history[start].content) + estimateTokens(history[start + 1].content);
        start += 2;
    }
    const limit = Math.max(0, Math.min(4000, Math.floor(budget * 0.2) * 3));
    let summary = '';
    for (const t of history.slice(0, start).reverse()) {
        const line = `${t.role === 'user' ? 'Pengguna' : 'Asisten'}: ${t.content.replace(/\s+/g, ' ').slice(0, 400)}\n`;
        if (summary.length + line.length > limit) break;
        summary = line + summary;
    }
    return { recent: history.slice(start), summary };
}
