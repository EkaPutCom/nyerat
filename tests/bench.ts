// Pengujian performa Nyerat. Dibundel Vite menjadi dist/bench.js.
//
//   npm run bench                        build, lalu ukur di Xvfb
//   gjs -m dist/bench.js --no-gui        hanya modul Markdown (tanpa jendela)
//   gjs -m dist/bench.js --size=2000     ukuran dokumen (jumlah blok sampel), bawaan 100
//   gjs -m dist/bench.js --runs=10       jumlah pengulangan tiap ukuran, bawaan 10
//   gjs -m dist/bench.js --budget=ms     gagal (kode keluar 1) bila median operasi GUI melebihi ms
//   gjs -m dist/bench.js --sizes=100,400 ukuran dokumen untuk bagian GUI (bawaan: size/4, size/2, size)
//   gjs -m dist/bench.js --fixture=long  dokumen panjang, 10 baris per blok tanpa grid tabel
//   gjs -m dist/bench.js --timeout=120 batas waktu tiap proses GUI (detik)
//   gjs -m dist/bench.js --save=f.json   simpan hasil ke f.json (untuk dibandingkan nanti)
//   gjs -m dist/bench.js --compare=f.json  tampilkan selisih terhadap hasil tersimpan
//
//   npm run bench:save                   simpan ke bench/<tanggal-waktu>.json
//   npm run bench:compare                bandingkan dengan bench/baseline.json
//
// Hasil berupa median, p95, dan maksimum; JSON juga menyimpan sampel mentah.

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=3.0';
import Gdk from 'gi://Gdk?version=3.0';
import Gio from 'gi://Gio';
import System from 'system';

import { DIM, GREEN, RED, RESET, errorMessage, opt, optVal } from './framework.js';
import { readTextFile, writeTextFile } from '../src/files.js';
import { DEFAULTS } from '../src/settings.js';
import { MainWindow } from '../src/window.js';
import { markdownToHtml } from '../src/markdown/html.js';
import { parseInline } from '../src/markdown/inline.js';
import { findTables, parseTable, renderTable } from '../src/markdown/table.js';
import { parseBoard, serializeBoard } from '../src/markdown/kanban.js';

const FIXTURE = optVal('fixture') ?? 'mixed';
if (!['mixed', 'long'].includes(FIXTURE)) { printerr('--fixture harus mixed atau long.'); System.exit(1); }
const SIZE = Number(optVal('size') ?? 100);
const RUNS = Number(optVal('runs') ?? 10);
const GUI_SIZES = (optVal('sizes') ?? [...new Set([SIZE / 4, SIZE / 2, SIZE].map(n => Math.max(1, Math.round(n))))].join(',')).split(',').map(Number);
const TIMEOUT = Number(optVal('timeout') ?? 120);
const BUDGET = optVal('budget') !== undefined ? Number(optVal('budget')) : null;

function fail(message: string): never {
    printerr(`Benchmark gagal: ${message}`);
    System.exit(1);
    throw new Error(message);
}
for (const [name, value] of [['size', SIZE], ['runs', RUNS], ['timeout', TIMEOUT], ...GUI_SIZES.map(n => ['sizes', n])] as [string, number][]) {
    if (!Number.isSafeInteger(value) || value <= 0) fail(`--${name} harus bilangan bulat positif.`);
}
if (BUDGET !== null && (!Number.isFinite(BUDGET) || BUDGET <= 0)) fail('--budget harus angka positif.');
if (new Set(GUI_SIZES).size !== GUI_SIZES.length) fail('--sizes tidak boleh berulang.');

let overBudget = false;
let invalid = false;

