// Tes GUI: Enter dan Tab di daftar.

import Gdk from 'gi://Gdk?version=4.0';
import { section, test, eq, ok } from '../framework.js';
import type { GuiContext } from './context.js';

export function listTests(c: GuiContext): void {
    const { ed, text, setText, cursorTo, key } = c;

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
        ok(!ed.onKey(Gdk.KEY_Return, 0), 'Enter ditangani sebagai daftar');
    });
    test('Tab dan Shift+Tab mengatur indentasi', () => {
        setText('- a'); cursorTo(0, -1);
        key(Gdk.KEY_Tab); eq(text(), '    - a', 'setelah Tab');
        key(Gdk.KEY_ISO_Left_Tab, Gdk.ModifierType.SHIFT_MASK); eq(text(), '- a', 'setelah Shift+Tab');
    });
}

export function listIndentTests(c: GuiContext): void {
    const { buf, setText } = c;
    const indentAt = (offset: number) => buf.get_iter_at_offset(offset).get_tags().find(t => t.name?.startsWith('list-indent-'))?.indent ?? 0;

    section('Indentasi menggantung daftar');
    test('baris lanjutan item daftar menjorok sedalam awalannya', () => {
        setText('- satu\n10. dua\n- [ ] tiga\n\nbiasa');
        const bullet = indentAt(0), num = indentAt(7), task = indentAt(15);
        ok(bullet < 0, 'indent daftar harus negatif');
        ok(num < bullet, '"10. " lebih lebar dari "- "');
        ok(task < bullet, '"- [ ] " lebih lebar dari "- "');
        eq(indentAt(buf.get_char_count() - 2), 0);
    });
    test('mengubah item menjadi paragraf biasa menghapus indentasi', () => {
        setText('- satu\nb');
        buf.delete(buf.get_iter_at_offset(0), buf.get_iter_at_offset(2));
        c.ed.highlight();
        eq(indentAt(0), 0);
    });
}
