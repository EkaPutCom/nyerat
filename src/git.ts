// Membaca riwayat git sebuah file lewat perintah `git`. Satu-satunya perubahan pada repositori
// adalah commitFile()/commitFiles(), dan hanya atas permintaan pengguna. Semua async (Gio.Subprocess) supaya riwayat panjang tidak menahan editor.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { LOG_FORMAT, parseLog, parseStatus, type Commit, type FileChange } from './gitlog.js';
import { AGENT_LOG_FORMAT, type GitAnswer, type GitRequest } from './agent/gittools.js';

export type GitFailure = 'no-git' | 'no-repo' | 'failed';

export type LogResult =
    | { ok: true; commits: Commit[] }
    | { ok: false; reason: GitFailure; message: string };

export type TextResult =
    | { ok: true; text: string }
    | { ok: false; reason: GitFailure; message: string };

interface Run { status: number; out: string; err: string }

// null = git tidak bisa dijalankan (belum terpasang, atau folder tidak ada).
function runGit(cwd: string, args: string[]): Promise<Run | null> {
    return new Promise(resolve => {
        try {
            const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE });
            launcher.set_cwd(cwd);
            // Jangan ikut berebut kunci indeks dengan git lain yang sedang dipakai pengguna.
            launcher.setenv('GIT_OPTIONAL_LOCKS', '0', true);
            const proc = launcher.spawnv(['git', '-c', 'core.quotePath=false', ...args]);
            proc.communicate_utf8_async(null, null, (_proc, result) => {
                try {
                    const [, out, err] = proc.communicate_utf8_finish(result);
                    resolve({ status: proc.get_if_exited() ? proc.get_exit_status() : -1, out: out ?? '', err: err ?? '' });
                } catch (e) {
                    resolve(null);
                }
            });
        } catch (e) {
            resolve(null);
        }
    });
}

function failure(run: Run | null): { ok: false; reason: GitFailure; message: string } {
    if (!run) return { ok: false, reason: 'no-git', message: 'git tidak dapat dijalankan' };
    // `git commit` melaporkan masalah (mis. "nothing to commit", user.name kosong) lewat stdout atau stderr.
    const message = (run.err.trim() || run.out.trim());
    return { ok: false, reason: /not a git repository/i.test(message) ? 'no-repo' : 'failed', message };
}

const dirOf = (file: string) => GLib.path_get_dirname(file);
const nameOf = (file: string) => GLib.path_get_basename(file);

// Commit yang menyentuh file, terbaru dulu, mengikuti rename. skip/limit untuk memuat bertahap.
export async function fileLog(file: string, skip: number, limit: number): Promise<LogResult> {
    const run = await runGit(dirOf(file), [
        'log', '--follow', '--name-only', `--format=${LOG_FORMAT}`, `--skip=${skip}`, '-n', String(limit),
        '--', `:(literal)${nameOf(file)}`,
    ]);
    if (run?.status === 0) return { ok: true, commits: parseLog(run.out) };
    // Repo baru tanpa commit bukan kegagalan; riwayatnya memang kosong.
    if (run && /does not have any commits/i.test(run.err)) return { ok: true, commits: [] };
    return failure(run);
}

// Perubahan file pada satu commit (terhadap commit induknya).
export async function commitDiff(file: string, commit: Commit): Promise<TextResult> {
    const run = await runGit(dirOf(file), [
        'show', '--format=', '--no-color', '--no-ext-diff', '--no-textconv', commit.hash,
        '--', `:(top,literal)${commit.path ?? nameOf(file)}`,
    ]);
    return run?.status === 0 ? { ok: true, text: run.out } : failure(run);
}

// Isi lengkap file pada commit itu.
export async function commitContent(file: string, commit: Commit): Promise<TextResult> {
    // `./nama` dihitung dari folder file; dipakai jika path commit tidak diketahui.
    const spec = commit.path ?? `./${nameOf(file)}`;
    const run = await runGit(dirOf(file), ['show', '--no-textconv', `${commit.hash}:${spec}`]);
    return run?.status === 0 ? { ok: true, text: run.out } : failure(run);
}

// Commit di repositori folder `dir` dalam rentang waktu [since, until) (detik Unix), terbaru dulu.
// Untuk bagian Aktivitas jurnal; folder tanpa git atau tanpa repo menghasilkan daftar kosong.
export async function commitsBetween(dir: string, since: number, until: number): Promise<Commit[]> {
    const run = await runGit(dir, ['log', `--since=@${since}`, `--until=@${until - 1}`, `--format=${LOG_FORMAT}`]);
    return run?.status === 0 ? parseLog(run.out).filter(c => c.time >= since && c.time < until) : [];
}

export type WorkingState = 'clean' | 'modified' | 'untracked';

export type StateResult =
    | { ok: true; state: WorkingState }
    | { ok: false; reason: GitFailure; message: string };

// Apakah file berbeda dari commit terakhir (termasuk yang sudah di-stage atau belum dilacak).
export async function workingState(file: string): Promise<StateResult> {
    const run = await runGit(dirOf(file), ['status', '--porcelain=v1', '--', `:(literal)${nameOf(file)}`]);
    if (run?.status !== 0) return failure(run);
    const line = run.out.split('\n')[0];
    if (!line.trim()) return { ok: true, state: 'clean' };
    return { ok: true, state: line.startsWith('??') ? 'untracked' : 'modified' };
}