interface Stats { median: number; p95: number; max: number; samples: number[] }
interface Saved {
    versi: number; tanggal: string; size: number; runs: number; sizes: number[]; fixture?: string; mode: 'model' | 'gui';
    lingkungan: { gjs: number; glib: string; gtk: string; host: string; backend: string; commit: string };
    hasil: Record<string, number>; statistik: Record<string, Stats>;
}
const results: Record<string, number> = {};
const statistics: Record<string, Stats> = {};
let group = '';
const COMPARE = optVal('compare');
let baseline: Saved | null = null;
if (COMPARE) {
    try {
        baseline = JSON.parse(readTextFile(COMPARE)) as Saved;
        if (!baseline || !baseline.hasil || typeof baseline.hasil !== 'object' ||
            Object.values(baseline.hasil).some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0)) {
            fail('format baseline tidak valid.');
        }
    } catch (e) { fail(`baseline tidak dapat dibaca: ${errorMessage(e)}`); }
}
const environment = {
    gjs: System.version,
    glib: `${GLib.MAJOR_VERSION}.${GLib.MINOR_VERSION}.${GLib.MICRO_VERSION}`,
    gtk: `${Gtk.get_major_version()}.${Gtk.get_minor_version()}.${Gtk.get_micro_version()}`,
    host: GLib.get_host_name(), backend: GLib.getenv('GDK_BACKEND') ?? 'default', commit: 'unknown',
};
try {
    const [, stdout, , status] = GLib.spawn_sync(null, ['git', 'rev-parse', 'HEAD'], null, GLib.SpawnFlags.SEARCH_PATH, null);
    if (status === 0) environment.commit = new TextDecoder().decode(stdout!).trim();
} catch { /* Git bukan syarat menjalankan benchmark. */ }
// Commit boleh berbeda: tujuan baseline memang membandingkan perubahan kode.
if (baseline && (baseline.versi !== 2 || baseline.size !== SIZE || (baseline.fixture ?? 'mixed') !== FIXTURE || baseline.runs !== RUNS || baseline.mode !== (opt('no-gui') ? 'model' : 'gui') ||
    (JSON.stringify(baseline.sizes) !== JSON.stringify(GUI_SIZES) && !opt('child')) ||
    !baseline.lingkungan || ['gjs', 'glib', 'gtk', 'host', 'backend'].some(k =>
        baseline!.lingkungan[k as keyof Saved['lingkungan']] !== environment[k as keyof typeof environment]))) {
    if (!opt('child')) print(`${DIM}Baseline tidak setara (format, ukuran, pengulangan, atau lingkungan); selisih dilewati.${RESET}`);
    baseline = null;
}

const BLOCK = `## Bagian

Paragraf dengan **tebal**, *miring*, ~~coret~~, ==sorot==, \`kode\`, dan [tautan](https://example.com).

- Butir satu
- [x] Tugas selesai
- [ ] Tugas belum

> Kutipan singkat

\`\`\`ts
const x: number = 1;
\`\`\`

| A | B | C |
| :-- | :-: | --: |
| **satu** | dua | tiga |
| empat | *lima* | enam |

`;

const KANBAN = (cards: number): string =>
    `---\nkanban: true\n---\n\n` + ['Rencana', 'Dikerjakan', 'Selesai'].map(c =>
        `## ${c}\n\n` + Array.from({ length: cards }, (_, i) => `- [ ] Kartu ${i} #tag @due(2026-01-01)\n`).join('') + '\n').join('');

const doc = (n: number): string => FIXTURE === 'mixed' ? BLOCK.repeat(n) : Array.from({ length: n }, (_, i) =>
    (i % 50 === 0 ? `## Bagian ${i}\n` : `Catatan ${i}\n`) +
    Array.from({ length: 8 }, (_, j) => `Paragraf ${i}.${j} dengan catatan yang berbeda dan cukup panjang untuk dokumen nyata.\n`).join('') + '\n').join('');

const now = (): number => GLib.get_monotonic_time() / 1000;

function measure(fn: () => void, runs = RUNS): number[] {
    fn();  // pemanasan (JIT dan cache)
    const t: number[] = [];
    for (let i = 0; i < runs; i++) { const s = now(); fn(); t.push(now() - s); }
    return t;
}

