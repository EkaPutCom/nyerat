// Log kegiatan agent (murni, tanpa GTK): urutan kejadian satu percakapan, dari putaran model, penalaran,
// panggilan alat beserta argumen dan hasilnya, sampai usulan perubahan. Hanya untuk dilihat pengguna;
// tidak pernah dikirim ke model dan tidak ikut berkas percakapan.

export type TraceKind = 'turn' | 'round' | 'reasoning' | 'text' | 'tool' | 'usage' | 'note' | 'error';

export interface TraceEvent {
    seq: number;
    time: string;          // ISO lokal, mis. 2026-10-05T14:20:00
    kind: TraceKind;
    round?: number;        // putaran model (mulai 1) tempat kejadian ini terjadi
    title: string;
    detail: string;        // isi lengkap (penalaran, argumen, hasil), sudah dipotong ke MAX_DETAIL
    status?: 'running' | 'ok' | 'failed';
    ms?: number;           // lama kejadian, bila ada
}

const MAX_DETAIL = 20000;
const MAX_EVENTS = 2000;

const clip = (text: string): string => text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}\n… (${text.length - MAX_DETAIL} karakter lagi dipotong)` : text;

// Argumen alat adalah JSON mentah dari model; tampilkan rapi bila valid, apa adanya bila tidak.
export function prettyArguments(raw: string): string {
    if (!raw.trim()) return '(tanpa argumen)';
    try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
}

export class AgentTrace {
    readonly events: TraceEvent[] = [];
    private seq = 0;
    private open = new Map<string, number>();   // kunci → indeks kejadian yang masih berjalan, untuk dilengkapi nanti
    private starts = new Map<string, number>();
    onChange: () => void = () => {};

    constructor(private readonly now: () => number = Date.now, private readonly stamp: () => string = () => new Date().toISOString().slice(0, 19)) {}

    clear(): void {
        this.events.length = 0;
        this.open.clear();
        this.starts.clear();
        this.onChange();
    }

    add(kind: TraceKind, title: string, detail = '', extra: Partial<Pick<TraceEvent, 'round' | 'status' | 'ms'>> = {}): TraceEvent {
        const event: TraceEvent = { seq: ++this.seq, time: this.stamp(), kind, title, detail: clip(detail), ...extra };
        this.events.push(event);
        if (this.events.length > MAX_EVENTS) {
            this.events.splice(0, this.events.length - MAX_EVENTS);
            this.open.clear();   // indeks bergeser; kejadian yang masih berjalan sudah terlalu tua untuk dilengkapi
        }
        this.onChange();
        return event;
    }

    // Mulai kejadian yang selesainya menyusul (panggilan alat, putaran model); dilengkapi lewat finish() dengan kunci yang sama.
    begin(kind: TraceKind, key: string, title: string, detail = '', round?: number): void {
        const event = this.add(kind, title, detail, { round, status: 'running' });
        this.open.set(`${kind}:${key}`, this.events.indexOf(event));
        this.starts.set(`${kind}:${key}`, this.now());
    }

    finish(kind: TraceKind, key: string, status: 'ok' | 'failed', detail?: string, title?: string): void {
        const k = `${kind}:${key}`;
        const index = this.open.get(k);
        const started = this.starts.get(k);
        this.open.delete(k);
        this.starts.delete(k);
        if (index === undefined) return;
        const event = this.events[index];
        if (!event) return;
        event.status = status;
        if (detail !== undefined) event.detail = clip(event.detail ? `${event.detail}\n\n${detail}` : detail);
        if (title) event.title = title;
        if (started !== undefined) event.ms = this.now() - started;
        this.onChange();
    }

    // Penalaran dan jawaban mengalir sedikit-sedikit: sambung ke kejadian terakhir yang sejenis dalam putaran yang sama.
    append(kind: 'reasoning' | 'text', round: number, delta: string): void {
        const last = this.events[this.events.length - 1];
        if (last && last.kind === kind && last.round === round) {
            last.detail = clip(last.detail + delta);
            this.onChange();
        } else {
            this.add(kind, kind === 'reasoning' ? 'Penalaran model' : 'Jawaban model', delta, { round });
        }
    }

    // Satu kejadian sebagai teks biasa, untuk disalin atau diekspor.
    static format(e: TraceEvent): string {
        const head = `[${e.time.slice(11)}]${e.round ? ` putaran ${e.round} ·` : ''} ${e.title}${e.ms !== undefined ? ` (${e.ms} ms)` : ''}${e.status === 'failed' ? ' — GAGAL' : ''}`;
        return e.detail ? `${head}\n${e.detail}` : head;
    }

    text(): string {
        return this.events.map(AgentTrace.format).join('\n\n');
    }

    // Satu objek JSON per baris, untuk dianalisis di luar aplikasi.
    jsonl(): string {
        return this.events.map(e => JSON.stringify(e)).join('\n') + (this.events.length ? '\n' : '');
    }
}