export type ChangesResult =
    | { ok: true; changes: FileChange[] }
    | { ok: false; reason: GitFailure; message: string };

// Semua file di repositori folder ini yang berbeda dari commit terakhir; path-nya absolut.
export async function repoChanges(dir: string): Promise<ChangesResult> {
    const root = await runGit(dir, ['rev-parse', '--show-toplevel']);
    if (root?.status !== 0) return failure(root);
    const run = await runGit(dir, ['status', '--porcelain=v1', '--untracked-files=all']);
    if (run?.status !== 0) return failure(run);
    const top = root.out.trim();
    return { ok: true, changes: parseStatus(run.out).map(c => ({ ...c, path: GLib.build_filenamev([top, c.path]) })) };
}

// Perubahan file yang belum di-commit, terhadap HEAD. File baru (belum dilacak) ditampilkan
// seluruhnya sebagai tambahan; repo tanpa commit dibandingkan dengan indeks.
export async function workingDiff(file: string): Promise<TextResult> {
    const state = await workingState(file);
    if (!state.ok) return state;
    if (state.state === 'clean') return { ok: true, text: '' };
    const flags = ['--no-color', '--no-ext-diff', '--no-textconv'];
    const spec = `:(literal)${nameOf(file)}`;
    if (state.state === 'untracked') {
        // --no-index keluar dengan status 1 jika ada beda; itu hasil normal.
        const run = await runGit(dirOf(file), ['diff', ...flags, '--no-index', '--', '/dev/null', nameOf(file)]);
        return run && run.status <= 1 ? { ok: true, text: run.out } : failure(run);
    }
    let run = await runGit(dirOf(file), ['diff', ...flags, 'HEAD', '--', spec]);
    if (run && run.status !== 0 && /unknown revision|bad revision|ambiguous argument 'HEAD'/i.test(run.err)) {
        run = await runGit(dirOf(file), ['diff', ...flags, '--cached', '--', spec]);
    }
    return run?.status === 0 ? { ok: true, text: run.out } : failure(run);
}

// Commit hanya file ini; perubahan file lain yang sudah di-stage tidak ikut. File baru di-add
// dulu karena `git commit -- path` menolak path yang belum dilacak.
export async function commitFile(file: string, message: string): Promise<TextResult> {
    const spec = `:(literal)${nameOf(file)}`;
    const add = await runGit(dirOf(file), ['add', '--', spec]);
    if (add?.status !== 0) return failure(add);
    const run = await runGit(dirOf(file), ['commit', '--only', '--no-verify', '-m', message, '--', spec]);
    return run?.status === 0 ? { ok: true, text: run.out } : failure(run);
}

// Commit beberapa file sekaligus (path absolut); file lain yang sudah di-stage tidak ikut. Path dihitung dari
// akar repo karena folder file bisa berbeda-beda.
export async function commitFiles(files: string[], message: string): Promise<TextResult> {
    if (!files.length) return { ok: false, reason: 'failed', message: 'Tidak ada file yang dipilih' };
    const dir = dirOf(files[0]);
    const root = await runGit(dir, ['rev-parse', '--show-toplevel']);
    if (root?.status !== 0) return failure(root);
    const top = root.out.trim();
    const specs = files.map(f => `:(top,literal)${f.startsWith(top + '/') ? f.slice(top.length + 1) : f}`);
    const add = await runGit(dir, ['add', '--all', '--', ...specs]);
    if (add?.status !== 0) return failure(add);
    const run = await runGit(dir, ['commit', '--only', '--no-verify', '-m', message, '--', ...specs]);
    return run?.status === 0 ? { ok: true, text: run.out } : failure(run);
}

// Pathspec alat Git agent: hanya berkas Markdown, tanpa berkas/folder bertitik dan node_modules, relatif ke folder kerja.
const AGENT_SPECS = ['*.md', '*.markdown', '*.mdown', '*.mkd', ':(exclude,glob)**/.*', ':(exclude,glob)**/.*/**', ':(exclude,glob)**/node_modules/**'];
const AGENT_DATE = '--date=format:%Y-%m-%d %H:%M';

// Menjalankan permintaan yang sudah divalidasi agent/gittools.ts (hash/HEAD~n dan path Markdown relatif) di folder kerja.
export async function agentGit(root: string, request: GitRequest): Promise<GitAnswer> {
    const specs = request.file ? [`:(literal)${request.file}`] : AGENT_SPECS;
    let args: string[];
    if (request.kind === 'log') {
        args = ['log', '--relative', '--no-color', AGENT_DATE, '--name-status', `--format=${AGENT_LOG_FORMAT}`, '-n', String(request.limit),
            ...(request.file ? ['--follow'] : []), '--', ...specs];
    } else if (request.kind === 'show') {
        args = ['show', '--relative', '--no-color', '--no-ext-diff', '--no-textconv', AGENT_DATE, '--format=%h %ad · %an · %s', request.commit, '--', ...specs];
    } else {
        args = ['show', '--no-textconv', `${request.commit}:./${request.file}`];
    }
    const run = await runGit(root, args);
    if (run?.status === 0) return { ok: true, text: run.out };
    if (run && request.kind === 'log' && /does not have any commits/i.test(run.err)) return { ok: true, text: '' };
    return { ok: false, message: failure(run).message };
}