async function measureAsync(fn: () => Promise<void>, runs = RUNS): Promise<number[]> {
    await fn();
    const t: number[] = [];
    for (let i = 0; i < runs; i++) {
        System.gc();  // selesaikan GC yang tertunda di luar waktu yang diukur (lihat idle())
        const s = now();
        await fn();
        t.push(now() - s);
    }
    return t;
}

// Tunggu sampai main loop menganggur: semua penyorotan, tata letak, dan gambar ulang yang
// antre (prioritasnya lebih tinggi dari LOW) sudah selesai. Kendali benar-benar kembali ke
// GLib, tidak memutar ctx.iteration() dari dalam JS: bila GC GJS sedang berjalan bertahap,
// callback yang dipanggil dari putaran bersarang seperti itu diblokir dan penyorotan mati diam-diam.
const idle = (): Promise<void> => new Promise(resolve => {
    GLib.idle_add(GLib.PRIORITY_LOW, () => { resolve(); return GLib.SOURCE_REMOVE; });
});

function report(name: string, t: number[], budget = false): void {
    if (!t.length || t.some(n => !Number.isFinite(n) || n < 0)) throw new Error(`Sampel ${name} tidak valid.`);
    const sorted = [...t].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const med = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
    const max = sorted[sorted.length - 1];
    const over = budget && BUDGET !== null && med > BUDGET;
    if (over) overBudget = true;
    const key = `${group} / ${name}`;
    results[key] = med;
    statistics[key] = { median: med, p95, max, samples: [...t] };
    const before = baseline?.hasil[key];
    let delta = '';
    if (before !== undefined && before > 0) {
        const pct = (med - before) / before * 100;
        const color = Math.abs(pct) < 25 ? DIM : pct < 0 ? GREEN : RED;
        delta = `   ${color}${pct >= 0 ? '+' : ''}${pct.toFixed(0)}% (dulu ${before.toFixed(2)} ms)${RESET}`;
    }
    print(`  ${name.padEnd(34)} median ${med.toFixed(2)} ms   p95 ${p95.toFixed(2)} ms   maks ${max.toFixed(2)} ms${delta}${over ? `  ${RED}> ${BUDGET} ms${RESET}` : ''}`);
}

function runModelBench(): void {
    group = 'Modul Markdown';
    print(`\nModul Markdown (${SIZE} blok ≈ ${(doc(SIZE).length / 1024).toFixed(0)} KB)`);
    const text = doc(SIZE);
    const lines = text.split('\n');
    report('markdownToHtml', measure(() => markdownToHtml(text, 'bench')));
    report('parseInline (per baris)', measure(() => { for (const l of lines) parseInline(l); }));
    report('findTables', measure(() => findTables(lines)));
    report('parseTable + renderTable', measure(() => {
        for (const r of findTables(lines)) renderTable(parseTable(lines.slice(r.start, r.end)));
    }));
    const kanban = KANBAN(Math.max(10, Math.floor(SIZE / 3)));
    report('parseBoard + serializeBoard', measure(() => serializeBoard(parseBoard(kanban))));
}

