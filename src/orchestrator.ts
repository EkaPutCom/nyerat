// Nyerat sebagai orkestrator harness: kartu kanban yang ditugaskan (mis. "@pi") dikerjakan program agent
// eksternal di folder proyeknya sendiri. Di sini proses dijalankan (async), keluarannya
// dibaca baris demi baris, dan kartu dipindah sesuai statusnya. Bagian murni (prompt, pembaca JSON, antrean)
// ada di agent/harness.ts. Nyerat tidak menulis apa pun ke folder proyek; yang ditulis hanya papan sendiri.

import GLib from 'gi://GLib';
import { assignCard, cardMeta, moveCard, updateCard, type Board, type Position } from './markdown/kanban.js';
import { buildPrompt, checkProjectFolder, HARNESSES, locateCard, PiReader, resultNote, RunQueue, stageColumn, type HarnessSpec, type Run } from './agent/harness.js';

export interface HarnessProcess {
    stop(): void;
}

export interface SpawnHandlers {
    line(text: string): void;
    exit(status: number, stderr: string): void;
}

// Melempar bila program tidak bisa dijalankan.
export type Spawner = (argv: string[], cwd: string, handlers: SpawnHandlers) => HarnessProcess;

const STDERR_TAIL = 8000;
const DRAIN_MS = 1500;   // tenggang membaca sisa keluaran setelah proses keluar
const KILL_MS = 5000;    // SIGTERM tidak digubris selama ini → SIGKILL

// Pipe dibaca lewat GLib.IOChannel, bukan Gio.Subprocess.get_stdout_pipe(): setelah Gtk dimuat, GJS membungkus
// pipe itu sebagai Gio.UnixInputStream dan mencetak Gjs-WARNING "moved to a separate platform-specific library".
export const spawnHarness: Spawner = (argv, cwd, handlers) => {
    // Melempar GLib.Error bila program tidak bisa dijalankan.
    const [, pid, stdin, stdout, stderrFd] = GLib.spawn_async_with_pipes(cwd, argv, null, GLib.SpawnFlags.DO_NOT_REAP_CHILD, null);
    // stdin langsung ditutup, jadi harness yang menunggu masukan mendapat EOF, bukan menggantung.
    GLib.close(stdin);
    let stderr = '';
    let status = 0;
    let exited = false;
    let pending = 3;   // stdout habis, stderr habis, proses keluar
    let drainTimer = 0, killTimer = 0;
    const streams: ((fromWatch?: boolean) => void)[] = [];   // penutup pembaca yang masih jalan
    const done = () => {
        if (--pending > 0) return;
        if (drainTimer) GLib.source_remove(drainTimer);
        if (killTimer) GLib.source_remove(killTimer);
        drainTimer = killTimer = 0;
        GLib.spawn_close_pid(pid!);
        handlers.exit(status, stderr);
    };

    // Baris dipisah hanya pada LF, sesuai framing JSONL pi.
    const readLines = (fd: number, onLine: (text: string) => void) => {
        const channel = GLib.IOChannel.unix_new(fd);
        channel.set_close_on_unref(true);
        channel.set_flags(GLib.IOFlags.NONBLOCK);
        let open = true;
        const close = (fromWatch = false) => {
            if (!open) return;
            open = false;
            if (!fromWatch) GLib.source_remove(watch);
            try { channel.shutdown(false); } catch { /* sudah tertutup */ }
            done();
        };
        const watch = GLib.io_add_watch(channel, GLib.PRIORITY_DEFAULT, GLib.IOCondition.IN | GLib.IOCondition.HUP | GLib.IOCondition.ERR, () => {
            for (;;) {
                let status: GLib.IOStatus, line: string;
                try { [status, line] = channel.read_line(); } catch { status = GLib.IOStatus.ERROR; line = ''; }
                if (status === GLib.IOStatus.NORMAL) { onLine(line.replace(/\n$/, '')); continue; }
                if (status === GLib.IOStatus.AGAIN) return GLib.SOURCE_CONTINUE;
                close(true);   // EOF atau galat; sumber watch dilepas lewat nilai kembali
                return GLib.SOURCE_REMOVE;
            }
        });
        streams.push(close);
    };
    readLines(stdout, handlers.line);
    readLines(stderrFd, text => { stderr = `${stderr}${text}\n`.slice(-STDERR_TAIL); });

    GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid!, (_pid, wait) => {
        exited = true;
        // Status tunggu POSIX: 7 bit bawah = sinyal (0 = keluar normal), bit 8–15 = kode keluar.
        status = (wait & 0x7f) === 0 ? (wait >> 8) & 0xff : 128 + (wait & 0x7f);
        // Cucu proses (mis. perintah dari alat bash harness) bisa mewarisi pipe dan menahannya terbuka;
        // jangan menunggu mereka tanpa batas.
        if (pending > 1) drainTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DRAIN_MS, () => { drainTimer = 0; for (const close of streams) close(); return GLib.SOURCE_REMOVE; });
        done();
    });
    // GLib tidak punya kill(); sinyal dikirim lewat perintah kill bawaan sistem.
    const signal = (name: string) => { try { GLib.spawn_async(null, ['kill', `-${name}`, String(pid)], null, GLib.SpawnFlags.SEARCH_PATH, null); } catch { /* proses sudah tiada */ } };
    return {
        stop: () => {
            if (exited) return;
            signal('TERM');
            if (!killTimer) killTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, KILL_MS, () => { killTimer = 0; if (!exited) signal('KILL'); return GLib.SOURCE_REMOVE; });
        },
    };
};

