// Memotret aplikasi sungguhan untuk landing page (docs/). Dibundel Vite menjadi dist/capture.js.
//
//   npm run docs
//
// Menulis PNG dan GIF ke docs/assets/. Jendela sungguhan dibuka, jadi perlu sesi desktop.

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import Gio from 'gi://Gio';
import System from 'system';

import { DEFAULTS } from '../src/settings.js';
import { MainWindow } from '../src/window.js';
import { isKanban, moveCard, parseBoard } from '../src/markdown/kanban.js';
import type { Provider } from '../src/agent/provider.js';
import { listChats, saveChat } from '../src/agent/chatstore.js';
import { iterAtLine } from '../src/gtkutil.js';
import { widgetPixbuf } from '../tests/widgets.js';

// Folder kerja contoh untuk tangkapan panel Asisten (provider palsu; tanpa jaringan dan tanpa API key):
// satu proyek peluncuran produk dengan rencana, catatan rapat, riset, dan papan tugas.
const WORK: Record<string, string> = {
    'rencana/peluncuran.md': '# Rencana Peluncuran Catat 1.0\n\n## Tujuan\n\nMerilis Catat 1.0 untuk pengguna Linux, lengkap dengan sinkronisasi folder.\n\n## Jadwal\n\n- Beta tertutup: 20 Oktober\n- Rilis publik: 15 November\n- Evaluasi: 30 November\n\n## Anggaran\n\nTotal Rp 45.000.000, termasuk desain ulang dan server uji.\n',
    'catatan/rapat-1-okt.md': '# Rapat mingguan, 1 Oktober\n\n## Keputusan\n\n- Rilis publik diundur ke **22 November** karena pengujian sinkronisasi belum selesai.\n- Anggaran tidak berubah.\n- Sari menyiapkan materi rilis.\n\n## Tindak lanjut\n\n- [ ] Budi memperbaiki bug sinkronisasi\n- [ ] Dewi menjadwalkan uji coba beta\n',
    'catatan/rapat-8-okt.md': '# Rapat mingguan, 8 Oktober\n\nBug sinkronisasi masih terbuka. Beta tertutup tetap 20 Oktober.\n',
    'riset/pesaing.md': '# Riset pesaing\n\nTiga aplikasi catatan serupa; semuanya berbayar dan tertutup.\n',
    'riset/pengguna.md': '# Wawancara pengguna\n\nLima pengguna menginginkan sinkronisasi tanpa akun.\n',
    'tugas.md': '---\nkanban: true\n---\n\n## Rencana\n\n- [ ] Siapkan materi rilis #pemasaran @{2026-11-10}\n- [ ] Tulis catatan rilis #docs\n\n## Dikerjakan\n\n- [ ] Perbaiki bug sinkronisasi #bug #penting @{2026-10-25}\n\n## Selesai\n\n- [x] Desain ulang halaman utama #desain\n',
    'ide.md': '# Ide\n\nFitur ekspor ke PDF.\n',
};
const ASK_READ = 'Adakah keputusan rapat yang belum masuk ke rencana peluncuran?';
const ANSWER = `Ada **satu keputusan yang belum masuk rencana**:

- Di *catatan/rapat-1-okt.md* › Keputusan: "Rilis publik diundur ke 22 November karena pengujian sinkronisasi belum selesai."
- Di *rencana/peluncuran.md* › Jadwal: "Rilis publik: 15 November."

Anggaran sudah konsisten (Rp 45.000.000) dan beta tertutup tetap 20 Oktober. Mau saya usulkan perubahan tanggalnya?`;
const ASK_ACT = 'Ya, perbarui tanggal rilisnya dan pindahkan kartu materi rilis ke Dikerjakan.';
const ANSWER_ACT = 'Selesai. Tanggal rilis di rencana sekarang **22 November**, dan kartu *Siapkan materi rilis* sudah ada di daftar *Dikerjakan*.';

const GIF_WIDTH = 900;   // PNG aslinya lebih besar
const GIF_STEP = 140;    // ms per frame
const GIF_COLORS = 128;
const OUT = GLib.getenv('NYERAT_OUT') ?? 'docs/assets';

