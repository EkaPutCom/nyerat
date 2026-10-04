// Tes GUI: Ketahanan (mencari crash).

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=3.0';
import Gdk from 'gi://Gdk?version=3.0';
import { WELCOME } from '../../src/welcome.js';
import { readTextFile } from '../../src/files.js';
import { highlight } from '../../src/editor/highlighter.js';
import { createTags, SYNTAX_TAGS } from '../../src/editor/tags.js';
import { LineTagger, normalize, tagRanges } from '../../src/editor/tagsync.js';
import { section, test, ok, eq, tmp, opt, DIM, RESET } from '../framework.js';
import type { GuiContext } from './context.js';

export function robustnessTests(c: GuiContext): void {
    const { w, ed, buf, pump, text, setText, cursorTo, action, waitImages, samplePath } = c;

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
    // Penyorotan hanya memasang ulang baris yang berubah (editor/tagsync.ts). Setelah suntingan
    // apa pun, tag di buffer harus sama persis dengan hasil menyorot dokumen itu dari awal.
    test('penyorotan bertahap sama dengan penyorotan dari awal', () => {
        // Tag mermaidhide dan jarak gambar bergantung pada render/pemuatan asinkron, jadi tidak dibandingkan.
        const snapshot = () => {
            const out: Record<string, string> = {};
            buf.get_tag_table().foreach(tag => {
                const name = tag.name ?? '';
                if (name === 'mermaidhide' || name.startsWith('image-gap') || name.startsWith('mermaid-gap')) return;
                const r = tagRanges(buf, tag);
                if (r.length) out[name] = JSON.stringify(r);
            });
            return out;
        };
        const compare = (what: string) => {
            const cursor = buf.get_iter_at_mark(buf.get_insert()).get_offset();
            const incremental = snapshot();
            ed.setText(text());
            buf.place_cursor(buf.get_iter_at_offset(cursor));
            pump();
            const fresh = snapshot();
            for (const name of new Set([...Object.keys(incremental), ...Object.keys(fresh)]))
                eq(incremental[name], fresh[name], `tag ${name} setelah ${what}`);
        };

        // Pembangkit acak sederhana dengan benih tetap, supaya kegagalan bisa diulang.
        let seed = 7;
        const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
        const pieces = ['x', '\n', '**', '`', '```\n', '| a |', '# ', '- [ ] ', '> ', '🎉', '~~', '\n\n', '![g](a.png)'];
        setText(readTextFile(samplePath));
        for (let round = 0; round < 8; round++) {
            // Beberapa suntingan sebelum penyorotan berjalan, supaya rentang kotor digabung.
            for (let k = 0; k < 1 + rand(4); k++) {
                const n = buf.get_char_count();
                const at = buf.get_iter_at_offset(rand(n + 1));
                if (rand(3) === 0 && n > 0) {
                    const end = at.copy();
                    end.forward_chars(1 + rand(30));
                    buf.delete(at, end);
                } else {
                    buf.insert(at, pieces[rand(pieces.length)], -1);
                }
            }
            buf.place_cursor(buf.get_iter_at_offset(rand(buf.get_char_count() + 1)));
            pump();
            if (round % 3 === 2) { buf.undo(); pump(); }
            compare(`suntingan ke-${round + 1}`);
        }
    });
    // Marker disembunyikan bertahap (editor/decorations.ts): hanya baris aktif lama/baru dan
    // baris yang diurai ulang yang diperiksa. Bandingkan dengan menghitung semua marker.
    test('marker tersembunyi bertahap sama dengan perhitungan penuh', () => {
        const expected = () => {
            const ins = buf.get_iter_at_mark(buf.get_insert()).get_line();
            const sel = buf.get_iter_at_mark(buf.get_selection_bound()).get_line();
            const l0 = Math.min(ins, sel), l1 = Math.max(ins, sel);
            if (ed.modes.source) return [];
            const ranges = ed.markers.filter(([, , r0, r1]) => r1 < l0 || r0 > l1).map(([a, b]) => [a, b] as [number, number]);
            return normalize(ranges);
        };
        let seed = 11;
        const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
        const pieces = ['x', '\n', '**b**', '`k`', '```\n', '# ', '> ', '🎉', '*m*', '\n\n', '![g](a.png)', '~~c~~'];
        const check = (what: string) => eq(JSON.stringify(tagRanges(buf, ed.tags.hidden)), JSON.stringify(expected()), what);
        // Pembatas ``` baru mengubah marker baris di bawahnya tanpa menyunting baris itu.
        setText('awal\n\n**satu** dan *dua*\n\n# Judul\nakhir');
        cursorTo(0);
        check('sebelum pembatas');
        buf.insert(buf.get_iter_at_line(1), '```\n', -1); pump();
        check('setelah pembatas dibuka');
        cursorTo(6);
        check('kursor pindah setelah pembatas');
        buf.undo(); pump();
        check('setelah pembatas dibatalkan');
        setText(readTextFile(samplePath));
        try {
            for (let round = 0; round < 60; round++) {
                const n = buf.get_char_count();
                const at = buf.get_iter_at_offset(rand(n + 1));
                if (rand(4) === 0 && n > 0) {
                    const end = at.copy();
                    end.forward_chars(1 + rand(40));
                    buf.delete(at, end);
                } else if (rand(5) > 0) {
                    buf.insert(at, pieces[rand(pieces.length)], -1);
                }
                const count = buf.get_char_count();
                if (rand(4) === 0) buf.select_range(buf.get_iter_at_offset(rand(count + 1)), buf.get_iter_at_offset(rand(count + 1)));
                else buf.place_cursor(buf.get_iter_at_offset(rand(count + 1)));
                if (rand(15) === 0) ed.setMode('source', !ed.modes.source);
                if (rand(10) === 0) buf.undo();
                pump();
                check(`marker tersembunyi pada langkah ${round + 1}`);
            }
        } finally {
            ed.setMode('source', false);
            pump();
        }
    });
    // Penyorotan bertahap (MarkdownView.queueFill): dokumen panjang diberi tag sebagian dulu,
    // sisanya dicicil. Hasil akhirnya harus sama persis dengan penyorotan penuh.
    test('penyorotan bertahap dokumen panjang sama dengan penyorotan penuh', () => {
        const long = Array.from({ length: 300 }, (_, i) =>
            `## Bagian ${i}\n\nParagraf **tebal** dan *miring* ke-${i} 🎉 dengan \`kode\`.\n\n`).join('');
        ed.setText(long);
        const lastLine = buf.get_line_count() - 3;
        const boldAt = (line: number) => {
            const it = buf.get_iter_at_line(line);
            it.forward_chars(12);
            return it.has_tag(ed.tags.bold);
        };
        ok(boldAt(2), 'awal dokumen langsung diberi tag');
        ok(!ed.highlightComplete && !boldAt(lastLine), 'akhir dokumen seharusnya masih dicicil');
        eq(w.outline.list.get_children().length < 300, true, 'outline seharusnya dibangun bertahap');
        // Menyunting selagi cicilan berjalan, termasuk menambah baris.
        buf.insert(buf.get_iter_at_line(6), '**baru**\n\n', -1);
        for (let i = 0; i < 1000 && !ed.highlightComplete; i++) pump();
        ok(ed.highlightComplete, 'penyorotan bertahap tidak selesai');
        ok(boldAt(lastLine + 2), 'akhir dokumen diberi tag setelah cicilan');
        eq(w.outline.list.get_children().length, 300, 'jumlah baris outline');

        const reference = new Gtk.TextBuffer();
        const tags = createTags(reference);
        reference.set_text(text(), -1);
        highlight(reference, tags, new LineTagger(reference, SYNTAX_TAGS.map(n => tags[n])));
        for (const name of SYNTAX_TAGS)
            eq(JSON.stringify(tagRanges(buf, ed.tags[name])), JSON.stringify(tagRanges(reference, tags[name])), `tag ${name}`);
        const line = buf.get_iter_at_mark(buf.get_insert()).get_line();
        const hidden = normalize(ed.markers.filter(([, , r0, r1]) => r1 < line || r0 > line).map(([a, b]) => [a, b] as [number, number]));
        eq(JSON.stringify(tagRanges(buf, ed.tags.hidden)), JSON.stringify(hidden), 'marker tersembunyi');
        setText('');
    });
    test('penyorotan bertahap mendahulukan baris di sekitar kursor', () => {
        const long = Array.from({ length: 3000 }, (_, i) => `Paragraf **tebal** ke-${i}.\n\n`).join('');
        ed.setText(long);
        const lastLine = buf.get_line_count() - 3;
        buf.place_cursor(buf.get_iter_at_line(lastLine));
        ed.view.scroll_to_mark(buf.get_insert(), 0, false, 0, 0);
        const boldAt = (line: number) => {
            const it = buf.get_iter_at_line(line);
            it.forward_chars(12);
            return it.has_tag(ed.tags.bold);
        };
        const ctx = GLib.MainContext.default();
        for (let i = 0; i < 2000 && !boldAt(lastLine) && !ed.highlightComplete; i++) ctx.iteration(false);
        ok(boldAt(lastLine), 'baris kursor di akhir dokumen tidak diberi tag');
        ok(!ed.highlightComplete && !boldAt(3000), 'tengah dokumen seharusnya masih dicicil');
        for (let i = 0; i < 5000 && !ed.highlightComplete; i++) pump();
        ok(ed.highlightComplete && boldAt(3000), 'cicilan tidak selesai');
        setText('');
    });
    test('cache baris sama dengan parser baru setelah konteks blok dan Unicode berubah', () => {
        const reference = new Gtk.TextBuffer();
        const tags = createTags(reference);
        const check = () => {
            reference.set_text(text(), -1);
            const fresh = highlight(reference, tags, new LineTagger(reference, SYNTAX_TAGS.map(n => tags[n])));
            eq(ed.markers, fresh.markers, 'marker cache');
            eq(ed.headings, fresh.headings, 'heading cache');
            eq(ed.tables, fresh.tables, 'tabel cache');
            eq(ed.starts, fresh.starts, 'offset Unicode cache');
            for (const name of SYNTAX_TAGS)
                eq(tagRanges(buf, ed.tags[name]), tagRanges(reference, tags[name]), `tag cache ${name}`);
        };
        setText('😀 awal\n# Judul\n**tebal**\n\nA | B\n-- | --\nsatu | dua\n\n```js\nconst x = 1;\n```\nakhir');
        check();
        const insert = (line: number, value: string) => {
            buf.insert(buf.get_iter_at_line(line), value, -1); pump(); check();
        };
        insert(0, '🎉\n');
        insert(3, '```\n');  // format inline/tabel berubah menjadi isi blok kode
        insert(7, '```\n');  // tabel muncul lagi setelah penutup
        insert(0, 'paragraf baru\n');
        buf.undo(); pump(); check();
        buf.redo(); pump(); check();
        const end = buf.get_iter_at_line(5);
        buf.delete(buf.get_iter_at_line(0), end); pump(); check();
        setText('**tebal**'); check();  // newline terakhir memengaruhi rentang tag
        buf.insert_at_cursor('\n', -1); pump(); check();
    });
    test('setText menyelesaikan satu penyorotan tanpa callback ganda', () => {
        let calls = 0;
        const original = ed.onHighlighted;
        ed.onHighlighted = result => { calls++; original(result); };
        try {
            setText('# Baru\n\ncatatan');
            eq(calls, 1, 'jumlah callback setelah setText');
            buf.insert_at_cursor('x', -1); pump();
            eq(calls, 2, 'suntingan berikutnya tetap disorot');
        } finally { ed.onHighlighted = original; }
    });
    test('mengedit satu heading mempertahankan baris outline lainnya', () => {
        setText('# Satu\n\n## Dua\n\n# Tiga');
        const first = w.outline.list.get_row_at_index(0)!;
        const last = w.outline.list.get_row_at_index(2)!;
        cursorTo(2, -1);
        buf.insert_at_cursor(' baru', -1); pump();
        ok(w.outline.list.get_row_at_index(0) === first, 'heading pertama dibangun ulang');
        ok(w.outline.list.get_row_at_index(2) === last, 'heading terakhir dibangun ulang');
        cursorTo(2);
        buf.insert_at_cursor('x', -1); pump();  // heading kedua menjadi paragraf
        eq(w.outline.list.get_children().length, 2, 'satu heading dihapus');
        ok(w.outline.list.get_row_at_index(1) === last, 'akhiran tidak dipertahankan');
        w.outline.list.emit('row-activated', last); pump();
        eq(buf.get_iter_at_mark(buf.get_insert()).get_line(), 4, 'tujuan klik setelah heading dihapus');
        buf.undo(); pump();
        eq(w.outline.list.get_children().length, 3, 'undo mengembalikan heading');
    });
    test('outline memakai ulang label saat heading hanya bergeser baris', () => {
        setText('awal\n\n# Judul');
        const row = w.outline.list.get_row_at_index(0)!;
        buf.insert(buf.get_start_iter(), 'baris baru\n', -1); pump();
        ok(w.outline.list.get_children()[0] === row, 'baris outline tidak dipakai ulang');
        w.outline.list.emit('row-activated', row);
        pump();
        eq(buf.get_iter_at_mark(buf.get_insert()).get_line(), 3, 'tujuan klik heading bergeser');
    });
    test('mode fokus dan typewriter aktif bersamaan', () => {
        setText(WELCOME);
        action('focus'); action('typewriter');
        for (let i = 0; i < buf.get_line_count(); i++) cursorTo(i);
        action('focus'); action('typewriter');
    });

    if (opt('mouse')) {
        section('Klik mouse sungguhan (XTest)');
        const tw = ed.view.get_window(Gtk.TextWindowType.TEXT)!;
        const xtest = (window: Gdk.Window, x: number, y: number) => {
            Gdk.test_simulate_button(window, x, y, 1, 0 as Gdk.ModifierType, Gdk.EventType.BUTTON_PRESS);
            Gdk.test_simulate_button(window, x, y, 1, 0 as Gdk.ModifierType, Gdk.EventType.BUTTON_RELEASE);
            for (let k = 0; k < 8; k++) { pump(); GLib.usleep(15000); }
        };

        // Pemeriksaan awal: di sebagian lingkungan (diuji di sini: XFCE/X11) gerak pointer XTest
        // sampai, tetapi tombol mouse tidak pernah diterima GTK. Tes klik di bawah ini tidak ada
        // artinya jika klik tidak sampai, jadi dilewati dengan keterangan, bukan lulus palsu.
        setText('baris satu\n\nbaris dua'); cursorTo(0);
        w.win.present_with_time(Gdk.CURRENT_TIME);
        for (let k = 0; k < 20; k++) { pump(); GLib.usleep(15000); }
        let delivered = 0;
        const probe = ed.view.connect('button-press-event', () => { delivered++; return false; });
        xtest(tw, 200, 140);
        ed.view.disconnect(probe);

        if (!delivered) {
            print(`  ${DIM}- dilewati: XTest tidak mengirim tombol mouse ke jendela di lingkungan ini${RESET}`);
        } else {
            test('klik ganda pada gambar di editor membuka penampil', () => {
                w.file = GLib.build_filenamev([tmp, 'dok.md']);
                setText('teks\n\n![uji](gambar/uji.png)\n\nakhir'); waitImages(); cursorTo(0);
                for (let i = 0; i < 30; i++) { pump(); GLib.usleep(10000); }
                let opened = false;
                const keep = ed.onViewImage;
                ed.onViewImage = () => { opened = true; };
                // Titik 60 px di bawah tepi atas gambar (tingginya 100): tetap di dalam gambar walau klik
                // pertama menggesernya ke bawah karena sintaks gambar muncul. Posisinya diambil dari
                // widget gambarnya, bukan dari rumus, supaya tidak bergantung pada margin editor.
                const widgetWindow = ed.view.get_window(Gtk.TextWindowType.WIDGET)!;
                const picture = ed.images.blocks[0].content.get_children()[0];
                const [, px, py] = picture.translate_coordinates(ed.view, 40, 60);
                xtest(widgetWindow, px, py);
                xtest(widgetWindow, px, py);
                ed.onViewImage = keep;
                w.file = null;
                ok(opened, 'klik ganda dengan mouse tidak membuka penampil');
            });
            test('klik di seluruh area teks tidak membuat editor error', () => {
                setText(WELCOME);
                for (let y = 20; y < tw.get_height(); y += 23)
                    for (const x of [20, 250, 600]) xtest(tw, x, y);
            });
        }
    }
}