// Jendela tidak di-destroy: proses anak langsung keluar, dan destroy memicu peringatan GC dari GJS.
const windows: MainWindow[] = [];
async function runGuiBench(app: Gtk.Application, n: number): Promise<void> {
    const w = new MainWindow(app, { ...DEFAULTS, welcomed: true, dark: false }, null);
    windows.push(w);
    const ed = w.editor;
    const buf = ed.buffer;
    await idle();

    const text = doc(n);
    group = `Editor GUI ${n} blok`;
    print(`\nEditor GUI (${n} blok, ${(text.length / 1024).toFixed(0)} KB)`);
    report('setText + sorot + layout', await measureAsync(async () => { ed.setText(text); await idle(); }), true);
    const sorot = measure(() => ed.highlight());
    report('highlight() ulang', sorot, true);
    // Hitung callback selesai; durasi saja tidak membuktikan penyorotan berjalan.
    let highlights = 0;
    const onHighlighted = ed.onHighlighted;
    ed.onHighlighted = result => { highlights++; onHighlighted(result); };
    const edit = async (fn: () => void): Promise<void> => {
        await idle();
        const before = highlights;
        fn();
        await idle();
        if (highlights <= before) throw new Error('Perubahan teks tidak menyelesaikan penyorotan.');
    };
    const characters: number[] = [];
    let typingRun = 0;
    const ketik = await measureAsync(async () => {
        // Pulihkan dokumen dan posisi agar tiap pengulangan memakai kondisi sama.
        ed.setText(text);
        buf.place_cursor(buf.get_iter_at_line(Math.floor(buf.get_line_count() / 2)));
        await idle();
        for (let i = 0; i < 20; i++) {
            const start = now();
            await edit(() => buf.insert_at_cursor('x', -1));
            if (typingRun > 0) characters.push(now() - start);
        }
        typingRun++;
    });
    // Waktu total di atas mencakup persiapan: laporkan total 20 ketukan dari sampel per karakter.
    report('ketik 20 karakter', Array.from({ length: ketik.length }, (_, i) =>
        characters.slice(i * 20, (i + 1) * 20).reduce((a, b) => a + b, 0)));
    report('ketik per karakter', characters, true);
    // Dokumen besar, Unicode, dan satu baris panjang menguji jalur suntingan berbeda.
    const paste = ('😀 catatan **tebal**\n'.repeat(100)) + 'x'.repeat(10000);
    const prepare = async (): Promise<void> => {
        ed.setText(text);
        buf.place_cursor(buf.get_iter_at_line(Math.floor(buf.get_line_count() / 2)));
        await idle();
    };
    const operation = async (setup: () => Promise<void>, action: () => Promise<void>): Promise<number[]> => {
        const times: number[] = [];
        for (let i = 0; i <= RUNS; i++) {
            System.gc();
            await setup();
            const start = now();
            await action();
            if (i > 0) times.push(now() - start);
        }
        return times;
    };
    report('paste besar + Unicode', await operation(prepare, () => edit(() => buf.insert_at_cursor(paste, -1))), true);
    const inserted = async (): Promise<void> => {
        await prepare();
        buf.begin_user_action();
        await edit(() => buf.insert_at_cursor(paste, -1));
        buf.end_user_action();
    };
    report('hapus teks besar', await operation(inserted, () => edit(() => {
        const end = buf.get_iter_at_mark(buf.get_insert());
        const start = end.copy();
        start.backward_chars(Array.from(paste).length);
        buf.delete(start, end);
    })), true);
    report('undo paste besar', await operation(inserted, () => edit(() => buf.undo())), true);
    report('redo paste besar', await operation(async () => {
        await inserted();
        await edit(() => buf.undo());
    }, () => edit(() => buf.redo())), true);
    await prepare();
    report('pindah kursor 20 baris', await measureAsync(async () => {
        for (let i = 0; i < 20; i++) {
            buf.place_cursor(buf.get_iter_at_line(Math.min(i * 7, buf.get_line_count() - 1)));
            await idle();
        }
    }));
    ed.onHighlighted = onHighlighted;

    buf.set_modified(false);
}

// Mode anak (--child): hanya mengukur GUI untuk --sizes, tanpa header dan footer.
const CHILD = opt('child');

function runGuiInProcess(): void {
    const app = new Gtk.Application({ application_id: 'id.eka.Nyerat.Bench', flags: Gio.ApplicationFlags.NON_UNIQUE });
    app.connect('activate', () => {
        app.hold();
        void (async () => {
            try {
                for (const n of GUI_SIZES) await runGuiBench(app, n);
            } catch (e) {
                invalid = true;
                print(`${RED}Bench GUI berhenti: ${errorMessage(e)}${RESET}\n${e instanceof Error ? e.stack : ''}`);
            }
            app.release();
            app.quit();
        })();
    });
    app.run([System.programInvocationName]);
}