const DOC = `# Catatan Rapat Produk

Rapat mingguan, **Jumat pagi**. Hal yang *perlu* ditindaklanjuti ada di bawah, tulisan ini ==disorot== dan ~~yang ini dicoret~~.

## Keputusan

- Rilis versi \`1.0\` ditunda satu minggu
- [x] Perbaiki bug ekspor HTML
- [ ] Tulis [dokumentasi](https://github.com/EkaPutCom/nyerat) fitur kanban

> Kutipan dari pengguna: "Akhirnya editor yang tidak mengganggu."

\`\`\`ts
function sapa(nama: string): string {
    return \`Halo, \${nama}!\`;
}
\`\`\`

## Jadwal

| Tugas | Penanggung jawab | Tenggat |
| :---- | :--------------: | ------: |
| Desain ulang | **Sari** | 10 Okt |
| Uji coba | *Budi* | 17 Okt |
`;

const TABLE_DOC = `# Anggaran Proyek

Tabel dirender sebagai grid. Klik sebuah sel untuk menyuntingnya.

| Pos | Penanggung jawab | Biaya (Rp) |
| :-- | :--------------: | ---------: |
| **Desain** | Sari | 12.000.000 |
| Pengembangan | *Budi* | 45.000.000 |
| Pengujian | Dewi | 8.500.000 |
| \`Server\` | Andi | 6.000.000 |
| [Lisensi](https://example.com) | Rina | 3.250.000 |

Total biaya masih di bawah **anggaran**.
`;

const DIAGRAM_DOC = `# Diagram dari Teks

Tulis diagram sebagai kode, lihat hasilnya langsung.

\`\`\`mermaid
graph LR
    A[Tulis] --> B{Bagus?}
    B -->|ya| C[Simpan]
    B -->|belum| A
    C --> D[Ekspor HTML]
\`\`\`

\`\`\`mermaid
sequenceDiagram
    Pengguna->>Nyerat: Ketik kode diagram
    Nyerat-->>Pengguna: Gambar muncul seketika
\`\`\`
`;

const DBML_DOC = `# Skema Basis Data

Blok \`dbml\` (bahasa dbdiagram.io) digambar sebagai diagram ER.

\`\`\`dbml
Table pengguna {
  id int [pk]
  nama varchar
}

Table catatan {
  id int [pk]
  judul varchar
  pengguna_id int
}

Ref: catatan.pengguna_id > pengguna.id
\`\`\`
`;

const BOARD = `---
kanban: true
---

## Rencana

- [ ] Riset pengguna #riset @{2026-10-10}
  Wawancara lima pengguna aktif.
- [ ] Rancang ulang halaman utama #desain
- [ ] Tulis dokumentasi **API** #docs @{2026-10-25}

## Dikerjakan

- [ ] Implementasi papan kanban #fitur #penting
- [ ] Perbaiki bug \`ekspor HTML\` #bug @{2026-10-03}

## Review

- [ ] Uji coba di Ubuntu 24.04 #qa

## Selesai

- [x] Pilih nama proyek: Nyerat
- [x] Siapkan repositori GitHub #infra
`;

const CODE_DOC = `# Blok Kode Berwarna

\`\`\`python
def fibonacci(n):
    a, b = 0, 1
    for _ in range(n):
        yield a
        a, b = b, a + b

print(list(fibonacci(10)))
\`\`\`

\`\`\`rust
fn main() {
    let nama = "Nyerat";
    println!("Halo, {nama}!");
}
\`\`\`

\`\`\`bash
npm install && npm start
\`\`\`
`;

