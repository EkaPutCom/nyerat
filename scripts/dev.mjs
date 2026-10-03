// npm run dev: build ulang + buka ulang aplikasi setiap ada file yang disimpan.
//
// GJS tidak bisa memuat ulang kode yang sedang berjalan (tidak ada HMR seperti di
// browser), jadi setiap build selesai aplikasinya ditutup lalu dibuka lagi.
// Bersamaan dengan itu, `tsc --watch` memeriksa tipe dan melaporkan kesalahannya
// di terminal yang sama (Vite sendiri tidak memeriksa tipe).
//
// Argumen setelah `--` diteruskan ke aplikasi:
//   npm run dev -- catatan.md
//   npm run dev -- ~/catatan
//
// Perhatian: perubahan di editor yang belum disimpan hilang setiap aplikasi dibuka ulang.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'vite';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP_ARGS = process.argv.slice(2);

const color = (code, text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const log = (tag, code, message) => console.log(`${color(code, `[${tag}]`)} ${message}`);
const info = message => log('dev', 36, message);

// ---------- Aplikasi ----------

let app = null;          // proses gjs yang sedang berjalan
let restarting = false;

function startApp() {
    const child = spawn('gjs', ['-m', 'dist/nyerat.js', ...APP_ARGS], { cwd: ROOT, stdio: 'inherit' });
    app = child;
    child.on('exit', (code, signal) => {
        if (app !== child) return;  // proses lama yang sengaja dihentikan saat restart
        app = null;
        if (!restarting) info(`aplikasi ditutup (${signal ?? `kode ${code}`}); akan dibuka lagi setelah perubahan berikutnya`);
    });
    child.on('error', error => info(`gagal menjalankan gjs: ${error.message}`));
}

// Hentikan aplikasi lama (jika ada) dan tunggu sampai benar-benar keluar.
function stopApp() {
    const child = app;
    if (!child) return Promise.resolve();
    app = null;
    return new Promise(resolve => {
        const force = setTimeout(() => child.kill('SIGKILL'), 2000);
        child.once('exit', () => {
            clearTimeout(force);
            resolve();
        });
        child.kill('SIGTERM');
    });
}

async function restartApp() {
    restarting = true;
    const wasRunning = app !== null;
    await stopApp();
    startApp();
    restarting = false;
    info(wasRunning ? 'aplikasi dibuka ulang' : 'aplikasi dibuka');
}

// ---------- Pemeriksaan tipe ----------

// detached: tsc berjalan di grup prosesnya sendiri, supaya saat berhenti seluruh
// grup (npx beserta tsc yang dijalankannya) bisa dihentikan sekaligus.
const tsc = spawn('npx', ['tsc', '--noEmit', '--watch', '--preserveWatchOutput'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
const prefixLines = stream => stream.on('data', chunk => {
    for (const line of chunk.toString().split('\n')) if (line.trim()) log('tipe', 35, line);
});
prefixLines(tsc.stdout);
prefixLines(tsc.stderr);

// ---------- Build ----------

const watcher = await build({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'warn', build: { watch: {} } });

// Satu putaran build: START → BUNDLE_END atau ERROR → END. Vite tetap mengirim END
// walaupun build gagal, jadi kegagalan dicatat dan aplikasi tidak dibuka ulang.
let failed = false;
watcher.on('event', event => {
    if (event.code === 'START') {
        failed = false;
        info('mem-build…');
    }
    if (event.code === 'BUNDLE_END') event.result?.close?.();
    if (event.code === 'ERROR') {
        failed = true;  // detail error sudah dicetak Vite
        event.result?.close?.();
    }
    if (event.code === 'END') {
        if (failed) log('dev', 31, 'build gagal; aplikasi lama tetap berjalan');
        else restartApp();
    }
});

// ---------- Selesai (Ctrl+C) ----------

let exiting = false;
async function shutdown() {
    if (exiting) return;
    exiting = true;
    info('berhenti');
    try {
        process.kill(-tsc.pid, 'SIGTERM');  // pid negatif = seluruh grup proses
    } catch {
        // sudah berhenti
    }
    await watcher.close();
    await stopApp();
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

info(`memantau perubahan di src/ dan tests/ (Ctrl+C untuk berhenti)${APP_ARGS.length ? `; argumen aplikasi: ${APP_ARGS.join(' ')}` : ''}`);
