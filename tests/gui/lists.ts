// GUI tests: Enter and Tab in lists.

import Gdk from 'gi://Gdk?version=4.0';
import { section, test, eq, ok } from '../framework.js';
import type { GuiContext } from './context.js';

export function listTests(c: GuiContext): void {
    const { ed, text, setText, cursorTo, key } = c;

    section('Enter and Tab in lists');
    test('Enter continues a plain list', () => {
        setText('- one'); cursorTo(0, -1); key(Gdk.KEY_Return);
        eq(text(), '- one\n- ');
    });
    test('Enter on an empty item ends the list', () => {
        key(Gdk.KEY_Return);
        eq(text(), '- one\n');
    });
    test('Enter increments the list number', () => {
        setText('9. a'); cursorTo(0, -1); key(Gdk.KEY_Return);
        eq(text(), '9. a\n10. ');
    });
    test('Enter in a task list makes an empty checkbox', () => {
        setText('- [x] a'); cursorTo(0, -1); key(Gdk.KEY_Return);
        eq(text(), '- [x] a\n- [ ] ');
    });
    test('Enter continues a quote', () => {
        setText('> a'); cursorTo(0, -1); key(Gdk.KEY_Return);
        eq(text(), '> a\n> ');
    });
    test('Enter inside a code block does not add a bullet', () => {
        setText('```\n- a\n```'); cursorTo(1, -1);
        ok(!ed.onKey(Gdk.KEY_Return, 0), 'Enter was handled as a list');
    });
    test('Tab and Shift+Tab set the indentation', () => {
        setText('- a'); cursorTo(0, -1);
        key(Gdk.KEY_Tab); eq(text(), '    - a', 'setelah Tab');
        key(Gdk.KEY_ISO_Left_Tab, Gdk.ModifierType.SHIFT_MASK); eq(text(), '- a', 'setelah Shift+Tab');
    });
}

export function listIndentTests(c: GuiContext): void {
    const { buf, setText } = c;
    const indentAt = (offset: number) => buf.get_iter_at_offset(offset).get_tags().find(t => t.name?.startsWith('list-indent-'))?.indent ?? 0;

    section('Hanging indentation of lists');
    test('the continuation line of a list item is indented as deep as its prefix', () => {
        setText('- one\n10. two\n- [ ] three\n\nplain');
        const bullet = indentAt(0), num = indentAt(7), task = indentAt(15);
        ok(bullet < 0, 'the list indent must be negative');
        ok(num < bullet, '"10. " is wider than "- "');
        ok(task < bullet, '"- [ ] " is wider than "- "');
        eq(indentAt(buf.get_char_count() - 2), 0);
    });
    test('turning an item into a plain paragraph removes the indentation', () => {
        setText('- one\nb');
        buf.delete(buf.get_iter_at_offset(0), buf.get_iter_at_offset(2));
        c.ed.highlight();
        eq(indentAt(0), 0);
    });
}
