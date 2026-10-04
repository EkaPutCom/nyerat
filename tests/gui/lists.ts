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
