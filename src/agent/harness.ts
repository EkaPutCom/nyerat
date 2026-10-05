// Orkestrasi harness eksternal (murni, tanpa GTK): kartu kanban yang ditugaskan ke harness (mis. "@pi")
// dikerjakan oleh program agent lain di folder proyek terpisah, bukan di folder kerja Nyerat. Modul ini
// hanya menyusun perintah dan prompt, membaca aliran JSON keluarannya, dan mengatur antrean; menjalankan
// proses dan menulis papan ada di orchestrator.ts.
//
// Papan menyebut proyeknya lewat frontmatter "proyek: nama" atau tag kartu "#proyek/nama" (tag menang).
// Nama dipetakan ke folder di pengaturan, jadi isi Markdown tidak bisa mengarahkan harness ke path sembarang.

import { cardMeta, type Board, type Card, type Position } from '../markdown/kanban.js';
import { AgentTrace, prettyArguments } from './trace.js';

export interface HarnessSpec {
    name: string;          // nama penugasan di kartu, tanpa "@"
    label: string;
    program: string;       // dicari di PATH, lalu di ~/.local/bin
    args(prompt: string, title: string): string[];
}

// Pi (pi.dev): mode JSON menulis satu event per baris lalu keluar setelah prompt selesai. Sesi tetap
// disimpan pi, sehingga pekerjaan bisa dilanjutkan dengan "pi --session <id>" di folder proyek.
export const HARNESSES: Record<string, HarnessSpec> = {
    pi: {
        name: 'pi',
        label: 'pi',
        program: 'pi',
        args: (prompt, title) => ['--mode', 'json', '--name', title, '--', prompt],
    },
};

export const harnessFor = (agent: string | null): HarnessSpec | null => (agent && HARNESSES[agent]) || null;

// ---------- Proyek ----------

