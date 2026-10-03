// Pengujian performa Nyerat. Dibundel Vite menjadi dist/bench.js.
//
//   npm run bench                        build, lalu ukur di Xvfb
//   gjs -m dist/bench.js --no-gui        hanya modul Markdown (tanpa jendela)
//   gjs -m dist/bench.js --size=2000     ukuran dokumen (jumlah blok sampel), bawaan 100
//   gjs -m dist/bench.js --runs=10       jumlah pengulangan tiap ukuran, bawaan 3
//   gjs -m dist/bench.js --budget=ms     gagal (kode keluar 1) bila median penyorotan melebihi ms
//
// Hasil berupa median dan terbaik dari beberapa pengulangan, dalam milidetik.

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=3.0';
import Gdk from 'gi://Gdk?version=3.0';
import Gio from 'gi://Gio';
import System from 'system';

import { DIM, GREEN, RED, RESET, errorMessage, opt, optVal } from './framework.js';
import { DEFAULTS } from '../src/settings.js';
import { MainWindow } from '../src/window.js';
import { markdownToHtml } from '../src/markdown/html.js';
import { parseInline } from '../src/markdown/inline.js';
import { findTables, parseTable, renderTable } from '../src/markdown/table.js';
import { parseBoard, serializeBoard } from '../src/markdown/kanban.js';

const SIZE = Number(optVal('size') ?? 100);
const RUNS = Number(optVal('runs') ?? 3);
const BUDGET = optVal('budget') ? Number(optVal('budget')) : null;

let overBudget = false;

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
    print(`  ${name.padEnd(34)} median ${med.toFixed(2).padStart(9)} ms   terbaik ${t[0].toFixed(2).padStart(9)} ms${over ? `  ${RED}> ${BUDGET} ms${RESET}` : ''}`);
}

function runModelBench(): void {
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

function runGuiBench(app: Gtk.Application): void {
    const w = new MainWindow(app, { ...DEFAULTS, welcomed: true, dark: false }, null);
    const ed = w.editor;
    const buf = ed.buffer;
    const ctx = GLib.MainContext.default();
    const pump = () => { for (let i = 0; i < 500 && ctx.pending(); i++) ctx.iteration(false); };
    pump();

    for (const n of [SIZE / 4, SIZE, SIZE * 2].map(Math.round)) {
        const text = doc(n);
        print(`\nEditor GUI (${n} blok, ${(text.length / 1024).toFixed(0)} KB)`);
        report('setText + sorot + layout', measure(() => { ed.setText(text); pump(); }), true);
        report('highlight() ulang', measure(() => ed.highlight()), true);
        // Mengetik di tengah dokumen: tiap karakter memicu penyorotan ulang.
        const mid = buf.get_iter_at_line(Math.floor(buf.get_line_count() / 2));
        buf.place_cursor(mid);
        report('ketik 20 karakter', measure(() => {
            for (let i = 0; i < 20; i++) { buf.insert_at_cursor('x', -1); pump(); }
        }), true);
        report('pindah kursor 20 baris', measure(() => {
            for (let i = 0; i < 20; i++) {
                const it = buf.get_iter_at_line(Math.min(i * 7, buf.get_line_count() - 1));
                buf.place_cursor(it);
                pump();
            }
        }));
    }

    // Jendela tidak di-destroy: proses langsung keluar, dan destroy memicu peringatan GC dari GJS.
    buf.set_modified(false);
}

print(`${DIM}Ukuran ${SIZE} blok, ${RUNS} pengulangan${BUDGET !== null ? `, anggaran ${BUDGET} ms` : ''}${RESET}`);
runModelBench();

if (!opt('no-gui')) {
    if (!Gdk.Display.get_default() && !GLib.getenv('DISPLAY') && !GLib.getenv('WAYLAND_DISPLAY')) {
        print(`\n${DIM}Bench GUI dilewati: tidak ada display.${RESET}`);
    } else {
        const app = new Gtk.Application({ application_id: 'id.eka.Nyerat.Bench', flags: Gio.ApplicationFlags.NON_UNIQUE });
        app.connect('activate', () => {
            app.hold();
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                try {
                    runGuiBench(app);
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
}

print(overBudget ? `\n${RED}Ada pengukuran melebihi anggaran atau bench gagal.${RESET}` : `\n${GREEN}Selesai.${RESET}`);
System.exit(overBudget ? 1 : 0);
