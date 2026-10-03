// Tes GUI: Perintah format.

import { section, test, eq, ok } from '../framework.js';
import type { GuiContext } from './context.js';

export function formatTests(c: GuiContext): void {
    const { buf, pump, text, setText, cursorTo, action, clickAt } = c;

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
}