// Aplikasi yang dibuka dari menu desktop sering tidak mewarisi PATH shell (mis. ~/.local/bin dari profil).
export function findProgram(name: string): string | null {
    const found = GLib.find_program_in_path(name);
    if (found) return found;
    const home = GLib.get_home_dir();
    for (const dir of ['.local/bin', '.npm-global/bin', 'bin', '.local/share/mise/shims']) {
        const path = GLib.build_filenamev([home, dir, name]);
        if (GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE) && !GLib.file_test(path, GLib.FileTest.IS_DIR)) return path;
    }
    return null;
}

export interface OrchestratorHost {
    workspace(): string | null;
    // Ubah papan di path itu (terbuka di tab atau di disk). Mengembalikan pesan galat atau null.
    updateBoard(file: string, edit: (board: Board) => Board): string | null;
    // Status sebuah run berubah: gambar ulang papan, beri kabar.
    changed(run: Run, message: string | null): void;
}

interface Live {
    reader: PiReader;
    proc: HarnessProcess | null;
    stopped: boolean;
}

export class Orchestrator {
    readonly queue = new RunQueue();
    spawn: Spawner = spawnHarness;
    program: (spec: HarnessSpec) => string | null = spec => findProgram(spec.program);
    stamp: () => string = () => GLib.DateTime.new_now_local().format('%d/%m %H:%M') ?? '';
    private readonly live = new Map<number, Live>();
    private disposed = false;

    constructor(private readonly host: OrchestratorHost) {}

    // Tugaskan kartu ke harness dan jalankan (atau antrekan bila folder proyeknya sedang dikerjakan).
    // Mengembalikan pesan galat atau null.
    start(boardFile: string, board: Board, at: Position, agent: string, project: string, folder: string, boardName: string): string | null {
        const spec = HARNESSES[agent];
        if (!spec) return `harness "${agent}" tidak dikenal`;
        const card = board.columns[at.column]?.cards[at.index];
        if (!card) return 'kartu tidak ditemukan';
        if (this.queue.active(boardFile, card.text)) return 'kartu ini sedang dikerjakan';
        const problem = checkProjectFolder(folder, this.host.workspace());
        if (problem) return problem;
        if (!GLib.file_test(folder, GLib.FileTest.IS_DIR)) return `folder proyek tidak ada: ${folder}`;

        const text = assignCard(card.text, agent);
        if (text !== card.text) {
            const error = this.editCard(boardFile, card.text, (b, pos) => updateCard(b, pos, { text }));
            if (error) return error;
        }
        const assigned = { ...card, text };
        const run = this.queue.add({
            board: boardFile, card: text, title: shortTitle(text), agent, project, folder,
            prompt: buildPrompt(assigned, project, boardName),
        });
        run.trace.add('turn', `${spec.label} untuk “${run.title}”`, `Folder proyek: ${folder}\n\n${run.prompt}`);
        this.live.set(run.id, { reader: new PiReader(run.trace), proc: null, stopped: false });
        if (run.status === 'working') this.launch(run);
        else this.host.changed(run, `${spec.label} sedang mengerjakan kartu lain di ${project}; kartu ini menunggu giliran`);
        return null;
    }