const PROJECT_TAG = /^proyek\/(.+)$/;
const PROJECT_LINE = /^proyek:\s*["']?([^"'\s][^"']*?)["']?\s*$/i;
export const PROJECT_NAME = /^[\p{L}\p{N}_.-]+$/u;

// Proyek bawaan papan dari frontmatter ("proyek: web-ecommerce").
export function boardProject(board: Board): string | null {
    if (board.head[0]?.trim() !== '---') return null;
    for (let i = 1; i < board.head.length && board.head[i].trim() !== '---'; i++) {
        const m = PROJECT_LINE.exec(board.head[i]);
        if (m) return m[1];
    }
    return null;
}

export function cardProject(board: Board, card: Card): string | null {
    for (const tag of cardMeta(card.text).tags) {
        const m = PROJECT_TAG.exec(tag);
        if (m) return m[1];
    }
    return boardProject(board);
}

// Folder proyek tidak boleh folder kerja Nyerat atau bagiannya: harness menulis bebas di sana tanpa jendela tinjau.
export function checkProjectFolder(folder: string, workspace: string | null): string | null {
    if (!folder.startsWith('/')) return 'folder proyek harus path absolut';
    const clean = folder.replace(/\/+$/, '') || '/';
    if (clean === '/') return 'folder proyek tidak boleh root';
    if (workspace) {
        const ws = workspace.replace(/\/+$/, '');
        if (clean === ws || clean.startsWith(`${ws}/`)) return 'folder proyek tidak boleh berada di folder kerja Nyerat';
        if (ws.startsWith(`${clean}/`)) return 'folder proyek tidak boleh memuat folder kerja Nyerat';
    }
    return null;
}

// ---------- Prompt ----------

export function buildPrompt(card: Card, project: string, board: string): string {
    const meta = cardMeta(card.text);
    const tags = meta.tags.filter(t => !PROJECT_TAG.test(t));
    const lines = [
        `Tugas dari papan kanban "${board}" di Nyerat, untuk proyek "${project}" (folder kerja saat ini).`,
        '',
        `# ${meta.title}`,
    ];
    if (card.notes.some(n => n.trim())) lines.push('', ...card.notes);
    if (tags.length || meta.due) lines.push('', [tags.length ? `Tag: ${tags.map(t => `#${t}`).join(' ')}` : '', meta.due ? `Tenggat: ${meta.due}` : ''].filter(Boolean).join(' · '));
    lines.push('', 'Kerjakan tugas ini di repositori ini saja. Jangan membuat commit atau push kecuali catatan kartu memintanya; '
        + 'pengguna akan meninjau perubahanmu. Di akhir, tulis ringkasan singkat: apa yang diubah, berkas mana, dan apa '
        + 'yang belum selesai atau perlu diperiksa.');
    return lines.join('\n');
}

// ---------- Papan ----------

// Daftar tujuan saat harness mulai dan selesai, dikenali dari judulnya.
const DOING = /^(dikerjakan|sedang dikerjakan|proses|progres|doing|in progress|wip)$/i;
const REVIEW = /^(review|tinjau|ditinjau|perlu ditinjau|in review)$/i;

export function stageColumn(board: Board, stage: 'doing' | 'review'): number {
    const re = stage === 'doing' ? DOING : REVIEW;
    return board.columns.findIndex(c => re.test(c.title.trim()));
}

// Kartu dikenali dari teksnya (papan tidak punya id kartu). null bila tidak ada atau tidak unik.
export function locateCard(board: Board, text: string): Position | null {
    let found: Position | null = null;
    for (let c = 0; c < board.columns.length; c++) {
        for (let i = 0; i < board.columns[c].cards.length; i++) {
            if (board.columns[c].cards[i].text !== text) continue;
            if (found) return null;
            found = { column: c, index: i };
        }
    }
    return found;
}

// ---------- Membaca keluaran pi ----------

export interface HarnessResult {
    ok: boolean;
    summary: string;        // teks jawaban terakhir harness
    error: string | null;
    cost: number;           // USD, jumlah semua pesan asisten
    tokens: number;
    sessionId: string | null;
}

interface PiContent { type?: string; text?: string; thinking?: string }
interface PiMessage {
    role?: string;
    content?: string | PiContent[];
    stopReason?: string;
    errorMessage?: string;
    usage?: { totalTokens?: number; cost?: { total?: number } };
}
interface PiEvent {
    type?: string;
    id?: string;
    message?: PiMessage;
    assistantMessageEvent?: { type?: string; delta?: string };
    toolCallId?: string;
    toolName?: string;
    args?: unknown;
    result?: { content?: PiContent[] };
    isError?: boolean;
    reason?: string;
}

const contentText = (content: PiMessage['content']): string =>
    typeof content === 'string' ? content : (content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('');

// Mengubah aliran JSONL pi menjadi lini masa AgentTrace (ditampilkan LogViewer yang sama dengan agent Nyerat)
// dan hasil akhir. Baris yang bukan JSON (mis. peringatan) dicatat apa adanya, tidak menggagalkan pembacaan.
export class PiReader {
    private turn = 0;
    private summary = '';
    private error: string | null = null;
    private stopReason = '';
    private cost = 0;
    private tokens = 0;
    private sessionId: string | null = null;
    settled = false;

    constructor(readonly trace: AgentTrace) {}

    line(raw: string): void {
        const text = raw.replace(/\r$/, '');
        if (!text.trim()) return;
        let e: PiEvent;
        try { e = JSON.parse(text) as PiEvent; } catch { this.trace.add('note', 'Keluaran pi', text); return; }
        switch (e.type) {
        case 'session':
            this.sessionId = e.id ?? null;
            this.trace.add('note', 'Sesi pi dimulai', this.sessionId ? `Lanjutkan di folder proyek dengan: pi --session ${this.sessionId}` : '');
            break;
        case 'turn_start':
            this.turn++;
            this.trace.add('round', `Putaran ${this.turn}`, '', { round: this.turn });
            break;
        case 'message_update': {
            const m = e.assistantMessageEvent;
            if (m?.type === 'text_delta' && m.delta) this.trace.append('text', this.turn, m.delta);
            else if (m?.type === 'thinking_delta' && m.delta) this.trace.append('reasoning', this.turn, m.delta);
            break;
        }
        case 'message_end': {
            const m = e.message;
            if (m?.role !== 'assistant') break;
            const answer = contentText(m.content).trim();
            if (answer) this.summary = answer;
            this.stopReason = m.stopReason ?? '';
            this.cost += m.usage?.cost?.total ?? 0;
            this.tokens += m.usage?.totalTokens ?? 0;
            if (m.stopReason === 'error' || m.stopReason === 'aborted') {
                this.error = m.errorMessage || (m.stopReason === 'aborted' ? 'dibatalkan' : 'galat dari model');
                this.trace.add('error', 'pi berhenti dengan galat', this.error, { round: this.turn });
            }
            break;
        }
        case 'tool_execution_start':
            this.trace.begin('tool', e.toolCallId ?? '', `${e.toolName ?? 'alat'}`, prettyArguments(JSON.stringify(e.args ?? {})), this.turn);
            break;
        case 'tool_execution_end':
            this.trace.finish('tool', e.toolCallId ?? '', e.isError ? 'failed' : 'ok', contentText(e.result?.content));
            break;
        case 'compaction_start':
            this.trace.add('note', 'pi meringkas konteks', e.reason ?? '');
            break;
        case 'agent_settled':
            this.settled = true;
            break;
        }
    }

    // exitStatus: kode keluar proses; stderr: ekor keluaran galat untuk pesan bila gagal.
    finish(exitStatus: number, stderr: string, stopped = false): HarnessResult {
        let error = this.error;
        if (stopped) error = 'dihentikan pengguna';
        else if (!error && exitStatus !== 0) error = lastLine(stderr) || `pi keluar dengan kode ${exitStatus}`;
        else if (!error && this.stopReason && this.stopReason !== 'stop') error = `pi berhenti: ${this.stopReason}`;
        else if (!error && !this.settled && !this.summary) error = lastLine(stderr) || 'pi selesai tanpa jawaban';
        const result = { ok: !error, summary: this.summary, error, cost: this.cost, tokens: this.tokens, sessionId: this.sessionId };
        this.trace.add(error ? 'error' : 'usage', error ? `Gagal: ${error}` : 'Selesai',
            `${this.tokens} token · $${this.cost.toFixed(4)}${this.sessionId ? `\nSesi: ${this.sessionId}` : ''}`);
        return result;
    }
}

const lastLine = (text: string): string => text.trim().split('\n').filter(l => l.trim()).pop()?.trim().slice(0, 300) ?? '';

// Satu baris catatan kartu dari hasil harness, supaya hasilnya tetap terlihat setelah aplikasi ditutup.
export function resultNote(agent: string, result: HarnessResult, stamp: string): string {
    if (!result.ok) return `↳ ${agent} gagal ${stamp}: ${result.error}`;
    // Lewati pembuka ("Selesai.") dan judul bagian ("**Yang diubah:**"); ambil baris isi pertama.
    const plain = result.summary.split('\n').map(l => l.replace(/^\s*(?:[#>*-]+\s*|\d+\.\s+)+/, '').replace(/\*\*/g, '').trim()).filter(Boolean);
    const first = plain.find(l => !/^(selesai|sudah selesai|done|beres|ok)\b[.!]?$/i.test(l) && !l.endsWith(':')) ?? plain[0] ?? 'selesai';
    const clipped = first.length > 160 ? `${first.slice(0, 157)}…` : first;
    return `↳ ${agent} selesai ${stamp}: ${clipped}`;
}

// ---------- Antrean ----------

export type RunStatus = 'queued' | 'working' | 'done' | 'failed' | 'stopped';

export interface Run {
    id: number;
    board: string;          // path papan
    card: string;           // teks kartu saat dijalankan (pengenal kartu)
    title: string;
    agent: string;
    project: string;        // nama proyek
    folder: string;         // folder proyek; satu harness per folder dalam satu waktu
    prompt: string;
    status: RunStatus;
    trace: AgentTrace;
    result: HarnessResult | null;
}

// Satu folder proyek hanya dikerjakan satu harness sekaligus supaya tidak saling menimpa; kartu lain menunggu.
export class RunQueue {
    readonly runs: Run[] = [];
    private seq = 0;

    add(run: Omit<Run, 'id' | 'status' | 'trace' | 'result'>, trace = new AgentTrace()): Run {
        const busy = this.runs.some(r => r.folder === run.folder && (r.status === 'working' || r.status === 'queued'));
        const added: Run = { ...run, id: ++this.seq, status: busy ? 'queued' : 'working', trace, result: null };
        this.runs.push(added);
        return added;
    }

    // Run terakhir untuk kartu ini (yang aktif didahulukan).
    find(board: string, card: string): Run | null {
        const mine = this.runs.filter(r => r.board === board && r.card === card);
        return mine.find(r => r.status === 'working' || r.status === 'queued') ?? mine[mine.length - 1] ?? null;
    }

    active(board: string, card: string): Run | null {
        const run = this.find(board, card);
        return run && (run.status === 'working' || run.status === 'queued') ? run : null;
    }

    // Tandai selesai lalu kembalikan run berikutnya di folder yang sama (sudah ditandai working), bila ada.
    end(run: Run, status: 'done' | 'failed' | 'stopped'): Run | null {
        const wasWorking = run.status === 'working';
        run.status = status;
        if (!wasWorking) return null;   // membatalkan antrean tidak memberi giliran: folder itu masih dikerjakan yang lain
        const next = this.runs.find(r => r.folder === run.folder && r.status === 'queued');
        if (next) next.status = 'working';
        return next ?? null;
    }

    get running(): Run[] {
        return this.runs.filter(r => r.status === 'working');
    }
}
