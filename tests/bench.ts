// Pengujian performa Nyerat. Dibundel Vite menjadi dist/bench.js.
//
//   npm run bench                        build, lalu ukur di Xvfb
//   gjs -m dist/bench.js --no-gui        hanya modul Markdown (tanpa jendela)
//   gjs -m dist/bench.js --size=2000     ukuran dokumen (jumlah blok sampel), bawaan 100
//   gjs -m dist/bench.js --runs=10       jumlah pengulangan tiap ukuran, bawaan 3
//   gjs -m dist/bench.js --budget=ms     gagal (kode keluar 1) bila median penyorotan melebihi ms
//   gjs -m dist/bench.js --sizes=100,400 ukuran dokumen untuk bagian GUI (bawaan: size/4, size/2, size)
//   gjs -m dist/bench.js --save=f.json   simpan hasil ke f.json (untuk dibandingkan nanti)
//   gjs -m dist/bench.js --compare=f.json  tampilkan selisih terhadap hasil tersimpan
//
//   npm run bench:save                   simpan ke bench/<tanggal-waktu>.json
//   npm run bench:compare                bandingkan dengan bench/baseline.json
//
// Hasil berupa median dan terbaik dari beberapa pengulangan, dalam milidetik.

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

const SIZE = Number(optVal('size') ?? 100);
const RUNS = Number(optVal('runs') ?? 3);
const GUI_SIZES = (optVal('sizes') ?? [SIZE / 4, SIZE / 2, SIZE].map(Math.round).join(',')).split(',').map(Number);
const BUDGET = optVal('budget') ? Number(optVal('budget')) : null;

let overBudget = false;
let invalid = false;

// Kunci hasil = "<bagian> / <nama>", mis. "Editor GUI 40 blok / ketik 20 karakter".
interface Saved { tanggal: string; size: number; runs: number; hasil: Record<string, number> }
const results: Record<string, number> = {};
let group = '';
const COMPARE = optVal('compare');
const baseline: Saved | null = COMPARE ? JSON.parse(readTextFile(COMPARE)) : null;

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

const doc = (n: number): string => BLOCK.repeat(n);

const now = (): number => GLib.get_monotonic_time() / 1000;

function measure(fn: () => void, runs = RUNS): number[] {
    fn();  // pemanasan (JIT dan cache)
    const t: number[] = [];
    for (let i = 0; i < runs; i++) { const s = now(); fn(); t.push(now() - s); }
    return t.sort((a, b) => a - b);
}

