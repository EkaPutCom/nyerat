// Tes GUI: blok kode sebagai kotak yang bisa digulir ke samping (lihat editor/codelayer.ts).

import GLib from 'gi://GLib';
import { section, test, eq, ok } from '../framework.js';
import type { GuiContext } from './context.js';
import { iterAtLine } from '../../src/gtkutil.js';

export function codeBlockTests(c: GuiContext): void {
    const { ed, buf, pump, text, setText, cursorTo } = c;

    section('Blok kode (kotak yang bisa digulir)');
    //  0 atas | 1 (kosong) | 2 pembuka | 3-4 isi | 5 penutup | 6 (kosong) | 7 bawah
    const LONG = 'x'.repeat(300);
    const DOC = `atas\n\n\`\`\`js\nconst a = 1;\nconst b = '${LONG}';\n\`\`\`\n\nbawah`;
    const settle = () => { for (let i = 0; i < 30; i++) { pump(); GLib.usleep(10000); } };
    const hidden = (line: number) => iterAtLine(buf, line).has_tag(ed.tags.codehide);
    const block = () => ed.codeLayer.blocks[0];

    test('kursor di luar blok: tampil sebagai kotak, barisnya dikecilkan', () => {
        setText(DOC); cursorTo(0); settle();
        const b = block();
        ok(b.collapsed && b.widget && b.widget.get_visible(), 'kotak tidak tampil');
        ok([2, 3, 4, 5].every(hidden), 'baris blok tidak dikecilkan');
        ok(!hidden(1) && !hidden(6), 'teks di luar blok ikut dikecilkan');
        eq(text(), DOC, 'isi dokumen berubah');
    });
    test('baris panjang tidak melebarkan dokumen', () => {
        const [prevY, prevH] = ed.view.get_line_yrange(iterAtLine(buf, 1));
        const [nextY] = ed.view.get_line_yrange(iterAtLine(buf, 6));
        const b = block();
        ok(b.y >= prevY + prevH, `kotak (y=${b.y}) menimpa teks di atasnya`);
        ok(b.y + b.height <= nextY, `kotak (bawah=${b.y + b.height}) menimpa teks di bawahnya (atas=${nextY})`);
        ok(b.widget!.get_width() <= ed.codeLayer.maxWidth, 'kotak lebih lebar dari kolom teks');
        ok(ed.view.get_allocated_width() < 2000, 'tampilan ikut melebar');
    });
    test('kursor masuk ke blok: teks mentah tampil', () => {
        cursorTo(3); settle();
        ok(!block().collapsed && !block().widget?.get_visible(), 'kotak masih tampil');
        ok(![2, 3, 4, 5].some(hidden), 'baris blok masih dikecilkan');
    });
    test('klik kotak membuka blok', () => {
        cursorTo(0); settle();
        ed.codeLayer.onActivate(3);
        cursorTo(3); settle();
        ok(!block().collapsed, 'blok tidak terbuka');
    });
    // setCursor() dan pergeseran baris hanya menyentuh tag blok yang berubah; hasilnya harus
    // sama dengan sinkron penuh.
    test('kursor keluar-masuk dan baris bergeser: tag tetap tepat di baris blok', () => {
        //  0 atas | 2-4 blok A | 6-8 blok B | 10 bawah
        const TWO = 'atas\n\n```js\nconst a = 1;\n```\n\n```py\nb = 2\n```\n\nbawah';
        const exactly = (lines: number[]) => {
            const count = buf.get_line_count();
            for (let l = 0; l < count; l++) eq(hidden(l), lines.includes(l), `tag codehide baris ${l}`);
        };
        setText(TWO); cursorTo(0); settle();
        exactly([2, 3, 4, 6, 7, 8]);
        cursorTo(7); settle();
        exactly([2, 3, 4]);
        cursorTo(3); settle();
        exactly([6, 7, 8]);
        cursorTo(0); settle();
        exactly([2, 3, 4, 6, 7, 8]);
        const [, b] = ed.codeLayer.blocks;
        const before = b.y;
        buf.insert(iterAtLine(buf, 1), 'baru\nbaru\n', -1);
        cursorTo(0); settle();
        exactly([4, 5, 6, 8, 9, 10]);
        eq([b.start, b.end], [8, 10], 'baris blok B');
        ok(b.y > before, `kotak B tidak ikut turun (${before} → ${b.y})`);
        const [lineY, lineH] = ed.view.get_line_yrange(iterAtLine(buf, 10));
        ok(b.y + b.height <= lineY + lineH, 'kotak B tidak di bawah baris terakhirnya');
        eq(text().split('\n').length, 13, 'jumlah baris');
    });
    test('blok diagram dan blok yang belum ditutup tidak jadi kotak', () => {
        setText('```mermaid\ngraph TD\n A-->B\n```\n\n```js\nbelum ditutup'); cursorTo(5); settle();
        eq(ed.codeLayer.blocks.length, 0);
    });
}
