// Kerangka tes mini yang dipakai semua modul tes: pencatat hasil dan fungsi asersi.

import GLib from 'gi://GLib';
import System from 'system';

const argv = System.programArgs;
export const opt = (name: string) => argv.includes(`--${name}`);
export const optVal = (name: string) => argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

// Folder proyek. Modul ini berada di tests/ (sumber) atau dist/chunks/ (hasil build),
// jadi dihitung dari lokasi entry (run-tests) lewat setRoot.
export let ROOT = '';
export function setRoot(url: string): void {
    ROOT = GLib.path_get_dirname(GLib.path_get_dirname(GLib.filename_from_uri(url)[0]));
}

// Pengaturan dan file tes ditaruh di folder sementara, bukan ~/.config. Aman di-set
// setelah import karena settings.ts baru membaca XDG_CONFIG_HOME saat dipanggil.
export const tmp = GLib.dir_make_tmp('nyerat-test-XXXXXX');
GLib.setenv('XDG_CONFIG_HOME', tmp, true);

export const errorMessage = (e: unknown): string => e instanceof Error ? e.message : String(e);

export const RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

let passed = 0, failed = 0;

export function section(name: string): void { print(`\n${name}`); }

export function test(name: string, fn: () => void): void {
    try {
        fn();
        passed++;
        print(`  ${GREEN}✓${RESET} ${name}`);
    } catch (e) {
        failed++;
        print(`  ${RED}✗ ${name}${RESET}\n    ${errorMessage(e).split('\n').join('\n    ')}`);
    }
}

// Dipakai runner untuk kegagalan di luar test(), mis. tes GUI yang berhenti di tengah jalan.
export function recordFailure(): void { failed++; }

export function summary(): { passed: number; failed: number } { return { passed, failed }; }

export function eq(actual: unknown, expected: unknown, what = 'nilai'): void {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${what} salah\n    dapat:    ${a}\n    harapan:  ${b}`);
}

export function ok(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

export function contains(haystack: string, needle: string): void {
    if (!haystack.includes(needle)) throw new Error(`tidak mengandung ${JSON.stringify(needle)}\n    dalam: ${JSON.stringify(haystack.slice(0, 300))}`);
}

// Menunggu Promise selesai sambil menjalankan main loop (tes bersifat sinkron). Melempar jika galat atau lewat batas waktu.
export function settle<T>(promise: Promise<T>, timeoutMs = 10000): T {
    let done = false, value: T | undefined, error: unknown;
    const loop = new GLib.MainLoop(null, false);
    const finish = () => { done = true; loop.quit(); };
    promise.then(v => { value = v; finish(); }, e => { error = e; finish(); });
    const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => { loop.quit(); return GLib.SOURCE_REMOVE; });
    if (!done) loop.run();
    if (done) GLib.source_remove(timer);
    if (!done) throw new Error('Promise tidak selesai sebelum batas waktu');
    if (error) throw error;
    return value as T;
}