// Tiap ukuran dokumen dijalankan di proses GJS sendiri. Dalam satu proses panjang, GC akhirnya
// membersihkan widget yang sinyalnya masih terhubung; GJS lalu memblokir callback dan penyorotan
// mati diam-diam, sehingga ukuran berikutnya terukur jauh lebih cepat dari sebenarnya.
function runGuiInChildren(): void {
    const script = GLib.filename_from_uri(import.meta.url)[0];
    const dir = GLib.dir_make_tmp('nyerat-bench-XXXXXX');
    for (const n of GUI_SIZES) {
        const out = GLib.build_filenamev([dir, `${n}.json`]);
        const argv = ['timeout', '--kill-after=5s', `${TIMEOUT}s`, 'gjs', '-m', script, '--child', `--sizes=${n}`, `--size=${SIZE}`, `--runs=${RUNS}`, `--fixture=${FIXTURE}`, `--save=${out}`];
        if (BUDGET !== null) argv.push(`--budget=${BUDGET}`);
        if (COMPARE && baseline) argv.push(`--compare=${COMPARE}`);
        const [, stdout, stderr, status] = GLib.spawn_sync(null, argv, null, GLib.SpawnFlags.SEARCH_PATH, null);
        print(new TextDecoder().decode(stdout ?? undefined).trimEnd());
        if (GLib.file_test(out, GLib.FileTest.EXISTS)) {
            const saved = JSON.parse(readTextFile(out)) as Saved;
            Object.assign(results, saved.hasil);
            Object.assign(statistics, saved.statistik);
            if (status !== 0) overBudget = true;
            GLib.unlink(out);
        } else {
            invalid = true;
            print(`${RED}Proses anak untuk ${n} blok gagal.${RESET}\n${new TextDecoder().decode(stderr ?? undefined).slice(0, 2000)}`);
        }
    }
    GLib.rmdir(dir);
}

if (!CHILD) {
    print(`${DIM}Ukuran ${SIZE} blok, ${RUNS} pengulangan${BUDGET !== null ? `, anggaran ${BUDGET} ms` : ''}${RESET}`);
    runModelBench();
}

if (!opt('no-gui')) {
    if (!Gdk.Display.get_default() && !GLib.getenv('DISPLAY') && !GLib.getenv('WAYLAND_DISPLAY')) {
        invalid = true;
        print(`${RED}GUI membutuhkan display; gunakan --no-gui untuk hanya modul Markdown.${RESET}`);
    } else if (CHILD) {
        runGuiInProcess();
    } else {
        runGuiInChildren();
    }
}

const SAVE = optVal('save');
if (SAVE && invalid) print(`${RED}Hasil tidak disimpan karena ada pengukuran tidak valid.${RESET}`);
else if (SAVE) {
    const saved: Saved = { versi: 2, tanggal: new Date().toISOString(), size: SIZE, runs: RUNS, sizes: GUI_SIZES, fixture: FIXTURE, mode: opt('no-gui') ? 'model' : 'gui', lingkungan: environment, hasil: results, statistik: statistics };
    GLib.mkdir_with_parents(GLib.path_get_dirname(SAVE), 0o755);
    writeTextFile(SAVE, JSON.stringify(saved, null, 2) + '\n');
    if (!CHILD) print(`\n${DIM}Hasil disimpan: ${SAVE}${RESET}`);
}

overBudget ||= invalid;
if (!CHILD) print(overBudget ? `\n${RED}Ada pengukuran melebihi anggaran atau bench gagal.${RESET}` : `\n${GREEN}Selesai.${RESET}`);
System.exit(overBudget ? 1 : 0);
