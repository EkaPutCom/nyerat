// Tes GUI: Perintah format.

import { section, test, eq, ok } from '../framework.js';
import type { GuiContext } from './context.js';

export function formatTests(c: GuiContext): void {
    const { buf, pump, text, setText, cursorTo, action, clickAt } = c;

    section('Perintah format');
    test('Ctrl+B wraps the selection with **', () => {
        setText('one word');
        buf.select_range(buf.get_iter_at_offset(5), buf.get_iter_at_offset(9)); pump();
        action('bold');
        eq(text(), 'one **word**');
    });
    test('Ctrl+B again removes **', () => { action('bold'); eq(text(), 'one word'); });
    test('undo restores the change', () => {
        setText('x');
        buf.select_range(buf.get_start_iter(), buf.get_end_iter()); pump();
        action('italic');
        eq(text(), '*x*', 'setelah Ctrl+I');
        buf.undo(); pump();
        eq(text(), 'x', 'setelah undo');
    });
    test('Ctrl+2 and Ctrl+0 set the heading', () => {
        setText('title'); cursorTo(0);
        action('heading2'); eq(text(), '## title', 'Ctrl+2');
        action('heading0'); eq(text(), 'title',  'Ctrl+0');
    });
    test('the quote is applied to several lines', () => {
        setText('a\nb');
        buf.select_range(buf.get_start_iter(), buf.get_end_iter()); pump();
        action('quote'); eq(text(), '> a\n> b');
    });
    test('Ctrl+K makes a link from the selection', () => {
        setText('GTK');
        buf.select_range(buf.get_start_iter(), buf.get_end_iter()); pump();
        action('link'); eq(text(), '[GTK]()');
    });
    test('clicking a task checkbox checks and unchecks it', () => {
        setText('- [ ] task\n\nother'); cursorTo(2);
        ok(clickAt(3), 'the click was not handled');
        eq(text(), '- [x] task\n\nother', 'after the first click');
        clickAt(3);
        eq(text(), '- [ ] task\n\nother', 'after the second click');
    });
}