    stop(run: Run): void {
        const live = this.live.get(run.id);
        if (!live) return;
        live.stopped = true;
        if (run.status === 'queued') this.finish(run, 0, '');
        else live.proc?.stop();
    }

    // Jendela ditutup: hentikan semua harness supaya tidak tertinggal tanpa pemantau.
    dispose(): void {
        this.disposed = true;
        for (const run of this.queue.runs) {
            const live = this.live.get(run.id);
            if (run.status === 'working' && live?.proc) { live.stopped = true; live.proc.stop(); }
        }
    }

    private launch(run: Run): void {
        const spec = HARNESSES[run.agent];
        const live = this.live.get(run.id)!;
        const program = this.program(spec);
        if (!program) {
            run.trace.add('error', `${spec.label} tidak ditemukan`, `Program "${spec.program}" tidak ada di PATH atau ~/.local/bin.`);
            this.finish(run, 127, `program "${spec.program}" tidak ditemukan`);
            return;
        }
        const doing = this.editCard(run.board, run.card, (b, pos) => {
            const column = stageColumn(b, 'doing');
            return column < 0 || column === pos.column ? b : moveCard(b, pos, { column, index: Infinity });
        });
        if (doing) run.trace.add('note', 'Kartu tidak dipindah', doing);
        try {
            live.proc = this.spawn([program, ...spec.args(run.prompt, run.title)], run.folder, {
                line: text => { if (!this.disposed) live.reader.line(text); },
                exit: (status, stderr) => this.finish(run, status, stderr),
            });
        } catch (e) {
            this.finish(run, 127, e instanceof Error ? e.message : String(e));
            return;
        }
        this.host.changed(run, `${spec.label} mulai mengerjakan “${run.title}”`);
    }

    private finish(run: Run, status: number, stderr: string): void {
        const live = this.live.get(run.id);
        if (!live || run.result) return;
        run.result = live.reader.finish(status, stderr, live.stopped);
        const next = this.queue.end(run, live.stopped ? 'stopped' : run.result.ok ? 'done' : 'failed');
        this.live.delete(run.id);
        if (this.disposed) return;
        const spec = HARNESSES[run.agent];
        if (!live.stopped) {
            const note = resultNote(spec.label, run.result, this.stamp());
            const error = this.editCard(run.board, run.card, (b, pos) => {
                const card = b.columns[pos.column].cards[pos.index];
                const noted = updateCard(b, pos, { notes: [...card.notes, note] });
                const review = stageColumn(noted, 'review');
                return run.result!.ok && review >= 0 && review !== pos.column ? moveCard(noted, pos, { column: review, index: Infinity }) : noted;
            });
            if (error) run.trace.add('note', 'Papan tidak diperbarui', error);
        }
        const message = live.stopped ? `${spec.label} dihentikan: “${run.title}”`
            : run.result.ok ? `${spec.label} selesai: “${run.title}”` : `${spec.label} gagal: ${run.result.error}`;
        this.host.changed(run, message);
        if (next) this.launch(next);
    }

    // Kartu dicari ulang di papan terkini (pengguna mungkin sudah memindahkannya). Tidak ada → biarkan papan.
    private editCard(file: string, cardText: string, edit: (board: Board, at: Position) => Board): string | null {
        let missing = false;
        const error = this.host.updateBoard(file, board => {
            const at = locateCard(board, cardText);
            if (!at) { missing = true; return board; }
            return edit(board, at);
        });
        return error ?? (missing ? 'kartu tidak ditemukan di papan (teksnya mungkin sudah diubah)' : null);
    }
}

// Judul pendek untuk pesan, nama sesi pi, dan log.
function shortTitle(text: string): string {
    const title = cardMeta(text).title;
    return title.length > 60 ? `${title.slice(0, 57)}…` : title;
}
