// Tes otomatis Nyerat. Dibundel Vite menjadi dist/run-tests.js.
//
//   npm test                                         build, lalu semua tes
//   gjs -m dist/run-tests.js --no-gui                hanya tes konversi Markdown → HTML
//   gjs -m dist/run-tests.js --mouse                 tambah klik mouse sungguhan (pointer akan bergerak)
//   gjs -m dist/run-tests.js --screenshot=a.png      simpan tangkapan layar jendela editor
//
// Tes GUI membuka jendela sungguhan, jadi perlu sesi desktop (X11/Wayland).

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=3.0';
import Gdk from 'gi://Gdk?version=3.0';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import System from 'system';

import { parseInline } from '../src/markdown/inline.js';
import { markdownToHtml } from '../src/markdown/html.js';
import { makeCpMap } from '../src/editor/offsets.js';
import { DEFAULTS, loadSettings, saveSettings } from '../src/settings.js';
import { WELCOME } from '../src/welcome.js';
import { readTextFile } from '../src/files.js';
import { MainWindow, type Option } from '../src/window.js';
import { listFolder } from '../src/ui/filetree.js';
import { resolveLanguage } from '../src/editor/codehighlight.js';
import type { TagName } from '../src/editor/tags.js';

const argv = System.programArgs;
const opt = (name: string) => argv.includes(`--${name}`);
const optVal = (name: string) => argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

// Folder proyek. File ini berada di tests/ (sumber) atau dist/ (hasil build),
// jadi folder proyek adalah induk dari foldernya.
const ROOT = GLib.path_get_dirname(GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]));

// Pengaturan dan file tes ditaruh di folder sementara, bukan ~/.config. Aman di-set
// setelah import karena settings.ts baru membaca XDG_CONFIG_HOME saat dipanggil.
const tmp = GLib.dir_make_tmp('nyerat-test-XXXXXX');
GLib.setenv('XDG_CONFIG_HOME', tmp, true);

const errorMessage = (e: unknown): string => e instanceof Error ? e.message : String(e);

// ───────────────────────── Mini framework ─────────────────────────

let passed = 0, failed = 0;
const RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

function section(name: string): void { print(`\n${name}`); }

function test(name: string, fn: () => void): void {
    try {
        fn();
        passed++;
        print(`  ${GREEN}✓${RESET} ${name}`);
    } catch (e) {
        failed++;
        print(`  ${RED}✗ ${name}${RESET}\n    ${errorMessage(e).split('\n').join('\n    ')}`);
    }
}

