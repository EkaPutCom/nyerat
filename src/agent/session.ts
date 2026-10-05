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
import { CHANGE_TOOLS, describeChange, isChangeTool, planChange, type Change } from './changes.js';

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

// Jawaban pengguna atas satu usulan perubahan. applied = sudah ditulis; error = disetujui tetapi gagal diterapkan.
export interface ProposalResult {
    applied: boolean;
    error?: string;
}

export interface TurnHandlers {
    onContext: (built: BuiltContext) => void;
    onText: (delta: string) => void;
    onReasoning: (delta: string) => void;
    onTool?: (step: ToolStep) => void;
    // Tanpa handler ini agent tidak diberi alat pengubah sama sekali. Handler menampilkan selisih, menunggu
    // keputusan pengguna, dan menerapkan perubahan hanya bila disetujui.
    onProposal?: (change: Change) => Promise<ProposalResult>;
}

export interface TurnResult {
    text: string;
    usage: Usage | null;   // dijumlahkan dari semua putaran
    cancelled: boolean;
    toolCalls: number;
    applied: number;       // usulan perubahan yang disetujui dan diterapkan pengguna
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
        const canPropose = !!handlers.onProposal && input.options.project;
        const built = buildContext({ ...input, recent: this.questions, canPropose });
        handlers.onContext(built);
        const messages: ChatMessage[] = buildMessages(built, this.history, input.question, input.budget * HISTORY_SHARE);

        // Alat hanya ada bila pengguna mengizinkan berkas lain dibaca. Dokumen aktif (isi editor) ikut
        // dan menggantikan versi di disk, kecuali pengguna mematikannya.
        const searchable: SourceFile[] = input.options.project
            ? [...input.files.map(f => ({ ...f })), ...(input.options.activeDocument && input.active ? [{ name: input.active.name, text: input.active.text }] : [])]   // salinan: usulan yang diterapkan mengubah isinya di sini saja
            : [];
        let toolBudget = input.budget * TOOL_SHARE;

        let text = '';
        let usage = null as Usage | null;
        let cancelled = false;
        let toolCalls = 0;
        let applied = 0;

        for (let round = 0; round < MAX_ROUNDS; round++) {
            const useTools = (searchable.length > 0 || canPropose) && round < MAX_ROUNDS - 1;
            // Pisahkan teks antarputaran (mis. "Saya cek dulu…" lalu jawaban) dengan baris kosong.
            const separate = () => { if (text && !text.endsWith('\n')) { text += '\n\n'; handlers.onText('\n\n'); } };
            let roundText = '';
            const result = await provider.chat({
                model, messages, cancellable, thinking: this.thinking,
                tools: useTools ? (canPropose ? [...TOOLS, ...CHANGE_TOOLS] : TOOLS) : undefined,
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
                if (canPropose && isChangeTool(call.name)) {
                    const plan = planChange(call.name, call.arguments, searchable);
                    const id = call.id;
                    if (!plan.ok) {
                        handlers.onTool?.({ id, label: describeCall(call.name, call.arguments), summary: plan.summary });
                        messages.push({ role: 'tool', toolCallId: id, content: plan.message });
                        continue;
                    }
                    const label = describeChange(plan.change);
                    handlers.onTool?.({ id, label, summary: '' });
                    let content: string, summary: string;
                    try {
                        const answer = await handlers.onProposal!(plan.change);
                        if (cancellable?.is_cancelled()) { cancelled = true; break; }
                        if (answer.applied) {
                            applied++;
                            // Panggilan berikutnya dalam giliran ini harus melihat isi yang baru.
                            const entry = searchable.find(f => f.name === plan.change.file);
                            if (entry) entry.text = plan.change.after;
                            else searchable.push({ name: plan.change.file, text: plan.change.after });
                            content = `Perubahan pada ${plan.change.file} disetujui pengguna dan sudah diterapkan.`;
                            summary = 'diterapkan';
                        } else if (answer.error) {
                            content = `Pengguna menyetujui, tetapi perubahan gagal diterapkan: ${answer.error}`;
                            summary = 'gagal diterapkan';
                        } else {
                            content = 'Pengguna menolak perubahan ini. Jangan mengulanginya; tanyakan apa yang diinginkan pengguna.';
                            summary = 'ditolak';
                        }
                    } catch (e) {
                        content = `Usulan tidak dapat ditampilkan: ${e instanceof Error ? e.message : String(e)}`;
                        summary = 'gagal';
                    }
                    messages.push({ role: 'tool', toolCallId: id, content });
                    handlers.onTool?.({ id, label, summary });
                    continue;
                }
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
        return { text, usage, cancelled, toolCalls, applied };
    }
}
