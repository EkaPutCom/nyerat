// GUI tests: Hiding syntax.

import { section, test, eq, ok } from '../framework.js';
import type { GuiContext } from './context.js';

export function syntaxHidingTests(c: GuiContext): void {
    const { w, ed, setText, cursorTo, hidden, tagAt, action } = c;

    section('Hiding syntax');
    test('the heading marker is hidden when the cursor is on another line', () => {
        setText('# Title\n\ntext **bold** here');
        cursorTo(2, -1);
        ok(hidden(0), '"#" should be hidden');
        ok(!hidden(17), '"**" on the active line should be visible');
    });
    test('the marker appears when the cursor moves to its line', () => {
        cursorTo(0);
        ok(!hidden(0), '"#" seharusnya terlihat');
        ok(hidden(14), '"**" on another line should be hidden');
        ok(tagAt(16, 'bold'), 'the bold text was not tagged bold');
    });
    test('the offset is correct after an emoji', () => {
        setText('🎉 **a**\n');
        cursorTo(1);
        ok(hidden(2) && hidden(3), '"**" after an emoji should be hidden');
        ok(!hidden(4) && tagAt(4, 'bold'), 'the letter "a" should be bold and visible');
    });
    test('the code block fence lines are hidden outside the block', () => {
        setText('a\n```js\ncode\n```\nb');
        cursorTo(0);
        ok(hidden(2) && hidden(13), 'the ``` fence should be hidden');
        ok(tagAt(9, 'codeblock') && !hidden(9), 'the code contents should be visible');
    });
    test('the fence lines appear when the cursor is inside the block', () => {
        cursorTo(2);
        ok(!hidden(2) && !hidden(13), 'the ``` fence should be visible');
    });
    test('source mode shows all markers', () => {
        setText('# a\n\n**b**');
        cursorTo(2);
        ok(hidden(0), 'start: "#" hidden');
        action('source');
        ok(!hidden(0), 'mode source: "#" seharusnya terlihat');
        action('source');
        ok(hidden(0), 'after source mode is turned off: "#" hidden again');
    });
    test('outline berisi heading', () => {
        setText('# One\n## Two\ntext\n### Three');
        eq(ed.headings.map(h => [h.level, h.text, h.line]), [[1, 'Satu', 0], [2, 'Dua', 1], [3, 'Tiga', 3]]);
        eq(w.outline.count, 3, 'number of outline rows');
    });
}