function report(name: string, t: number[], budget = false): void {
    const med = t[Math.floor(t.length / 2)];
    const over = budget && BUDGET !== null && med > BUDGET;
    if (over) overBudget = true;
    const key = `${group} / ${name}`;
    results[key] = med;
    const before = baseline?.hasil[key];
    let delta = '';
    if (before !== undefined) {
        const pct = (med - before) / before * 100;
        // Kode yang sama bisa selisih sampai ±25% antarjalan, jadi di bawah itu dianggap derau.
        const color = Math.abs(pct) < 25 ? DIM : pct < 0 ? GREEN : RED;
        delta = `   ${color}${pct >= 0 ? '+' : ''}${pct.toFixed(0)}% (dulu ${before.toFixed(2)} ms)${RESET}`;
    }
    print(`  ${name.padEnd(34)} median ${med.toFixed(2).padStart(9)} ms   terbaik ${t[0].toFixed(2).padStart(9)} ms${delta}${over ? `  ${RED}> ${BUDGET} ms${RESET}` : ''}`);
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
function runGuiBench(app: Gtk.Application, n: number): void {
    const w = new MainWindow(app, { ...DEFAULTS, welcomed: true, dark: false }, null);
    windows.push(w);
    const ed = w.editor;
    const buf = ed.buffer;
    const ctx = GLib.MainContext.default();
    const pump = () => { for (let i = 0; i < 500 && ctx.pending(); i++) ctx.iteration(false); };
    pump();

    const text = doc(n);
    group = `Editor GUI ${n} blok`;
    print(`\nEditor GUI (${n} blok, ${(text.length / 1024).toFixed(0)} KB)`);
    report('setText + sorot + layout', measure(() => { ed.setText(text); pump(); }), true);
    const sorot = measure(() => ed.highlight());
    report('highlight() ulang', sorot, true);
    // Mengetik di tengah dokumen: tiap karakter memicu penyorotan ulang.
    buf.place_cursor(buf.get_iter_at_line(Math.floor(buf.get_line_count() / 2)));
    const ketik = measure(() => {
        for (let i = 0; i < 20; i++) { buf.insert_at_cursor('x', -1); pump(); }
    });
    report('ketik 20 karakter', ketik, true);
    report('pindah kursor 20 baris', measure(() => {
        for (let i = 0; i < 20; i++) {
            buf.place_cursor(buf.get_iter_at_line(Math.min(i * 7, buf.get_line_count() - 1)));
            pump();
        }
    }));
    // Tiap ketukan memicu minimal satu penyorotan; lebih cepat dari itu berarti penyorotan mati.
    if (ketik[Math.floor(ketik.length / 2)] < sorot[Math.floor(sorot.length / 2)]) {
        invalid = true;
        print(`  ${RED}Tidak valid: mengetik lebih cepat dari satu penyorotan (callback GJS terblokir GC).${RESET}`);
    }

    buf.set_modified(false);
}

// Mode anak (--child): hanya mengukur GUI untuk --sizes, tanpa header dan footer.
const CHILD = opt('child');

function runGuiInProcess(): void {
    const app = new Gtk.Application({ application_id: 'id.eka.Nyerat.Bench', flags: Gio.ApplicationFlags.NON_UNIQUE });
    app.connect('activate', () => {
        app.hold();
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            try {
                for (const n of GUI_SIZES) runGuiBench(app, n);
            } catch (e) {
                overBudget = true;
                print(`${RED}Bench GUI berhenti: ${errorMessage(e)}${RESET}\n${e instanceof Error ? e.stack : ''}`);
            }
            app.release();
            app.quit();
            return GLib.SOURCE_REMOVE;
        });
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
        const argv = ['gjs', '-m', script, '--child', `--sizes=${n}`, `--size=${SIZE}`, `--runs=${RUNS}`, `--save=${out}`];
        if (BUDGET !== null) argv.push(`--budget=${BUDGET}`);
        if (COMPARE) argv.push(`--compare=${COMPARE}`);
        const [, stdout, stderr, status] = GLib.spawn_sync(null, argv, null, GLib.SpawnFlags.SEARCH_PATH, null);
        print(new TextDecoder().decode(stdout ?? undefined).trimEnd());
        if (GLib.file_test(out, GLib.FileTest.EXISTS)) {
            Object.assign(results, (JSON.parse(readTextFile(out)) as Saved).hasil);
            if (status !== 0) overBudget = true;
        } else {
            invalid = true;
            print(`${RED}Proses anak untuk ${n} blok gagal.${RESET}\n${new TextDecoder().decode(stderr ?? undefined).slice(0, 2000)}`);
        }
    }
}

if (!CHILD) {
    print(`${DIM}Ukuran ${SIZE} blok, ${RUNS} pengulangan${BUDGET !== null ? `, anggaran ${BUDGET} ms` : ''}${RESET}`);
    runModelBench();
}

if (!opt('no-gui')) {
    if (!Gdk.Display.get_default() && !GLib.getenv('DISPLAY') && !GLib.getenv('WAYLAND_DISPLAY')) {
        print(`\n${DIM}Bench GUI dilewati: tidak ada display.${RESET}`);
    } else if (CHILD) {
        runGuiInProcess();
    } else {
        runGuiInChildren();
    }
}

const SAVE = optVal('save');
if (SAVE && invalid) print(`${RED}Hasil tidak disimpan karena ada pengukuran tidak valid.${RESET}`);
else if (SAVE) {
    const saved: Saved = { tanggal: new Date().toISOString(), size: SIZE, runs: RUNS, hasil: results };
    GLib.mkdir_with_parents(GLib.path_get_dirname(SAVE), 0o755);
    writeTextFile(SAVE, JSON.stringify(saved, null, 2) + '\n');
    if (!CHILD) print(`\n${DIM}Hasil disimpan: ${SAVE}${RESET}`);
}
if (!CHILD && baseline && baseline.size !== SIZE) print(`${RED}Peringatan: --size berbeda dari hasil tersimpan (${baseline.size}), banyak kunci tidak akan cocok.${RESET}`);

overBudget ||= invalid;
if (!CHILD) print(overBudget ? `\n${RED}Ada pengukuran melebihi anggaran atau bench gagal.${RESET}` : `\n${GREEN}Selesai.${RESET}`);
System.exit(overBudget ? 1 : 0);
