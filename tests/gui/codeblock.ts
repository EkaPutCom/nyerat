// GUI tests: a code block as a box that can scroll sideways (see editor/codelayer.ts).

import GLib from 'gi://GLib';
import { section, test, eq, ok } from '../framework.js';
import type { GuiContext } from './context.js';
import { iterAtLine } from '../../src/gtkutil.js';

export function codeBlockTests(c: GuiContext): void {
    const { ed, buf, pump, text, setText, cursorTo } = c;

    section('Code block (scrollable box)');
    //  0 top | 1 (empty) | 2 opening | 3-4 contents | 5 closing | 6 (empty) | 7 bottom
    const LONG = 'x'.repeat(300);
    const DOC = `top\n\n\`\`\`js\nconst a = 1;\nconst b = '${LONG}';\n\`\`\`\n\nbottom`;
    const settle = () => { for (let i = 0; i < 30; i++) { pump(); GLib.usleep(10000); } };
    const hidden = (line: number) => iterAtLine(buf, line).has_tag(ed.tags.codehide);
    const block = () => ed.codeLayer.blocks[0];

    test('cursor outside the block: shown as a box, its lines shrunk', () => {
        setText(DOC); cursorTo(0); settle();
        const b = block();
        ok(b.collapsed && b.widget && b.widget.get_visible(), 'the box is not shown');
        ok([2, 3, 4, 5].every(hidden), 'the block lines were not shrunk');
        ok(!hidden(1) && !hidden(6), 'text outside the block was shrunk too');
        eq(text(), DOC, 'the document contents changed');
    });
    test('a long line does not widen the document', () => {
        const [prevY, prevH] = ed.view.get_line_yrange(iterAtLine(buf, 1));
        const [nextY] = ed.view.get_line_yrange(iterAtLine(buf, 6));
        const b = block();
        ok(b.y >= prevY + prevH, `the box (y=${b.y}) overlaps the text above it`);
        ok(b.y + b.height <= nextY, `the box (bottom=${b.y + b.height}) overlaps the text below it (top=${nextY})`);
        ok(b.widget!.get_width() <= ed.codeLayer.maxWidth, 'the box is wider than the text column');
        ok(ed.view.get_allocated_width() < 2000, 'the view widened too');
    });
    test('cursor enters the block: raw text is shown', () => {
        cursorTo(3); settle();
        ok(!block().collapsed && !block().widget?.get_visible(), 'kotak masih tampil');
        ok(![2, 3, 4, 5].some(hidden), 'the block lines are still shrunk');
    });
    test('clicking the box opens the block', () => {
        cursorTo(0); settle();
        ed.codeLayer.onActivate(3);
        cursorTo(3); settle();
        ok(!block().collapsed, 'the block did not open');
    });
    // setCursor() and line shifts only touch the tags of the changed block; the result must be
    // the same as a full sync.
    test('cursor moving in and out and lines shifting: tags stay exactly on the block lines', () => {
        //  0 atas | 2-4 blok A | 6-8 blok B | 10 bawah
        const TWO = 'top\n\n```js\nconst a = 1;\n```\n\n```py\nb = 2\n```\n\nbottom';
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
        buf.insert(iterAtLine(buf, 1), 'new\nnew\n', -1);
        cursorTo(0); settle();
        exactly([4, 5, 6, 8, 9, 10]);
        eq([b.start, b.end], [8, 10], 'baris blok B');
        ok(b.y > before, `box B did not move down (${before} → ${b.y})`);
        const [lineY, lineH] = ed.view.get_line_yrange(iterAtLine(buf, 10));
        ok(b.y + b.height <= lineY + lineH, 'box B is not below its last line');
        eq(text().split('\n').length, 13, 'number of lines');
    });
    test('diagram blocks and unclosed blocks do not become boxes', () => {
        setText('```mermaid\ngraph TD\n A-->B\n```\n\n```js\nnot closed'); cursorTo(5); settle();
        eq(ed.codeLayer.blocks.length, 0);
    });
}
