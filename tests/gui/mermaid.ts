// Tes GUI: Diagram Mermaid (blok ```mermaid dirender lewat WebKit, lihat editor/mermaid.ts).

import { section, test, eq, ok } from '../framework.js';
import type { GuiContext } from './context.js';
import { mermaidRenderer } from '../../src/editor/mermaidrender.js';

export function mermaidTests(c: GuiContext): void {
    const { ed, buf, pump, text, setText, cursorTo, action, diagrams, waitMermaid } = c;

    section('Diagram Mermaid');
    if (!mermaidRenderer().available) {
        test('mermaid.min.js tersedia (jalankan npm run build)', () => ok(false, 'dist/mermaid.min.js tidak ditemukan'));
        return;
    }

    const GRAPH = '```mermaid\ngraph TD\n    A[Mulai] --> B[Selesai]\n```';
    const hiddenAt = (line: number) => buf.get_iter_at_line(line).has_tag(ed.tags.mermaidhide);
    const hasGap = (line: number) => buf.get_iter_at_line(line).get_tags().some(t => t.name?.startsWith('mermaid-gap-'));
    const pixel = (b: ReturnType<typeof diagrams>[number], x: number, y: number) => {
        const pb = b.pixbuf!;
        const i = y * pb.get_rowstride() + x * pb.get_n_channels();
        const px = pb.get_pixels();
        return [px[i], px[i + 1], px[i + 2]];
    };

    test('blok mermaid dirender menjadi diagram', () => {
        setText(`judul\n\n${GRAPH}\n\nakhir`);
        cursorTo(0);
        waitMermaid();
        eq(diagrams().length, 1, 'jumlah diagram');
        const b = diagrams()[0];
        eq(b.status, 'ok', `status (${b.error})`);
        ok(b.pixbuf!.get_width() > 40 && b.pixbuf!.get_height() > 40, 'gambar terlalu kecil');
        eq([b.start, b.end], [2, 5], 'baris blok');
        ok(b.widget.get_visible(), 'widget tidak terlihat');
    });
    test('isi dokumen tidak berubah karena diagram', () => eq(text(), `judul\n\n${GRAPH}\n\nakhir`));
    test('kursor di luar blok: kode disembunyikan, ruang untuk diagram disediakan', () => {
        cursorTo(0);
        for (let l = 2; l <= 5; l++) ok(hiddenAt(l), `baris ${l} tidak disembunyikan`);
        ok(hasGap(5), 'ruang di bawah blok tidak disediakan');
        const b = diagrams()[0];
        const [lineY] = ed.view.get_line_yrange(buf.get_iter_at_line(5));
        // Baris-barisnya ~1 px, jadi diagram mulai tepat di bawah baris penutup (setelah jarak GAP = 12).
        ok(b.collapsed && b.y > lineY && b.y <= lineY + 20, `diagram (y=${b.y}) tidak menggantikan kodenya (y=${lineY})`);
    });
    test('kursor di dalam blok: kode tampil dan diagram menjadi pratinjau di bawahnya', () => {
        cursorTo(3);
        for (let l = 2; l <= 5; l++) ok(!hiddenAt(l), `baris ${l} masih disembunyikan`);
        const b = diagrams()[0];
        pump();
        const [lineY] = ed.view.get_line_yrange(buf.get_iter_at_line(5));
        ok(!b.collapsed && b.widget.get_visible(), 'diagram hilang saat blok disunting');
        ok(b.y > lineY, `diagram (y=${b.y}) tidak di bawah baris penutup (y=${lineY})`);
    });
    test('latar gambar sama dengan latar editor', () => {
        const b = diagrams()[0];
        eq(pixel(b, 0, 0), [255, 255, 255], 'piksel pojok (terang)');
    });
    test('mengubah kode merender ulang diagramnya', () => {
        cursorTo(3);
        const before = diagrams()[0].pixbuf!;
        const it = buf.get_iter_at_line(4);
        it.forward_to_line_end();
        buf.insert(it, '\n    B --> C[Tambahan]\n    C --> D[Lagi]', -1);
        pump();
        waitMermaid();
        const b = diagrams()[0];
        eq(b.status, 'ok', `status (${b.error})`);
        ok(b.pixbuf !== before && b.pixbuf!.get_height() > before.get_height(), 'gambar tidak berubah menjadi lebih tinggi');
    });
    test('kode yang salah menampilkan galat dan tidak disembunyikan', () => {
        setText('```mermaid\ngraph TD\n    A --> [\n```\n\nteks');
        cursorTo(5);
        waitMermaid();
        const b = diagrams()[0];
        eq(b.status, 'error', 'status');
        ok(!!b.error, 'pesan galat kosong');
        for (let l = 0; l <= 3; l++) ok(!hiddenAt(l), `baris ${l} disembunyikan padahal galat`);
    });
    test('memperbaiki kode yang salah memulihkan diagram', () => {
        const it = buf.get_iter_at_line(2);
        const end = it.copy();
        end.forward_to_line_end();
        buf.delete(it, end);
        buf.insert(it, '    A --> B', -1);
        pump();
        waitMermaid();
        eq(diagrams()[0].status, 'ok', `status (${diagrams()[0].error})`);
    });
    test('beberapa diagram dalam satu dokumen', () => {
        setText(`${GRAPH}\n\ntengah\n\n\`\`\`mermaid\npie title Isi\n    "A" : 3\n    "B" : 5\n\`\`\``);
        cursorTo(2);
        waitMermaid();
        eq(diagrams().map(b => b.status), ['ok', 'ok'], 'status');
        ok(diagrams()[0].y < diagrams()[1].y, 'urutan diagram salah');
    });
    test('diagram dipakai ulang saat barisnya bergeser', () => {
        const before = diagrams()[0];
        buf.insert(buf.get_start_iter(), 'baris baru\n', -1);
        pump();
        waitMermaid();
        ok(diagrams()[0] === before, 'widget dibuat ulang');
        eq(diagrams()[0].start, 1, 'baris awal');
    });
    test('blok non-mermaid, kosong, atau tidak ditutup diabaikan', () => {
        setText('```js\nlet a;\n```\n\n```mermaid\n\n```\n\n```mermaid\ngraph TD\n  A-->B');
        waitMermaid();
        eq(diagrams().length, 0, 'jumlah diagram');
    });
    test('mode source menampilkan kode apa adanya', () => {
        setText(`${GRAPH}\n\nakhir`);
        cursorTo(6);
        waitMermaid();
        ok(hiddenAt(1), 'kode seharusnya tersembunyi');
        action('source');
        ok(!hiddenAt(1) && !hasGap(3) && !diagrams()[0].widget.get_visible(), 'mode source masih menampilkan diagram');
        action('source');
        ok(hiddenAt(1) && hasGap(3) && diagrams()[0].widget.get_visible(), 'diagram tidak muncul lagi');
    });
    test('mode gelap merender ulang dengan latar gelap', () => {
        cursorTo(6);
        action('dark');
        waitMermaid();
        const b = diagrams()[0];
        eq(b.status, 'ok', `status (${b.error})`);
        eq(pixel(b, 0, 0), [0x1f, 0x20, 0x23], 'piksel pojok (gelap)');
        action('dark');
        waitMermaid();
        eq(pixel(diagrams()[0], 0, 0), [255, 255, 255], 'piksel pojok (terang lagi)');
    });
    test('menghapus blok menghapus widgetnya', () => {
        setText('teks saja');
        eq(diagrams().length, 0, 'jumlah diagram');
        ok(!hasGap(0), 'ruang kosong tertinggal');
    });
    buf.set_modified(false);
}
