// Satu percakapan dengan asisten: riwayat tanya-jawab dan satu giliran kirim-terima.
// Konteks naskah dibangun ulang di tiap giliran (naskah bisa berubah di antara pertanyaan) dan
// tidak disimpan di riwayat, jadi riwayat tetap kecil.
//
// Satu giliran adalah loop agen: model menjawab, atau meminta alat (agent/tools.ts) dijalankan; hasil alat
// dikembalikan dan model dipanggil lagi, sampai ada jawaban. Panggilan alat dan hasilnya hanya hidup selama giliran itu.

import type Gio from 'gi://Gio';
import { buildContext, buildMessages, estimateTokens, type BuiltContext, type ContextInput, type SourceFile, type Turn } from './context.js';
import type { ChatMessage, Provider, Usage } from './provider.js';
import { describeCall, runTool, TOOLS } from './tools.js';

// Bagian anggaran untuk riwayat percakapan, di luar konteks naskah.
const HISTORY_SHARE = 0.25;
// Total hasil alat yang boleh masuk ke satu giliran, sebagai kelipatan anggaran konteks.
const TOOL_SHARE = 1;
// Putaran model per giliran; putaran terakhir dipanggil tanpa alat supaya pasti berakhir dengan jawaban.
export const MAX_ROUNDS = 10;

export type TurnInput = Omit<ContextInput, 'recent'>;

// Satu langkah penelusuran, untuk ditampilkan. summary kosong = sedang berjalan.
export interface ToolStep {
    id: string;
    label: string;
    summary: string;
}

export interface TurnHandlers {
    onContext: (built: BuiltContext) => void;
    onText: (delta: string) => void;
    onReasoning: (delta: string) => void;
    onTool?: (step: ToolStep) => void;
}

export interface TurnResult {
    text: string;
    usage: Usage | null;   // dijumlahkan dari semua putaran
    cancelled: boolean;
    toolCalls: number;
}

export class ChatSession {
    readonly history: Turn[] = [];
    thinking = false;      // mode berpikir model; diteruskan ke Provider

    get questions(): string[] {
        return this.history.filter(t => t.role === 'user').map(t => t.content);
    }

    clear(): void {
        this.history.length = 0;
    }

    // Ganti riwayat dengan percakapan yang dimuat dari disk.
    restore(turns: Turn[]): void {
        this.history.length = 0;
        this.history.push(...turns);
    }

    // Melempar jika provider gagal; riwayat tidak berubah dalam kasus itu. Jawaban yang dibatalkan di tengah
    // tetap disimpan (potongannya), karena pengguna sudah membacanya.
    async ask(input: TurnInput, provider: Provider, model: string, handlers: TurnHandlers, cancellable?: Gio.Cancellable): Promise<TurnResult> {
        const built = buildContext({ ...input, recent: this.questions });
        handlers.onContext(built);
        const messages: ChatMessage[] = buildMessages(built, this.history, input.question, input.budget * HISTORY_SHARE);

        // Alat hanya ada bila pengguna mengizinkan berkas lain dibaca. Dokumen aktif (isi editor) ikut
        // dan menggantikan versi di disk, kecuali pengguna mematikannya.
        const searchable: SourceFile[] = input.options.project
            ? [...input.files, ...(input.options.activeDocument && input.active ? [{ name: input.active.name, text: input.active.text }] : [])]
            : [];
        let toolBudget = input.budget * TOOL_SHARE;

        let text = '';
        let usage = null as Usage | null;
        let cancelled = false;
        let toolCalls = 0;

        for (let round = 0; round < MAX_ROUNDS; round++) {
            const useTools = searchable.length > 0 && round < MAX_ROUNDS - 1;
            // Pisahkan teks antarputaran (mis. "Saya cek dulu…" lalu jawaban) dengan baris kosong.
            const separate = () => { if (text && !text.endsWith('\n')) { text += '\n\n'; handlers.onText('\n\n'); } };
            let roundText = '';
            const result = await provider.chat({
                model, messages, cancellable, thinking: this.thinking,
                tools: useTools ? TOOLS : undefined,
                onText: delta => {
                    if (!roundText) separate();
                    roundText += delta;
                    text += delta;
                    handlers.onText(delta);
                },
                onReasoning: handlers.onReasoning,
            });
            if (result.usage) {
                usage = { prompt: (usage?.prompt ?? 0) + result.usage.prompt, cached: (usage?.cached ?? 0) + result.usage.cached, completion: (usage?.completion ?? 0) + result.usage.completion };
            }
            if (result.cancelled) { cancelled = true; break; }
            if (!result.toolCalls.length) break;

            messages.push({ role: 'assistant', content: roundText, reasoning: result.reasoning || undefined, toolCalls: result.toolCalls });
            for (const call of result.toolCalls) {
                if (cancellable?.is_cancelled()) { cancelled = true; break; }
                const label = describeCall(call.name, call.arguments);
                handlers.onTool?.({ id: call.id, label, summary: '' });
                let outcome = runTool(call.name, call.arguments, searchable);
                toolCalls++;
                const cost = estimateTokens(outcome.content);
                if (cost > toolBudget) {
                    outcome = { content: 'Anggaran bacaan untuk pertanyaan ini sudah habis. Jawab dengan informasi yang sudah terkumpul dan sebutkan bila ada yang belum sempat diperiksa.', summary: 'anggaran habis' };
                } else {
                    toolBudget -= cost;
                }
                messages.push({ role: 'tool', toolCallId: call.id, content: outcome.content });
                handlers.onTool?.({ id: call.id, label, summary: outcome.summary });
            }
            if (cancelled) break;
        }

        if (text.trim()) this.history.push({ role: 'user', content: input.question }, { role: 'assistant', content: text });
        return { text, usage, cancelled, toolCalls };
    }
}