function main(app: Gtk.Application): void {
    GLib.mkdir_with_parents(OUT, 0o755);
    const settings = { ...DEFAULTS, welcomed: true, dark: false, sidebarPage: 'outline' as const, width: 1280, height: 780 };
    const w = new MainWindow(app, settings, null);
    const ed = w.editor, buf = ed.buffer;
    const ctx = GLib.MainContext.default();
    const pump = () => { for (let i = 0; i < 200 && ctx.pending(); i++) ctx.iteration(false); };
    const settle = (n = 12) => { for (let i = 0; i < n; i++) { pump(); GLib.usleep(15000); } };
    const waitMermaid = () => {
        for (let i = 0; i < 3000 && ed.mermaid.blocks.some(b => b.busy || b.timer); i++) { pump(); GLib.usleep(10000); }
        settle();
    };
    const grab = () => {
        settle();
        return widgetPixbuf(w.win)!;
    };
    const shot = (name: string) => grab().savev(`${OUT}/${name}.png`, 'png', [], []);

    // GIF: frame() mengumpulkan frame; finishGifs() membuat satu palet per GIF, menandai piksel yang tidak
    // berubah dari frame sebelumnya sebagai transparan (jauh lebih kecil), lalu menulis berkasnya.
    const pending = new Map<string, { px: GdkPixbuf.Pixbuf; delay: number }[]>();
    // `hold` = berapa langkah (GIF_STEP ms) frame ini ditahan sebelum berganti.
    // Yang disimpan hanya pixbuf (memori native): array besar di heap JS memicu GC di tengah pemotretan.
    const frame = (gif: string, hold = 0) => {
        const src = grab();
        const px = src.scale_simple(GIF_WIDTH, Math.round(src.get_height() * GIF_WIDTH / src.get_width()), GdkPixbuf.InterpType.HYPER)!;
        if (!pending.has(gif)) pending.set(gif, []);
        pending.get(gif)!.push({ px, delay: GIF_STEP * (1 + hold) });
    };
    // Pixbuf bisa RGB atau RGBA dan barisnya bisa berisi padding; gifenc butuh RGBA rapat.
    const toRgba = (px: GdkPixbuf.Pixbuf) => {
        const width = px.get_width(), height = px.get_height();
        const raw = px.get_pixels(), stride = px.get_rowstride(), n = px.get_n_channels();
        const rgba = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = y * stride + x * n, o = (y * width + x) * 4;
                rgba[o] = raw[i]; rgba[o + 1] = raw[i + 1]; rgba[o + 2] = raw[i + 2]; rgba[o + 3] = 255;
            }
        }
        return rgba;
    };
    const finishGifs = () => {
        const width = GIF_WIDTH;
        for (const [name, frames] of pending) {
            const height = frames[0].px.get_height();
            const list = frames.map(f => ({ rgba: toRgba(f.px), delay: f.delay }));
            // Palet dari semua frame sekaligus (contoh setiap 4 piksel), sisakan satu indeks untuk "transparan".
            const sample = new Uint8Array(list.reduce((sum, f) => sum + Math.ceil(f.rgba.length / 16) * 4, 0));
            let at = 0;
            for (const f of list) for (let i = 0; i < f.rgba.length; i += 16) { sample.set(f.rgba.subarray(i, i + 4), at); at += 4; }
            const palette = quantize(sample, GIF_COLORS - 1);
            const clear = palette.length;
            palette.push([0, 0, 0]);
            const enc = GIFEncoder();
            let prev: Uint8Array | null = null;
            for (const f of list) {
                const index = applyPalette(f.rgba, palette);
                if (!prev) {
                    enc.writeFrame(index, width, height, { palette, delay: f.delay });
                } else {
                    const diff = index.slice();
                    for (let i = 0; i < diff.length; i++) if (diff[i] === prev[i]) diff[i] = clear;
                    enc.writeFrame(diff, width, height, { delay: f.delay, transparent: true, transparentIndex: clear, dispose: 1 });
                }
                prev = index;
            }
            enc.finish();
            const bytes = enc.bytes();
            GLib.file_set_contents(`${OUT}/${name}.gif`, bytes);
            print(`${name}.gif: ${list.length} frame, ${Math.round(bytes.length / 1024)} KB`);
        }
    };
    const load = (text: string, dark = false, line = 0, sidebar = true) => {
        w.setOption('dark', dark);
        w.setOption('sidebar', sidebar);
        w.file = null;
        ed.setText(text);
        w.setBoardMode(isKanban(text));
        const it = iterAtLine(buf, line);
        buf.place_cursor(it);
        ed.view.scroll_to_iter(buf.get_start_iter(), 0, false, 0, 0);
        settle(20);
    };
    const cursorTo = (line: number, col = 0) => {
        const it = iterAtLine(buf, line);
        it.forward_chars(col);
        buf.place_cursor(it);
        settle(4);
    };

    settle(30);

    // ───────── Tangkapan layar ─────────
    load(DOC, false, 0);
    cursorTo(2, 5);
    shot('editor-terang');

    load(DOC, true, 0);
    cursorTo(2, 5);
    shot('editor-gelap');
    load(DOC, false, 0);

    load(TABLE_DOC);
    cursorTo(0);
    shot('tabel');

    load(CODE_DOC);
    cursorTo(0);
    shot('kode');

    load(DIAGRAM_DOC, false, 0, false);
    cursorTo(0);
    waitMermaid();
    shot('diagram');
    load(DBML_DOC, false, 0, false);
    cursorTo(0);
    waitMermaid();
    shot('dbml');

    load(BOARD, false, 0, false);
    shot('kanban');
    load(BOARD, true, 0, false);
    shot('kanban-gelap');
    load(BOARD, false, 0, false);

    // ───────── GIF 1: sintaks muncul dan hilang ─────────
    load(DOC, false, 0);
    for (const [line, col] of [[0, 8], [2, 20], [2, 55], [5, 12], [6, 8], [7, 20], [0, 0]] as const) {
        cursorTo(line, col);
        frame('sintaks', 2);
    }

    // ───────── GIF 2: mengetik Markdown ─────────
    load('', false, 0);
    const typed = '# Daftar Belanja\n\nHari ini beli **sayur**, *buah*, dan `telur`.\n\n- [ ] Bayam\n- [x] Apel\n- [ ] Tahu\n';
    let acc = '';
    frame('mengetik', 2);
    for (const ch of typed) {
        buf.insert_at_cursor(ch, -1);
        acc += ch;
        if (ch === ' ' || ch === '\n' || ch === '*' || ch === '`' || ch === '#' || /[a-z]/i.test(ch) && acc.length % 3 === 0) frame('mengetik');
    }
    frame('mengetik', 6);

    // ───────── GIF 3: diagram hidup ─────────
    load('# Alur Kerja\n\n```mermaid\ngraph LR\n    A[Tulis] --> B[Simpan]\n```\n', false, 0, false);
    waitMermaid();
    frame('diagram', 3);
    cursorTo(4, 20);
    waitMermaid();
    frame('diagram', 3);
    for (const add of ['\n    B --> C[Ekspor]', '\n    C --> D[Bagikan]', '\n    D --> A']) {
        const it = iterAtLine(buf, 4);
        it.forward_to_line_end();
        buf.insert(it, add, -1);
        waitMermaid();
        frame('diagram', 3);
    }
    cursorTo(0);
    waitMermaid();
    frame('diagram', 8);

    // ───────── GIF 4: papan kanban ─────────
    load(BOARD, false, 0, false);
    frame('kanban', 5);
    let board = parseBoard(w.editor.getText());
    // Pindahkan kartu lewat model papan yang sama dengan yang dipakai seret-dan-lepas.
    const moves: [[number, number], [number, number]][] = [
        [[0, 0], [1, 0]],
        [[1, 1], [2, 0]],
        [[1, 0], [2, 0]],
    ];
    for (const [from, to] of moves) {
        board = moveCard(board, { column: from[0], index: from[1] }, { column: to[0], index: to[1] });
        w.board.commit(board);
        settle(20);
        frame('kanban', 5);
    }
    frame('kanban', 5);

    // ───────── GIF 5: mode terang ↔ gelap ─────────
    load(DOC, false, 0);
    cursorTo(0);
    frame('tema', 8);
    load(DOC, true, 0);
    cursorTo(0);
    frame('tema', 8);

    // ───────── Panel Asisten ─────────
    // Nama folder tampil di tab Berkas dan judul jendela, jadi beri nama yang wajar (bukan nama sementara).
    const proj = GLib.build_filenamev([GLib.dir_make_tmp('nyerat-kerja-XXXXXX'), 'peluncuran-catat']);
    GLib.mkdir_with_parents(proj, 0o755);
    const put = (rel: string, text: string) => {
        const path = GLib.build_filenamev([proj, ...rel.split('/')]);
        GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
        GLib.file_set_contents(path, text);
        return path;
    };
    for (const [rel, text] of Object.entries(WORK)) put(rel, text);
    const rencana = GLib.build_filenamev([proj, 'rencana', 'peluncuran.md']);
    w.openFolder(proj, false);
    w.load(rencana);

    // Penyedia model palsu yang memainkan skrip: tiap putaran berisi panggilan alat atau jawaban akhir.
    type Call = { id: string; name: string; arguments: string };
    let streamFrames = false;
    const scripted = (rounds: (Call[] | string)[], gif = 'asisten'): Provider => {
        let at = 0;
        return {
            async chat(req) {
                const step = rounds[Math.min(at++, rounds.length - 1)];
                if (typeof step === 'string') {
                    const parts = step.match(/\S+\s*/g) ?? [];
                    parts.forEach((part, i) => {
                        req.onText(part);
                        if (streamFrames && i % 6 === 5) frame(gif, 0);
                    });
                    return { usage: { prompt: 3920, cached: 1536, completion: 148 }, cancelled: false, toolCalls: [], reasoning: '' };
                }
                return { usage: { prompt: 1840, cached: 1536, completion: 40 }, cancelled: false, reasoning: '', toolCalls: step };
            },
        };
    };
    w.chat.keyStore = { get: async () => ({ key: 'contoh', source: 'env' }), set: async () => 'env', clear: async () => {} };
    for (const dark of [false, true]) {
        w.chat.makeProvider = () => scripted([
            [{ id: 'a', name: 'cari_teks', arguments: '{"teks":"Rilis publik"}' }, { id: 'b', name: 'baca_berkas', arguments: '{"nama":"rapat-1-okt"}' }],
            ANSWER,
        ]);
        w.setDark(dark);
        w.chat.reset();
        w.setOption('chat', true);
        w.sidebar.setPage('files');
        let done = false;
        streamFrames = !dark;
        if (streamFrames) frame('asisten', 4);
        void w.chat.ask(ASK_READ).then(() => { done = true; });
        while (!done) { pump(); GLib.usleep(5000); }
        settle(20);
        if (streamFrames) frame('asisten', 10);
        shot(dark ? 'asisten-gelap' : 'asisten-terang');
    }
    w.setDark(false);

    // ───────── Agent mengusulkan perubahan (jendela tinjau, lalu diterapkan) ─────────
    const idle = (ms: number) => { for (let i = 0; i < ms / 10; i++) { pump(); GLib.usleep(10000); } };
    w.chat.makeProvider = () => scripted([
        [{ id: 'u1', name: 'ubah_berkas', arguments: JSON.stringify({ nama: 'rencana/peluncuran.md', teks_lama: '- Rilis publik: 15 November', teks_baru: '- Rilis publik: 22 November', alasan: 'Rapat 1 Oktober mengundur rilis publik ke 22 November.' }) }],
        [{ id: 'u2', name: 'ubah_kanban', arguments: JSON.stringify({ nama: 'tugas.md', aksi: 'pindah', kartu: 'Siapkan materi rilis', daftar: 'Dikerjakan', alasan: 'Sari mulai menyiapkan materi rilis.' }) }],
        ANSWER_ACT,
    ], 'agent');
    const nextViewer = () => {
        for (let i = 0; i < 800 && !w.chat.viewer; i++) { pump(); GLib.usleep(10000); }
        const viewer = w.chat.viewer;
        if (!viewer) throw new Error('jendela tinjau tidak muncul');
        idle(400);
        return viewer;
    };
    streamFrames = true;
    w.chat.reset();
    let acted = false;
    void w.chat.ask(ASK_ACT).then(() => { acted = true; });
    const first = nextViewer();
    frame('agent', 8);
    widgetPixbuf(first.window)!.savev(`${OUT}/usulan-diff.png`, 'png', [], []);
    first.applyButton.emit('clicked');
    idle(400);
    frame('agent', 6);
    const second = nextViewer();
    frame('agent', 8);
    widgetPixbuf(second.window)!.savev(`${OUT}/usulan-kanban.png`, 'png', [], []);
    second.applyButton.emit('clicked');
    while (!acted) { pump(); GLib.usleep(5000); }
    idle(600);
    frame('agent', 14);
    const agentShot = grab();
    agentShot.savev(`${OUT}/agent-selesai.png`, 'png', [], []);
    // Gambar share sosial (1200x631): seluruh jendela diperkecil, lalu bagian bawahnya yang kosong dipotong.
    agentShot.scale_simple(1200, Math.round(agentShot.get_height() * 1200 / agentShot.get_width()), GdkPixbuf.InterpType.HYPER)!
        .new_subpixbuf(0, 0, 1200, 631).savev(`${OUT}/og-image.png`, 'png', [], []);
    streamFrames = false;
    w.setOption('chat', false);
    w.editor.buffer.set_modified(false);

    // ───────── Berkas: pohon folder ─────────
    // Kembalikan isi contoh (usulan tadi sudah mengubah rencana dan papan), supaya tangkapan berikutnya konsisten dengan jawaban Asisten.
    for (const [rel, text] of Object.entries(WORK)) put(rel, text);
    w.openFolder(proj, false);
    w.load(rencana);
    w.setOption('sidebar', true);
    w.sidebar.setPage('files');
    w.fileTree.reveal(GLib.build_filenamev([proj, 'riset', 'pesaing.md']));
    w.fileTree.reveal(rencana);
    settle(20);
    shot('berkas');

    // ───────── Riwayat git ─────────
    const repo = GLib.dir_make_tmp('nyerat-riwayat-XXXXXX');
    const env = [...GLib.get_environ(), 'GIT_CONFIG_GLOBAL=/dev/null', 'GIT_CONFIG_SYSTEM=/dev/null'];
    const git = (...args: string[]) => {
        const [, , err, status] = GLib.spawn_sync(repo, ['git', '-c', 'user.name=Eka Putra', '-c', 'user.email=eka@example.com', ...args], env, GLib.SpawnFlags.SEARCH_PATH, null);
        if (status !== 0) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(err ?? undefined)}`);
    };
    const note = GLib.build_filenamev([repo, 'catatan.md']);
    const versions = [
        ['Buat kerangka catatan', '# Catatan Proyek\n\n## Tujuan\n\nMenulis tanpa gangguan.\n'],
        ['Tambah bagian jadwal', '# Catatan Proyek\n\n## Tujuan\n\nMenulis tanpa gangguan.\n\n## Jadwal\n\n- Draf pertama: Oktober\n'],
        ['Perbaiki tujuan dan jadwal', '# Catatan Proyek\n\n## Tujuan\n\nMenulis tanpa gangguan, dengan tampilan yang langsung terformat.\n\n## Jadwal\n\n- Draf pertama: 10 Oktober\n- Revisi: 24 Oktober\n'],
    ];
    git('init', '-q');
    for (const [msg, text] of versions) {
        GLib.file_set_contents(note, text);
        git('add', 'catatan.md');
        git('commit', '-q', '-m', msg);
    }
    GLib.file_set_contents(note, versions[2][1] + '- Rilis: 1 November\n');
    GLib.file_set_contents(GLib.build_filenamev([repo, 'ide.md']), '# Ide\n\nBelum masuk git.\n');
    w.openFolder(repo, false);
    w.load(note);
    w.setOption('sidebar', true);
    w.sidebar.setPage('history');
    idle(3000);
    shot('riwayat');
    w.setDark(true);
    idle(300);
    shot('riwayat-gelap');
    w.setDark(false);
    idle(300);

    // Jendela baca commit: ambil dari daftar riwayat seperti klik pengguna.
    const toplevels = () => Gtk.Window.list_toplevels();
    // Jendela anak (penampil) saja; jendela WebKit tak terlihat milik Mermaid ikut menjadi toplevel.
    const child = () => toplevels().find(t => t.get_visible() && (t as unknown as Gtk.Window).get_transient_for() === (w.win as unknown as Gtk.Window));
    w.history.list.emit('row-activated', w.history.list.get_row_at_index(0)!);
    idle(1500);
    const viewer = child();
    if (viewer) {
        idle(500);
        widgetPixbuf(viewer)!.savev(`${OUT}/riwayat-diff.png`, 'png', [], []);
        (viewer as Gtk.Window).destroy();
    }

    // ───────── Zoom gambar ─────────
    const picture = GLib.build_filenamev([GLib.get_current_dir(), 'tests/samples/gambar/contoh.png']);
    load(`# Gambar\n\nKlik ganda gambar untuk memperbesarnya.\n\n![Contoh gambar](${picture})\n`, false, 4, false);
    idle(1200);
    cursorTo(4);
    ed.zoomImage();
    idle(800);
    const zoomWin = child();
    if (zoomWin) {
        widgetPixbuf(zoomWin)!.savev(`${OUT}/zoom-gambar.png`, 'png', [], []);
        (zoomWin as Gtk.Window).destroy();
    }

    // ───────── Tab dokumen ─────────
    w.setOption('sidebar', true);
    w.sidebar.setPage('files');
    w.openFolder(proj, false);
    w.file = null;
    ed.setText('');
    w.setOption('autosave', false);   // supaya tanda • (belum disimpan) tampil di tab
    for (const rel of ['catatan/rapat-1-okt.md', 'rencana/peluncuran.md', 'riset/pesaing.md', 'riset/pengguna.md']) w.openFile(GLib.build_filenamev([proj, ...rel.split('/')]));
    w.switchTab(-2);   // rencana aktif
    w.editor.buffer.place_cursor(w.editor.buffer.get_end_iter());
    w.editor.buffer.insert_at_cursor('\n## Risiko\n\nBug sinkronisasi bisa menggeser rilis publik.\n', -1);
    w.editor.view.scroll_to_iter(w.editor.buffer.get_start_iter(), 0, false, 0, 0);
    idle(600);
    shot('tab');
    // Bersihkan: simpan perubahan lalu tutup tab, kembali ke satu dokumen.
    w.editor.buffer.set_modified(false);
    w.setOption('autosave', true);
    while (w.documentCount > 1) w.closeTab();
    w.file = null;
    ed.setText('');

    // ───────── Riwayat percakapan ─────────
    const earlier: [string, string, string, string][] = [
        ['2026-10-02T21:05:00', 'Ringkas catatan rapat minggu ini', 'Ringkas catatan rapat minggu ini', 'Rilis publik diundur ke 22 November, Sari menyiapkan materi rilis, dan Budi memperbaiki bug sinkronisasi.'],
        ['2026-10-03T08:40:00', 'Buat daftar risiko peluncuran', 'Buat daftar risiko peluncuran', 'Risiko utama: bug sinkronisasi, beta tertutup yang mundur, dan anggaran server uji yang terbatas.'],
    ];
    // Buang percakapan hasil adegan Asisten di atas supaya daftarnya hanya berisi contoh ini.
    for (const old of listChats(proj)) GLib.unlink(old.path);
    for (const [created, title, q, a] of earlier) saveChat(proj, { title, model: 'deepseek-flash', created, turns: [{ role: 'user', content: q }, { role: 'assistant', content: a }] }, null);
    w.openFolder(proj, false);
    w.load(rencana);
    w.setOption('sidebar', true);
    w.sidebar.setPage('files');
    w.setOption('chat', true);
    w.chat.reset();
    w.chat.makeProvider = () => scripted([ANSWER]);
    void w.chat.ask(ASK_READ);
    idle(1500);
    const popover = w.chat.historyButton.get_popover()!;
    for (const dark of [false, true]) {
        w.setDark(dark);
        popover.popup();
        idle(500);
        const main = grab();
        // Popover GTK 4 punya permukaan sendiri dan posisinya tidak bisa dibaca; letakkan seperti
        // GTK menaruhnya: di bawah tombolnya, di tengah, dan tidak keluar dari jendela.
        const pop = widgetPixbuf(popover);
        const button = w.chat.historyButton;
        const [, tx, ty] = button.translate_coordinates(w.win, 0, 0);
        // Tangkapan jendela mencakup bingkai CSD; koordinat widget dimulai di dalamnya.
        const [sx, sy] = w.win.get_surface_transform();
        const bx = tx + sx, by = ty + sy;
        if (pop) {
            const x = Math.max(0, Math.min(main.get_width() - pop.get_width(), Math.round(bx + button.get_width() / 2 - pop.get_width() / 2)));
            const y = Math.round(by + button.get_height());
            const h = Math.min(pop.get_height(), main.get_height() - y);
            pop.composite(main, x, y, pop.get_width(), h, x, y, 1, 1, GdkPixbuf.InterpType.NEAREST, 255);
        }
        main.savev(`${OUT}/riwayat-percakapan${dark ? '-gelap' : ''}.png`, 'png', [], []);
        popover.popdown();
        idle(200);
    }
    w.setDark(false);
    w.setOption('chat', false);

    finishGifs();
    print(`Selesai: ${OUT}`);
    buf.set_modified(false);
    w.win.destroy();
}

const app = new Gtk.Application({ application_id: 'id.eka.Nyerat.Capture', flags: Gio.ApplicationFlags.NON_UNIQUE });
app.connect('activate', () => {
    app.hold();
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        try { main(app); } catch (e) { printerr(e instanceof Error ? `${e.message}\n${e.stack}` : String(e)); }
        app.release();
        app.quit();
        return GLib.SOURCE_REMOVE;
    });
});
app.run([System.programInvocationName]);
