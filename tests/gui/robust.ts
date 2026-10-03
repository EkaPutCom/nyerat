// Tes GUI: Ketahanan (mencari crash).

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=3.0';
import Gdk from 'gi://Gdk?version=3.0';
import { WELCOME } from '../../src/welcome.js';
import { readTextFile } from '../../src/files.js';
import { tagRanges } from '../../src/editor/tagsync.js';
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