function eq(actual: unknown, expected: unknown, what = 'nilai'): void {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${what} salah\n    dapat:    ${a}\n    harapan:  ${b}`);
}

function ok(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

function contains(haystack: string, needle: string): void {
    if (!haystack.includes(needle)) throw new Error(`tidak mengandung ${JSON.stringify(needle)}\n    dalam: ${JSON.stringify(haystack.slice(0, 300))}`);
}

// ───────────────────────── Tes konversi (tanpa GUI) ─────────────────────────

const body = (md: string) => markdownToHtml(md, 't').split('<body>\n')[1].split('\n</body>')[0];

function runUnitTests() {
    section('parseInline');
    test('tebal menghasilkan tag dan marker', () => {
        const r = parseInline('a **b** c');
        ok(r.tags.some(([n, s, e]) => n === 'bold' && s === 4 && e === 5), JSON.stringify(r.tags));
        eq(r.marks, [[2, 4], [5, 7]], 'marker');
    });
    test('backtick yang di-escape tidak jadi kode', () => {
        const r = parseInline('\\`a\\`');
        ok(!r.tags.some(([n]) => n === 'code'), JSON.stringify(r.tags));
        eq(r.marks, [[0, 1], [3, 4]], 'marker backslash');
    });
    test('isi kode inline tidak diformat', () => {
        const r = parseInline('`**x**`');
        ok(!r.tags.some(([n]) => n === 'bold'), 'bold di dalam kode');
        ok(r.tags.some(([n]) => n === 'code'), 'tag code tidak ada');
    });
    test('gambar dikumpulkan beserta url tanpa judul', () => {
        const r = parseInline('a ![x y](img/a.png "Judul") b ![](c.jpg)');
        eq(r.images.map(i => [i.alt, i.url, i.start, i.end]), [['x y', 'img/a.png', 2, 27], ['', 'c.jpg', 30, 40]]);
    });
    test('underscore di URL tautan tidak jadi miring', () => {
        const r = parseInline('[x](http://a.com/a_b_c)');
        ok(!r.tags.some(([n]) => n === 'italic'), JSON.stringify(r.tags));
    });
    test('snake_case tidak jadi miring', () => {
        ok(!parseInline('nama_variabel_ini').tags.some(([n]) => n === 'italic'), 'jadi miring');
    });
    test('makeCpMap menghitung emoji sebagai satu karakter', () => {
        const map = makeCpMap('🎉ab');
        eq([map(0), map(2), map(3), map(4)], [0, 1, 2, 3]);
    });

    section('Pengaturan');
    test('pengaturan disimpan lalu dibaca kembali', () => {
        eq(loadSettings().focus, false, 'nilai bawaan');
        saveSettings({ ...DEFAULTS, focus: true });
        ok(GLib.file_test(GLib.build_filenamev([tmp, 'nyerat', 'settings.json']), GLib.FileTest.EXISTS), 'file tidak dibuat');
        eq(loadSettings().focus, true, 'nilai tersimpan');
    });

    section('Bahasa blok kode');
    test('nama bahasa umum dan alias dikenali', () => {
        const ids = ['js', 'javascript', 'ts', 'py', 'python', 'bash', 'rs', 'go', 'c++', 'yml', 'json', 'html', 'sql']
            .map(n => resolveLanguage(n)?.get_id() ?? null);
        eq(ids, ['js', 'js', 'typescript', 'python3', 'python3', 'sh', 'rust', 'go', 'cpp', 'yaml', 'json', 'html', 'sql']);
    });
    test('nama tak dikenal dan kosong tidak diwarnai', () => {
        eq([resolveLanguage('bahasa-ngarang'), resolveLanguage('')], [null, null]);
    });

    section('Markdown → HTML');
    test('heading dengan id', () => contains(body('## Halo Dunia'), '<h2 id="halo-dunia">Halo Dunia</h2>'));
    test('format inline', () => eq(body('**a** *b* `c` ~~d~~ ==e=='),
        '<p><strong>a</strong> <em>b</em> <code>c</code> <del>d</del> <mark>e</mark></p>'));
    test('tautan dan gambar', () => {
        const h = body('[GTK](https://gtk.org/a_b) ![logo](img/x.png)');
        contains(h, '<a href="https://gtk.org/a_b">GTK</a>');
        contains(h, '<img src="img/x.png" alt="logo">');
    });
    test('HTML di blok kode di-escape', () => eq(body('```html\n<b>&</b>\n```'),
        '<pre><code class="language-html">&lt;b&gt;&amp;&lt;/b&gt;</code></pre>'));
    test('tabel', () => {
        const h = body('| A | B |\n|:--|--:|\n| 1 | 2 |');
        contains(h, '<th style="text-align:left">A</th>');
        contains(h, '<td style="text-align:right">2</td>');
    });
    test('daftar tugas', () => {
        const h = body('- [x] selesai\n- [ ] belum');
        contains(h, '<input type="checkbox" disabled checked> selesai');
        contains(h, '<input type="checkbox" disabled> belum');
    });
    test('daftar bersarang', () => contains(body('1. a\n   - b\n2. c'), '<li>a\n<ul>\n<li>b</li>\n</ul></li>'));
    test('daftar bernomor mulai dari 3', () => contains(body('3. a\n4. b'), '<ol start="3">'));
    test('kutipan', () => eq(body('> halo\n> *dunia*'), '<blockquote>\n<p>halo\n<em>dunia</em></p>\n</blockquote>'));
    test('garis pemisah', () => eq(body('a\n\n---\n\nb'), '<p>a</p>\n<hr>\n<p>b</p>'));
    test('karakter HTML di teks di-escape', () => eq(body('a < b & "c"'), '<p>a &lt; b &amp; &quot;c&quot;</p>'));
    test('escape backslash', () => eq(body('\\*bukan miring\\*'), '<p>*bukan miring*</p>'));
    test('backtick yang di-escape bukan kode', () => eq(body('\\`bukan kode\\`'), '<p>`bukan kode`</p>'));
    test('backslash di dalam kode tetap apa adanya', () => eq(body('`C:\\*`'), '<p><code>C:\\*</code></p>'));
    test('tabel tanpa pipa di tepi', () => {
        const h = body('Nama | Nilai\n--- | ---\nSatu | 1');
        contains(h, '<th>Nama</th><th>Nilai</th>');
        contains(h, '<td>Satu</td><td>1</td>');
    });
    test('"---" di bawah teks berpipa tetap garis pemisah, bukan tabel', () =>
        eq(body('a | b\n\n---'), '<p>a | b</p>\n<hr>'));
}

// ───────────────────────── Tes editor (GUI) ─────────────────────────

function runGuiTests(app: Gtk.Application): void {
    const settings = { ...DEFAULTS, welcomed: true, dark: false };
    const w = new MainWindow(app, settings, null);
    const ed = w.editor;
    const buf = ed.buffer;
    const ctx = GLib.MainContext.default();
    const pump = () => { for (let i = 0; i < 200 && ctx.pending(); i++) ctx.iteration(false); };
    const text = () => { const [s, e] = buf.get_bounds(); return buf.get_text(s, e, true); };
    const setText = (t: string) => { ed.setText(t); pump(); };
    const cursorTo = (line: number, col = 0) => {
        const it = buf.get_iter_at_line(line);
        if (col < 0) it.forward_to_line_end(); else it.forward_chars(col);
        buf.place_cursor(it);
        pump();
    };
    // Posisi (code point) teks needle di dalam s.
    const offsetIn = (s: string, needle: string) => {
        const i = s.indexOf(needle);
        if (i < 0) throw new Error(`teks ${JSON.stringify(needle)} tidak ditemukan`);
        return Array.from(s.slice(0, i)).length;
    };
    const hidden = (off: number) => buf.get_iter_at_offset(off).has_tag(ed.tags.hidden);
    const tagAt = (off: number, name: TagName) => buf.get_iter_at_offset(off).has_tag(ed.tags[name]);
    const key = (keyval: number, state = 0 as Gdk.ModifierType) => {
        const handled = ed.onKey({ get_keyval: () => [true, keyval], get_state: () => [true, state] });
        if (!handled) buf.insert_at_cursor(keyval === Gdk.KEY_Return ? '\n' : '', -1);
        pump();
    };
    const action = (name: string | Option) => { app.lookup_action(name)!.activate(null); pump(); };
    const clickAt = (off: number) => {
        const rect = ed.view.get_iter_location(buf.get_iter_at_offset(off));
        const [x, y] = ed.view.buffer_to_window_coords(Gtk.TextWindowType.TEXT, rect.x + 2, rect.y + rect.height / 2);
        const handled = ed.onClick({
            get_button: () => [true, 1], get_event_type: () => Gdk.EventType.BUTTON_PRESS,
            get_coords: () => [true, x, y], get_state: () => [true, 0 as Gdk.ModifierType],
        });
        pump();
        return handled;
    };

    pump();

    section('Menyembunyikan sintaks (ala Typora)');
    test('marker heading tersembunyi saat kursor di baris lain', () => {
        setText('# Judul\n\nteks **tebal** di sini');
        cursorTo(2, -1);
        ok(hidden(0), '"#" seharusnya tersembunyi');
        ok(!hidden(17), '"**" di baris aktif seharusnya terlihat');
    });
    test('marker muncul saat kursor pindah ke barisnya', () => {
        cursorTo(0);
        ok(!hidden(0), '"#" seharusnya terlihat');
        ok(hidden(14), '"**" di baris lain seharusnya tersembunyi');
        ok(tagAt(16, 'bold'), 'teks tebal tidak diberi tag bold');
    });
    test('offset benar setelah emoji', () => {
        setText('🎉 **a**\n');
        cursorTo(1);
        ok(hidden(2) && hidden(3), '"**" setelah emoji seharusnya tersembunyi');
        ok(!hidden(4) && tagAt(4, 'bold'), 'huruf "a" seharusnya tebal dan terlihat');
    });
    test('baris pembatas blok kode tersembunyi di luar blok', () => {
        setText('a\n```js\nkode\n```\nb');
        cursorTo(0);
        ok(hidden(2) && hidden(13), 'pembatas ``` seharusnya tersembunyi');
        ok(tagAt(9, 'codeblock') && !hidden(9), 'isi kode seharusnya terlihat');
    });
    test('baris pembatas muncul saat kursor di dalam blok', () => {
        cursorTo(2);
        ok(!hidden(2) && !hidden(13), 'pembatas ``` seharusnya terlihat');
    });
    test('mode source menampilkan semua marker', () => {
        setText('# a\n\n**b**');
        cursorTo(2);
        ok(hidden(0), 'awal: "#" tersembunyi');
        action('source');
        ok(!hidden(0), 'mode source: "#" seharusnya terlihat');
        action('source');
        ok(hidden(0), 'setelah mode source dimatikan: "#" tersembunyi lagi');
    });
    test('outline berisi heading', () => {
        setText('# Satu\n## Dua\nteks\n### Tiga');
        eq(ed.headings.map(h => [h.level, h.text, h.line]), [[1, 'Satu', 0], [2, 'Dua', 1], [3, 'Tiga', 3]]);
        eq(w.outline.list.get_children().length, 3, 'jumlah baris outline');
    });

    section('Enter dan Tab di daftar');
    test('Enter melanjutkan daftar biasa', () => {
        setText('- satu'); cursorTo(0, -1); key(Gdk.KEY_Return);
        eq(text(), '- satu\n- ');
    });
    test('Enter di item kosong mengakhiri daftar', () => {
        key(Gdk.KEY_Return);
        eq(text(), '- satu\n');
    });
    test('Enter menaikkan nomor daftar', () => {
        setText('9. a'); cursorTo(0, -1); key(Gdk.KEY_Return);
        eq(text(), '9. a\n10. ');
    });
    test('Enter di daftar tugas membuat kotak kosong', () => {
        setText('- [x] a'); cursorTo(0, -1); key(Gdk.KEY_Return);
        eq(text(), '- [x] a\n- [ ] ');
    });
    test('Enter melanjutkan kutipan', () => {
        setText('> a'); cursorTo(0, -1); key(Gdk.KEY_Return);
        eq(text(), '> a\n> ');
    });
    test('Enter di dalam blok kode tidak menambah bullet', () => {
        setText('```\n- a\n```'); cursorTo(1, -1);
        ok(!ed.onKey({ get_keyval: () => [true, Gdk.KEY_Return], get_state: () => [true, 0 as Gdk.ModifierType] }), 'Enter ditangani sebagai daftar');
    });
    test('Tab dan Shift+Tab mengatur indentasi', () => {
        setText('- a'); cursorTo(0, -1);
        key(Gdk.KEY_Tab); eq(text(), '    - a', 'setelah Tab');
        key(Gdk.KEY_ISO_Left_Tab, Gdk.ModifierType.SHIFT_MASK); eq(text(), '- a', 'setelah Shift+Tab');
    });

    section('Perintah format');
    test('Ctrl+B membungkus pilihan dengan **', () => {
        setText('satu kata');
        buf.select_range(buf.get_iter_at_offset(5), buf.get_iter_at_offset(9)); pump();
        action('bold');
        eq(text(), 'satu **kata**');
    });
    test('Ctrl+B lagi melepas **', () => { action('bold'); eq(text(), 'satu kata'); });
    test('undo mengembalikan perubahan', () => {
        setText('x');
        buf.select_range(buf.get_start_iter(), buf.get_end_iter()); pump();
        action('italic');
        eq(text(), '*x*', 'setelah Ctrl+I');
        buf.undo(); pump();
        eq(text(), 'x', 'setelah undo');
    });
    test('Ctrl+2 dan Ctrl+0 mengatur heading', () => {
        setText('judul'); cursorTo(0);
        action('heading2'); eq(text(), '## judul', 'Ctrl+2');
        action('heading0'); eq(text(), 'judul', 'Ctrl+0');
    });
    test('kutipan diterapkan ke beberapa baris', () => {
        setText('a\nb');
        buf.select_range(buf.get_start_iter(), buf.get_end_iter()); pump();
        action('quote'); eq(text(), '> a\n> b');
    });
    test('Ctrl+K membuat tautan dari pilihan', () => {
        setText('GTK');
        buf.select_range(buf.get_start_iter(), buf.get_end_iter()); pump();
        action('link'); eq(text(), '[GTK]()');
    });
    test('klik kotak tugas mencentang dan menghapus centang', () => {
        setText('- [ ] tugas\n\nlain'); cursorTo(2);
        ok(clickAt(3), 'klik tidak ditangani');
        eq(text(), '- [x] tugas\n\nlain', 'setelah klik pertama');
        clickAt(3);
        eq(text(), '- [ ] tugas\n\nlain', 'setelah klik kedua');
    });

    section('File');
    test('simpan lalu buka lagi menghasilkan isi yang sama', () => {
        const path = GLib.build_filenamev([tmp, 'uji.md']);
        const content = '# Uji 🎉\n\nÄÖÜ — ✓\n';
        setText(content);
        w.file = path;
        ok(w.save(), 'save() gagal');
        ok(!buf.get_modified(), 'status modified tidak direset');
        setText('');
        ok(w.load(path), 'load() gagal');
        eq(text(), content);
    });

    section('Gambar');
    // Gambar uji 300×100 di folder sementara.
    const imgDir = GLib.build_filenamev([tmp, 'gambar']);
    GLib.mkdir_with_parents(imgDir, 0o755);
    const pb = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 300, 100);
    pb.fill(0x4183c4ff);
    pb.savev(GLib.build_filenamev([imgDir, 'uji.png']), 'png', [], []);
    const images = () => ed.images.blocks;
    const waitImages = () => {
        for (let i = 0; i < 200 && images().some(b => b.items.some(it => !it.entry || it.entry.status === 'loading')); i++) {
            pump();
            GLib.usleep(10000);
        }
        pump();
    };
    const hasGap = (line: number) => buf.get_iter_at_line(line).get_tags().some(t => t.name?.startsWith('image-gap-'));

    test('gambar lokal dimuat dan ditampilkan di bawah barisnya', () => {
        w.file = GLib.build_filenamev([tmp, 'dok.md']);
        setText('judul\n\n![uji](gambar/uji.png)\n\nakhir');
        waitImages();
        eq(images().length, 1, 'jumlah blok gambar');
        const block = images()[0];
        eq(block.items[0].entry?.status, 'ok', 'status muat');
        ok(block.box.get_visible(), 'widget gambar tidak terlihat');
        ok(hasGap(2), 'ruang di bawah baris gambar tidak disediakan');
        const [lineY] = ed.view.get_line_yrange(buf.get_iter_at_line(2));
        ok(block.y > lineY, `gambar (y=${block.y}) tidak di bawah barisnya (y=${lineY})`);
    });
    test('isi dokumen tidak berubah karena gambar', () => {
        eq(text(), 'judul\n\n![uji](gambar/uji.png)\n\nakhir');
    });
    test('sintaks gambar tersembunyi di baris lain, terlihat di baris aktif', () => {
        cursorTo(0);
        ok(hidden(9) && hidden(15), '![uji](...) seharusnya tersembunyi');
        cursorTo(2);
        ok(!hidden(9) && !hidden(15), '![uji](...) seharusnya terlihat');
    });
    test('widget dipakai ulang saat baris bergeser', () => {
        const before = images()[0];
        buf.insert(buf.get_start_iter(), 'baris baru\n', -1);
        pump();
        eq(images().length, 1, 'jumlah blok gambar');
        ok(images()[0] === before, 'widget dibuat ulang');
        eq(images()[0].line, 3, 'baris gambar');
        ok(hasGap(3) && !hasGap(2), 'ruang kosong tidak ikut pindah');
    });
    test('gambar yang tidak ada menampilkan pesan', () => {
        setText('![hilang](gambar/tidak-ada.png)');
        waitImages();
        eq(images()[0].items[0].entry?.status, 'error', 'status muat');
        const label = images()[0].content.get_children()[0];
        ok(label instanceof Gtk.Label && label.label.includes('hilang'), 'label error tidak tampil');
    });
    test('gambar di baris tabel dan blok kode diabaikan', () => {
        setText('| ![a](gambar/uji.png) |\n| --- |\n\n```\n![b](gambar/uji.png)\n```');
        eq(images().length, 0, 'jumlah blok gambar');
    });
    test('mode source menyembunyikan gambar', () => {
        setText('![uji](gambar/uji.png)\nteks');
        waitImages();
        action('source');
        ok(!images()[0].box.get_visible() && !hasGap(0), 'gambar masih tampil di mode source');
        action('source');
        ok(images()[0].box.get_visible() && hasGap(0), 'gambar tidak muncul lagi');
    });
    test('klik gambar memindahkan kursor ke barisnya', () => {
        cursorTo(1);
        ed.images.onActivate(images()[0].line);
        pump();
        eq(buf.get_iter_at_mark(buf.get_insert()).get_line(), 0, 'baris kursor');
    });
    test('menghapus sintaks gambar menghapus widgetnya', () => {
        setText('teks saja');
        eq(images().length, 0, 'jumlah blok gambar');
    });
    w.file = null;

    section('Warna blok kode');
    const syntaxTags = (off: number) => buf.get_iter_at_offset(off).get_tags().filter(t => t.name?.startsWith('syntax:'));
    const colorAt = (off: number) => syntaxTags(off).map(t => t.foreground_rgba?.to_string()).find(Boolean) ?? null;
    test('kata kunci, string, dan komentar diwarnai berbeda', () => {
        setText('teks\n\n```js\nconst s = "halo"; // catatan\n```\n');
        const at = (needle: string) => offsetIn(text(), needle);
        ok(syntaxTags(at('const')).length > 0, 'kata kunci tidak diwarnai');
        const str = colorAt(at('"halo"') + 1), comment = colorAt(at('// catatan') + 3);
        ok(str && comment && str !== comment, `warna string (${str}) dan komentar (${comment}) harus berbeda`);
        ok(syntaxTags(at('teks')).length === 0, 'teks di luar blok ikut diwarnai');
    });
    test('isi dokumen tidak berubah karena pewarnaan', () => {
        eq(text(), 'teks\n\n```js\nconst s = "halo"; // catatan\n```\n');
    });
    test('blok tanpa bahasa atau bahasa tak dikenal tidak diwarnai', () => {
        setText('```\nconst a = 1;\n```\n\n```ngarang\nconst b = 2;\n```');
        ok(syntaxTags(offsetIn(text(), 'const a')).length === 0, 'blok tanpa bahasa diwarnai');
        ok(syntaxTags(offsetIn(text(), 'const b')).length === 0, 'blok bahasa tak dikenal diwarnai');
    });
    test('mengetik di dalam blok mewarnai ulang', () => {
        setText('```python\nx = 1\n```');
        ok(syntaxTags(offsetIn(text(), 'x')).length === 0, 'awal: "x" tidak bergaya');
        cursorTo(1);
        buf.insert_at_cursor('def ', -1);
        pump();
        ok(syntaxTags(offsetIn(text(), 'def')).length > 0, '"def" tidak diwarnai setelah diketik');
    });
    test('emoji sebelum blok tidak menggeser warna', () => {
        setText('🎉🎉\n```js\nreturn 1;\n```');
        const off = offsetIn(text(), 'return');
        ok(syntaxTags(off).length > 0 && syntaxTags(off + 5).length > 0, '"return" tidak diwarnai utuh');
        ok(syntaxTags(off - 1).length === 0, 'warna bergeser ke sebelum "return"');
    });
    test('mode gelap memakai skema warna lain', () => {
        setText('```js\nconst s = "halo";\n```');
        const off = offsetIn(text(), '"halo"') + 1;
        const light = colorAt(off);
        action('dark');
        const dark = colorAt(off);
        action('dark');
        ok(light && dark && light !== dark, `warna terang (${light}) dan gelap (${dark}) sama`);
        eq(colorAt(off), light, 'kembali ke warna terang');
    });
    test('mode fokus tetap meredupkan blok kode di paragraf lain', () => {
        setText('paragraf\n\n```js\nconst s = 1;\n```');
        cursorTo(0);
        action('focus');
        // dim dan hidden harus di atas semua tag warna kode, supaya warnanya menang.
        const maxSyntax = Math.max(...syntaxTags(offsetIn(text(), 'const')).map(t => t.get_priority()));
        ok(ed.tags.dim.get_priority() > maxSyntax && ed.tags.hidden.get_priority() > maxSyntax,
            `prioritas dim/hidden (${ed.tags.dim.get_priority()}/${ed.tags.hidden.get_priority()}) tidak di atas warna kode (${maxSyntax})`);
        ok(tagAt(offsetIn(text(), 'const'), 'dim'), 'blok kode tidak diredupkan');
        action('focus');
    });

    section('Folder');
    // Struktur uji:
    //   proyek/a.md  b.txt  Catatan.markdown  sub/c.md  sub/dalam/d.md
    //   proyek/.tersembunyi/x.md  node_modules/y.md  z-kosong/
    const proj = GLib.build_filenamev([tmp, 'proyek']);
    const write = (rel: string, content = '') => {
        const full = GLib.build_filenamev([proj, rel]);
        GLib.mkdir_with_parents(GLib.path_get_dirname(full), 0o755);
        GLib.file_set_contents(full, content);
        return full;
    };
    write('a.md', '# A');
    write('b.txt', 'bukan markdown');
    write('Catatan.markdown', '# Catatan');
    write('sub/c.md', '# C');
    const dPath = write('sub/dalam/d.md', '# D');
    write('.tersembunyi/x.md');
    write('node_modules/y.md');
    GLib.mkdir_with_parents(GLib.build_filenamev([proj, 'z-kosong']), 0o755);

    const ft = w.fileTree;
    const childNames = (parent: Gtk.TreeIter | null) => {
        const names: string[] = [];
        let [ok, it] = ft.store.iter_children(parent);
        while (ok) { names.push(ft.store.get_value(it, 0) as string); ok = ft.store.iter_next(it); }
        return names;
    };
    const rowOf = (parent: Gtk.TreeIter | null, name: string) => {
        let [ok, it] = ft.store.iter_children(parent);
        while (ok) { if (ft.store.get_value(it, 0) === name) return it; ok = ft.store.iter_next(it); }
        throw new Error(`baris "${name}" tidak ada`);
    };
    const waitFor = (cond: () => boolean) => {
        for (let i = 0; i < 300 && !cond(); i++) { pump(); GLib.usleep(10000); }
        return cond();
    };

    test('isi folder: subfolder dulu, hanya Markdown, tanpa file tersembunyi', () => {
        eq(listFolder(proj).map(e => e.name), ['sub', 'z-kosong', 'a.md', 'Catatan.markdown']);
    });
    test('membuka folder menampilkan pohon di tab Berkas', () => {
        w.openFolder(proj);
        pump();
        eq(ft.root, proj, 'root');
        eq(childNames(null), ['sub', 'z-kosong', 'a.md', 'Catatan.markdown'], 'baris root');
        eq(w.sidebar.page, 'files', 'tab sidebar');
        ok(w.sidebar.visible, 'sidebar tidak terlihat');
        eq(loadSettings().folder, proj, 'folder tersimpan di pengaturan');
    });
    test('isi subfolder baru dibaca saat dibuka', () => {
        const sub = rowOf(null, 'sub');
        eq(childNames(sub), [''], 'sebelum dibuka (baris pengganti)');
        ft.view.expand_row(ft.store.get_path(sub)!, false);
        pump();
        eq(childNames(sub), ['dalam', 'c.md'], 'setelah dibuka');
    });
    test('klik file di pohon membukanya di editor', () => {
        const row = rowOf(null, 'a.md');
        ft.view.row_activated(ft.store.get_path(row)!, ft.view.get_column(0)!);
        pump();
        eq(w.file, GLib.build_filenamev([proj, 'a.md']), 'file');
        eq(text(), '# A', 'isi editor');
    });
    test('file yang dibuka disorot, folder induknya ikut dibuka', () => {
        ok(w.load(dPath), 'load() gagal');
        pump();
        const [selected, , iter] = ft.view.get_selection().get_selected();
        ok(selected && iter, 'tidak ada baris tersorot');
        eq(ft.store.get_value(iter, 1), dPath, 'baris tersorot');
        const dalam = rowOf(rowOf(null, 'sub'), 'dalam');
        ok(ft.view.row_expanded(ft.store.get_path(dalam)!), 'folder "dalam" tidak terbuka');
    });
    test('file baru di disk muncul tanpa menutup subfolder yang terbuka', () => {
        write('b-baru.md', '# Baru');
        ok(waitFor(() => childNames(null).includes('b-baru.md')), 'file baru tidak muncul');
        eq(childNames(null), ['sub', 'z-kosong', 'a.md', 'b-baru.md', 'Catatan.markdown'], 'urutan');
        ok(ft.view.row_expanded(ft.store.get_path(rowOf(null, 'sub'))!), 'subfolder ikut tertutup');
    });
    test('file yang dihapus di disk hilang dari pohon', () => {
        GLib.unlink(GLib.build_filenamev([proj, 'b-baru.md']));
        ok(waitFor(() => !childNames(null).includes('b-baru.md')), 'file terhapus masih tampil');
    });
    test('file non-Markdown yang ditambahkan tidak muncul', () => {
        write('gambar.png');
        write('c-baru.md');
        ok(waitFor(() => childNames(null).includes('c-baru.md')), 'file Markdown baru tidak muncul');
        ok(!childNames(null).includes('gambar.png'), 'file .png ikut tampil');
    });
    test('load() dengan path folder membuka folder, bukan error', () => {
        ft.setRoot(null);
        // Sebelum diperbaiki, ini menampilkan dialog error "Is a directory" (dan tes macet di dialog itu).
        ok(w.load(proj), 'load() gagal');
        pump();
        eq(ft.root, proj, 'root');
        eq(w.sidebar.page, 'files', 'tab sidebar');
        eq(w.file, GLib.build_filenamev([proj, 'sub', 'dalam', 'd.md']), 'file yang terbuka tidak berubah');
    });
    test('folder sebagai argumen membuka folder itu', () => {
        const w2 = new MainWindow(app, { ...DEFAULTS, welcomed: true, dark: false }, proj);
        pump();
        eq(w2.fileTree.root, proj, 'root jendela kedua');
        eq(w2.file, null, 'tidak ada file yang dibuka');
        w2.editor.buffer.set_modified(false);
        w2.win.destroy();
        pump();
    });
    test('folder terakhir dipulihkan tanpa memaksa sidebar terbuka', () => {
        const w3 = new MainWindow(app, { ...DEFAULTS, welcomed: true, dark: false, folder: proj, sidebar: false }, null);
        pump();
        eq(w3.fileTree.root, proj, 'root');
        ok(!w3.sidebar.visible, 'sidebar dipaksa terbuka');
        w3.editor.buffer.set_modified(false);
        w3.win.destroy();
        pump();
    });
    test('menutup folder mengosongkan pohon', () => {
        ft.setRoot(null);
        eq(childNames(null), [], 'baris');
    });
    buf.set_modified(false);
    w.file = null;

    section('Dokumen contoh semua format (tests/samples/semua-format.md)');
    const samplePath = GLib.build_filenamev([ROOT, 'tests', 'samples', 'semua-format.md']);
    const offsetOf = (needle: string) => {
        const t = text(), i = t.indexOf(needle);
        ok(i >= 0, `teks ${JSON.stringify(needle)} tidak ditemukan`);
        return Array.from(t.slice(0, i)).length;
    };
    test('file dibuka dan semua heading masuk outline', () => {
        ok(w.load(samplePath), 'load() gagal');
        pump();
        const names = ed.headings.map(h => h.text);
        for (const h of ['Uji Semua Format Markdown', 'Heading 6', 'Heading dengan tanda penutup', '14. Kasus sulit'])
            ok(names.includes(h), `heading "${h}" tidak ada`);
        ok(!names.some(n => n.includes('Tujuh pagar') || n.includes('Tanpa spasi')), 'teks yang bukan heading masuk outline');
    });
    test('format inline mendapat tag yang benar', () => {
        cursorTo(0);
        const cases: [string, TagName][] = [['tebal dengan bintang', 'bold'], ['miring dengan garis bawah', 'italic'], ['tebal miring*', 'bolditalic'],
            ['dicoret', 'strike'], ['distabilo', 'mark'], ['gjs -m nyerat.js', 'code'], ['GTK](', 'link'], ['Logo GTK', 'image']];
        for (const [needle, tag] of cases) ok(tagAt(offsetOf(needle) + 1, tag), `"${needle}" tidak bertag ${tag}`);
    });
    test('kasus sulit tidak salah format', () => {
        ok(!tagAt(offsetOf('case_seperti') + 2, 'italic'), 'snake_case jadi miring');
        ok(!tagAt(offsetOf('3 * 4') , 'italic'), '"2 * 3 * 4" jadi miring');
        ok(!tagAt(offsetOf('bukan kode\\`') + 1, 'code'), 'backtick yang di-escape jadi kode');
        ok(!tagAt(offsetOf('**bukan tebal**`') + 3, 'bold'), 'isi kode inline jadi tebal');
        ok(!tagAt(offsetOf('nama_file_ini') + 6, 'italic'), 'URL dengan garis bawah jadi miring');
    });
    test('tabel dengan dan tanpa pipa di tepi dikenali', () => {
        ok(tagAt(offsetOf('| Kiri') + 2, 'tablehead'), 'judul tabel berpipa');
        ok(tagAt(offsetOf('Satu | 1'), 'table'), 'baris tabel tanpa pipa di tepi');
        ok(tagAt(offsetOf('Nama | Nilai'), 'tablehead'), 'judul tabel tanpa pipa di tepi');
    });
    test('blok kode 4 backtick memuat ``` di dalamnya', () => {
        const inner = offsetOf('kode\n```\n````') ;
        ok(tagAt(inner, 'codeblock'), 'isi blok tidak bertag codeblock');
        ok(tagAt(offsetOf('Tingkat tiga'), 'quote'), 'kutipan bersarang tidak bertag quote');
    });
    test('kursor menyapu seluruh dokumen contoh', () => {
        const n = buf.get_line_count();
        for (let i = 0; i < n; i++) { cursorTo(i); cursorTo(i, -1); }
    });
    test('ekspor HTML dokumen contoh lengkap', () => {
        const h = markdownToHtml(readTextFile(samplePath), 't');
        for (const tag of ['<h6', '<strong><em>', '<del>', '<mark>', '<code>', '<a href=', '<img ', '<ol start="7">',
            'type="checkbox"', '<blockquote>\n<p>Tingkat dua', '<pre><code class="language-bash">', '<table>', '<hr>', '<br>'])
            contains(h, tag);
        eq((h.match(/<table>/g) || []).length, 2, 'jumlah tabel');
    });
    buf.set_modified(false);

    section('Ukuran jendela');
    const settle = () => { for (let i = 0; i < 40; i++) { pump(); GLib.usleep(15000); } };
    const winWidth = () => w.win.get_size()[0];
    test('membuka file kedua tidak memperbesar jendela', () => {
        w.win.resize(1100, 700); settle();
        const before = winWidth();
        ok(w.load(samplePath), 'load() file pertama gagal'); waitImages(); settle();
        ok(w.load(GLib.build_filenamev([ROOT, 'README.md'])), 'load() file kedua gagal');
        settle();
        eq(winWidth(), before, 'lebar jendela');
    });
    test('jendela bisa diperbesar lalu diperkecil lagi', () => {
        w.win.resize(1500, 700); settle();
        eq(winWidth(), 1500, 'setelah diperbesar');
        w.win.resize(800, 700); settle();
        eq(winWidth(), 800, 'setelah diperkecil');
        ok(ed.view.get_left_margin() < 100, `margin tidak ikut mengecil (${ed.view.get_left_margin()})`);
    });
    test('gambar tidak lebih lebar dari kolom teks', () => {
        ok(w.load(samplePath), 'load() gagal'); waitImages(); settle();
        const column = ed.widget.get_allocated_width() - 2 * ed.view.get_left_margin();
        for (const block of images())
            ok(block.box.get_allocated_width() <= column, `gambar ${block.box.get_allocated_width()}px > kolom ${column}px`);
        w.win.resize(1100, 700); settle();
    });
    buf.set_modified(false);
    w.file = null;

    section('Ketahanan (mencari crash)');
    test('kursor menyapu setiap baris dokumen contoh', () => {
        setText(WELCOME);
        const n = buf.get_line_count();
        for (let i = 0; i < n; i++) { cursorTo(i); cursorTo(i, -1); }
        for (let i = n - 1; i >= 0; i--) cursorTo(i);
    });
    test('mengetik di setiap baris dokumen contoh', () => {
        const n = buf.get_line_count();
        for (let i = 0; i < n; i++) { cursorTo(i); buf.insert_at_cursor('x', -1); pump(); }
    });
    test('menghapus seluruh dokumen sedikit demi sedikit', () => {
        setText(WELCOME);
        while (buf.get_char_count() > 0) {
            const e = buf.get_end_iter(), s = e.copy();
            s.backward_chars(7);
            buf.delete(s, e);
            pump();
        }
    });
    test('mode fokus dan typewriter aktif bersamaan', () => {
        setText(WELCOME);
        action('focus'); action('typewriter');
        for (let i = 0; i < buf.get_line_count(); i++) cursorTo(i);
        action('focus'); action('typewriter');
    });

    if (opt('mouse')) {
        section('Klik mouse sungguhan (XTest)');
        test('klik di seluruh area teks', () => {
            setText(WELCOME);
            const tw = ed.view.get_window(Gtk.TextWindowType.TEXT)!;
            for (let y = 20; y < tw.get_height(); y += 23) {
                for (const x of [20, 250, 600]) {
                    Gdk.test_simulate_button(tw, x, y, 1, 0 as Gdk.ModifierType, Gdk.EventType.BUTTON_PRESS);
                    Gdk.test_simulate_button(tw, x, y, 1, 0 as Gdk.ModifierType, Gdk.EventType.BUTTON_RELEASE);
                    pump();
                }
            }
        });
    }

    const shot = optVal('screenshot');
    if (shot) {
        setText(WELCOME);
        cursorTo(0);
        ed.view.scroll_to_iter(buf.get_start_iter(), 0, false, 0, 0);
        for (let i = 0; i < 20; i++) { pump(); GLib.usleep(20000); }
        const gw = w.win.get_window()!;
        Gdk.pixbuf_get_from_window(gw, 0, 0, gw.get_width(), gw.get_height())?.savev(shot, 'png', [], []);
        print(`\n${DIM}Tangkapan layar: ${shot}${RESET}`);
    }

    buf.set_modified(false);
    w.win.destroy();
}

// ───────────────────────── Jalankan ─────────────────────────

runUnitTests();

if (!opt('no-gui')) {
    if (!Gdk.Display.get_default() && !GLib.getenv('DISPLAY') && !GLib.getenv('WAYLAND_DISPLAY')) {
        print(`\n${DIM}Tes GUI dilewati: tidak ada display.${RESET}`);
    } else {
        const app = new Gtk.Application({ application_id: 'id.eka.Nyerat.Test', flags: Gio.ApplicationFlags.NON_UNIQUE });
        app.connect('activate', () => {
            app.hold();
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                try {
                    runGuiTests(app);
                } catch (e) {
                    failed++;
                    print(`${RED}Tes GUI berhenti: ${errorMessage(e)}${RESET}\n${e instanceof Error ? e.stack : ''}`);
                }
                app.release();
                app.quit();
                return GLib.SOURCE_REMOVE;
            });
        });
        app.run([System.programInvocationName]);
    }
}

print(`\n${failed ? RED : GREEN}${passed} lulus, ${failed} gagal${RESET}`);
System.exit(failed ? 1 : 0);
