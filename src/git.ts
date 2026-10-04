// Membaca riwayat git sebuah file lewat perintah `git`. Hanya baca: tidak pernah mengubah
// repositori. Semua async (Gio.Subprocess) supaya riwayat panjang tidak menahan editor.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { LOG_FORMAT, parseLog, type Commit } from './gitlog.js';

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
    const message = run.err.trim();
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
