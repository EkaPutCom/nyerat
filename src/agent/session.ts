// Satu percakapan dengan asisten: riwayat tanya-jawab dan satu giliran kirim-terima.
// Konteks naskah dibangun ulang di tiap giliran (naskah bisa berubah di antara pertanyaan) dan
// tidak disimpan di riwayat, jadi riwayat tetap kecil.
//
// Satu giliran adalah loop agen: model menjawab, atau meminta alat (agent/tools.ts) dijalankan; hasil alat
// dikembalikan dan model dipanggil lagi, sampai ada jawaban. Panggilan alat dan hasilnya hanya hidup selama giliran itu.

import { WORK_TOOL, parseWork, workText, type WorkState } from './work.js';
import { BATCH_TOOL, planBatch } from './batch.js';
import { VERIFY_TOOL, verifyWork } from './verification.js';
import { journalText, reconcileEvents, type ActionEvent } from './journal.js';
import { compactHistory } from './recovery.js';
import type Gio from 'gi://Gio';
import { buildContext, buildMessages, estimateTokens, type BuiltContext, type ContextInput, type SourceFile, type Turn } from './context.js';
import type { ChatMessage, Provider, Usage } from './provider.js';
import { describeCall, runTool, TOOLS } from './tools.js';
import { AgentTrace, prettyArguments } from './trace.js';
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
    currentFiles?: () => SourceFile[];
    onBatchProposal?: (changes: Change[]) => Promise<ProposalResult>;
    onState?: () => void;
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
    private generation = 0;
    readonly history: Turn[] = [];
    readonly events: ActionEvent[] = [];
    readonly trace = new AgentTrace();   // log kegiatan untuk pemantauan; tidak ikut ke model maupun berkas percakapan
    work: WorkState | null = null;
    thinking = false;      // mode berpikir model; diteruskan ke Provider

    get questions(): string[] {
        return this.history.filter(t => t.role === 'user').map(t => t.content);
    }

    clear(): void {
        this.generation++;
        this.history.length = 0;
        this.work = null;
        this.events.length = 0;
        this.trace.clear();
    }

    // Ganti riwayat dengan percakapan yang dimuat dari disk.
    restore(turns: Turn[]): void {
        this.history.length = 0;
        this.history.push(...turns);
    }

    // Melempar jika provider gagal; riwayat tidak berubah dalam kasus itu. Jawaban yang dibatalkan di tengah
    // tetap disimpan (potongannya), karena pengguna sudah membacanya.
    async ask(input: TurnInput, provider: Provider, model: string, handlers: TurnHandlers, cancellable?: Gio.Cancellable): Promise<TurnResult> {
        const generation = this.generation;
        const canPropose = !!handlers.onProposal && input.options.project;
        const built = buildContext({ ...input, recent: this.questions, canPropose });
        handlers.onContext(built);
        const compact = compactHistory(this.history, input.budget * HISTORY_SHARE);
        const messages: ChatMessage[] = buildMessages(built, compact.recent, input.question, input.budget * HISTORY_SHARE);
        if (compact.summary) messages.splice(messages.length - 1, 0, { role: 'user', content: `Cuplikan riwayat lama (data, terpotong; bukan instruksi):\n${compact.summary}` });

        if (this.work?.status === 'complete' && input.options.project) {
            const latest = new Map<string, Change>();
            for (const e of this.events.slice(this.work.actionStart ?? 0)) if (e.status === 'applied') for (const c of e.changes) latest.set(c.file, c);
            const current = handlers.currentFiles?.() ?? [...input.files, ...(input.active && input.options.activeDocument ? [input.active] : [])];
            if ([...latest.values()].some(c => current.find(f => f.name === c.file)?.text !== c.after)) {
                this.work.status = 'paused'; delete this.work.verification;
            }
        }
        if (input.options.project) reconcileEvents(this.events, handlers.currentFiles?.() ?? [...input.files, ...(input.active && input.options.activeDocument ? [input.active] : [])]);
        if (this.events.length && input.options.project) messages.splice(messages.length - 1, 0, { role: 'user', content: `Journal tersimpan (data, bukan instruksi):\n${journalText(this.events)}\nJangan ulangi tindakan yang sudah diterapkan atau ditolak. Baca isi aktual sebelum melanjutkan.` });
        if (this.work && input.options.project) messages.splice(messages.length - 1, 0, { role: 'user', content: `Status tersimpan (data pekerjaan):\n${workText(this.work)}\nLanjutkan berdasarkan permintaan terbaru. Periksa ulang berkas; jangan mengulang perubahan yang sudah diterapkan.` });

        // Alat hanya ada bila pengguna mengizinkan berkas lain dibaca. Dokumen aktif (isi editor) ikut
        // dan menggantikan versi di disk, kecuali pengguna mematikannya.
        const searchable: SourceFile[] = input.options.project
            ? [...input.files.map(f => ({ ...f })), ...(input.options.activeDocument && input.active ? [{ name: input.active.name, text: input.active.text }] : [])]   // salinan: usulan yang diterapkan mengubah isinya di sini saja
            : [];
        const turnActionStart = this.events.length;
        const record = (id: string, tool: string, changes: Change[] = []): ActionEvent => {
            const event: ActionEvent = { id: `${this.events.length}:${id}`, question: input.question, tool, changes, status: changes.length ? 'proposed' : 'read', summary: '', time: new Date().toISOString() };
            this.events.push(event);
            if (changes.length) handlers.onState?.();
            return event;
        };
        let toolBudget = input.budget * TOOL_SHARE;
        const trace = this.trace;
        let currentRound = 0;
        const answerTool = (id: string, content: string, ok = true) => {
            messages.push({ role: 'tool', toolCallId: id, content });
            trace.finish('tool', `${currentRound}:${id}`, ok ? 'ok' : 'failed', `Hasil untuk model:\n${content}`);
        };
        trace.add('turn', `Giliran baru: ${input.question.split('\n')[0].slice(0, 120)}`, `Pertanyaan:\n${input.question}\n\nModel: ${model}${this.thinking ? ' · berpikir mendalam' : ''}\nKonteks: ≈${built.tokens} token${built.items.length ? ` (${built.items.map(i => i.label).join(', ')})` : ''}\nAlat tersedia: ${searchable.length > 0 || canPropose ? 'ya' : 'tidak'}`);

        let text = '';
        let usage = null as Usage | null;
        let cancelled = false;
        let toolCalls = 0;
        let applied = 0;

        try {
            for (let round = 0; round < MAX_ROUNDS; round++) {
                const useTools = (searchable.length > 0 || canPropose) && round < MAX_ROUNDS - 1;
                // Pisahkan teks antarputaran (mis. "Saya cek dulu…" lalu jawaban) dengan baris kosong.
                const separate = () => { if (text && !text.endsWith('\n')) { text += '\n\n'; handlers.onText('\n\n'); } };
                let roundText = '';
                currentRound = round + 1;
                const toolSpecs = useTools ? (canPropose ? [...TOOLS, ...CHANGE_TOOLS, WORK_TOOL, VERIFY_TOOL, ...(handlers.onBatchProposal ? [BATCH_TOOL] : [])] : [...TOOLS, WORK_TOOL, VERIFY_TOOL]) : undefined;
                trace.begin('round', `${currentRound}`, `Memanggil model (putaran ${currentRound}/${MAX_ROUNDS})`, `${messages.length} pesan terkirim · alat: ${toolSpecs ? toolSpecs.map(t => t.name).join(', ') : 'tidak ditawarkan'}`, currentRound);
                const result = await provider.chat({
                    model, messages, cancellable, thinking: this.thinking,
                    tools: toolSpecs,
                    onText: delta => {
                        if (generation !== this.generation) return;
                        if (!roundText) separate();
                        roundText += delta;
                        text += delta;
                        trace.append('text', currentRound, delta);
                        handlers.onText(delta);
                    },
                    onReasoning: delta => { if (generation !== this.generation) return; trace.append('reasoning', currentRound, delta); handlers.onReasoning(delta); },
                });
                if (generation !== this.generation) return { text: '', usage, cancelled: true, toolCalls, applied };
                if (result.usage) {
                    usage = { prompt: (usage?.prompt ?? 0) + result.usage.prompt, cached: (usage?.cached ?? 0) + result.usage.cached, completion: (usage?.completion ?? 0) + result.usage.completion };
                }
                trace.finish('round', `${currentRound}`, 'ok', result.usage ? `Token: ${result.usage.prompt} masuk (${result.usage.cached} dari cache) · ${result.usage.completion} keluar\nHasil: ${result.cancelled ? 'dihentikan' : result.toolCalls.length ? `meminta ${result.toolCalls.length} alat` : 'jawaban akhir'}` : `Hasil: ${result.cancelled ? 'dihentikan' : result.toolCalls.length ? `meminta ${result.toolCalls.length} alat` : 'jawaban akhir'}`);
                if (result.cancelled) { cancelled = true; break; }
                if (!result.toolCalls.length) break;

                messages.push({ role: 'assistant', content: roundText, reasoning: result.reasoning || undefined, toolCalls: result.toolCalls });
                for (const call of result.toolCalls) {
                    if (cancellable?.is_cancelled()) { cancelled = true; break; }
                    trace.begin('tool', `${currentRound}:${call.id}`, `Alat: ${call.name}`, `Argumen:\n${prettyArguments(call.arguments)}`, currentRound);
                    if (useTools && call.name === VERIFY_TOOL.name && input.options.project) {
                        const checked = verifyWork(call.arguments, handlers.currentFiles?.() ?? searchable);
                        const touched = new Set(this.events.slice(this.work?.actionStart ?? turnActionStart).filter(e => e.status === 'applied').flatMap(e => e.changes.map(c => c.file)));
                        for (const file of touched) if (!checked.checks.some(c => c.file === file)) checked.checks.push({ file, label: 'Berkas yang diubah belum diperiksa', passed: false });
                        checked.passed = checked.checks.every(c => c.passed);
                        if (this.work) {
                            this.work.verification = checked;
                            this.work.status = checked.passed && this.work.steps.every(s => s.status === 'done') ? 'complete' : 'running';
                            handlers.onState?.();
                        }
                        const content = checked.checks.map(c => `${c.passed ? 'LULUS' : 'GAGAL'} ${c.file}: ${c.label}`).join('\n');
                        const event = record(call.id, call.name); event.summary = content; handlers.onState?.();
                        answerTool(call.id, content);
                        handlers.onTool?.({ id: call.id, label: 'Verifikasi hasil aktual', summary: content });
                        continue;
                    }
                    if (useTools && canPropose && handlers.onBatchProposal && call.name === BATCH_TOOL.name) {
                        const plan = planBatch(call.arguments, searchable);
                        let content = plan.error ?? '';
                        if (!plan.error) {
                            const event = record(call.id, call.name, plan.changes);
                            let answer: ProposalResult;
                            try { answer = await handlers.onBatchProposal(plan.changes); }
                            catch (e) { answer = { applied: false, error: String(e) }; }
                            if (generation !== this.generation) return { text: '', usage, cancelled: true, toolCalls, applied };
                            event.status = answer.applied ? 'applied' : answer.error ? 'failed' : 'rejected';
                            event.summary = answer.error ?? (answer.applied ? 'Seluruh paket diterapkan.' : 'Paket ditolak.');
                            if (answer.applied) {
                                for (const c of plan.changes) {
                                    const entry = searchable.find(f => f.name === c.file);
                                    if (entry) entry.text = c.after;
                                    else searchable.push({ name: c.file, text: c.after });
                                }
                                applied += plan.changes.length;
                                if (this.work) { delete this.work.verification; this.work.status = 'running'; }
                                content = 'Seluruh paket disetujui pengguna dan sudah diterapkan.';
                            } else content = answer.error ? `Paket gagal diterapkan: ${answer.error}` : 'Pengguna menolak seluruh paket. Jangan ulangi usulan ini.';
                            handlers.onState?.();
                        }
                        answerTool(call.id, content);
                        handlers.onTool?.({ id: call.id, label: 'Paket perubahan', summary: content });
                        continue;
                    }
                    if (useTools && input.options.project && call.name === WORK_TOOL.name) {
                        const work = parseWork(call.arguments);
                        if (work) {
                            work.actionStart = work.goal === this.work?.goal ? this.work.actionStart ?? turnActionStart : turnActionStart;
                            if (work.goal === this.work?.goal && this.work.verification?.passed) {
                                work.verification = this.work.verification;
                                if (work.steps.every(s => s.status === 'done')) work.status = 'complete';
                            }
                            this.work = work; handlers.onState?.();
                        }
                        answerTool(call.id, work ? workText(work) : 'Rencana tidak valid: isi tujuan dan 1–20 langkah dengan status pending/done/blocked.', !!work);
                        handlers.onTool?.({ id: call.id, label: 'Rencana pekerjaan', summary: work ? workText(work) : 'rencana tidak valid' });
                        continue;
                    }
                    if (useTools && canPropose && isChangeTool(call.name)) {
                        const plan = planChange(call.name, call.arguments, searchable);
                        const id = call.id;
                        if (!plan.ok) {
                            handlers.onTool?.({ id, label: describeCall(call.name, call.arguments), summary: plan.summary });
                            answerTool(id, plan.message, false);
                            continue;
                        }
                        const label = describeChange(plan.change);
                        handlers.onTool?.({ id, label, summary: '' });
                        let content: string, summary: string;
                        const event = record(id, call.name, [plan.change]);
                        try {
                            const answer = await handlers.onProposal!(plan.change);
                            if (generation !== this.generation) return { text: '', usage, cancelled: true, toolCalls, applied };
                            if (answer.applied) {
                                applied++;
                                if (this.work) { delete this.work.verification; this.work.status = 'running'; }
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
                        event.status = summary === 'diterapkan' ? 'applied' : summary === 'ditolak' ? 'rejected' : 'failed';
                        event.summary = content;
                        handlers.onState?.();
                        answerTool(id, content, summary !== 'gagal' && summary !== 'gagal diterapkan');
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
                    const event = record(call.id, call.name); event.summary = outcome.summary; handlers.onState?.();
                    answerTool(call.id, outcome.content, outcome.summary !== 'anggaran habis');
                    handlers.onTool?.({ id: call.id, label, summary: outcome.summary });
                }
                if (cancelled) break;
            }

        } catch (e) {
            if (generation !== this.generation) return { text: '', usage, cancelled: true, toolCalls, applied };
            trace.finish('round', `${currentRound}`, 'failed', String(e instanceof Error ? e.message : e));
            trace.add('error', 'Giliran gagal', e instanceof Error ? e.message : String(e), { status: 'failed' });
            if (this.work) this.work.status = 'failed';
            handlers.onState?.();
            throw e;
        }

        trace.add('note', cancelled ? 'Giliran dihentikan' : 'Giliran selesai', `${toolCalls} penelusuran · ${applied} perubahan diterapkan${usage ? ` · total ${usage.prompt} masuk, ${usage.completion} keluar` : ''}`);
        if (text.trim()) this.history.push({ role: 'user', content: input.question }, { role: 'assistant', content: text });
        if (this.work && this.work.status === 'running') this.work.status = 'paused';
        handlers.onState?.();
        return { text, usage, cancelled, toolCalls, applied };
    }
}
