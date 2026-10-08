// GUI tests: Mermaid diagrams (```mermaid blocks are rendered through WebKit, see editor/mermaid.ts).

import { section, test, eq, ok } from '../framework.js';
import type { GuiContext } from './context.js';
import { mermaidRenderer } from '../../src/editor/mermaidrender.js';
import { iterAtLine } from '../../src/gtkutil.js';

export function mermaidTests(c: GuiContext): void {
    const { ed, buf, pump, text, setText, cursorTo, action, diagrams, waitMermaid } = c;

    section('Mermaid diagrams');
    if (!mermaidRenderer().available) {
        test('mermaid.min.js is available (run npm run build)', () => ok(false, 'dist/mermaid.min.js not found'));
        return;
    }

    const GRAPH = '```mermaid\ngraph TD\n    A[Start] --> B[Finish]\n```';
    const hiddenAt = (line: number) => iterAtLine(buf, line).has_tag(ed.tags.mermaidhide);
    const hasGap = (line: number) => iterAtLine(buf, line).get_tags().some(t => t.name?.startsWith('mermaid-gap-'));
    const pixel = (b: ReturnType<typeof diagrams>[number], x: number, y: number) => {
        const pb = b.pixbuf!;
        const i = y * pb.get_rowstride() + x * pb.get_n_channels();
        const px = pb.get_pixels();
        return [px[i], px[i + 1], px[i + 2]];
    };

    test('a mermaid block is rendered as a diagram', () => {
        setText(`title\n\n${GRAPH}\n\nend`);
        cursorTo(0);
        waitMermaid();
        eq(diagrams().length, 1, 'number of diagrams');
        const b = diagrams()[0];
        eq(b.status, 'ok', `status (${b.error})`);
        ok(b.pixbuf!.get_width() > 40 && b.pixbuf!.get_height() > 40, 'the image is too small');
        eq([b.start, b.end], [2, 5], 'baris blok');
        ok(b.widget.get_visible(), 'the widget is not visible');
    });
    test('the document contents do not change because of the diagram', () => eq(text(), `title\n\n${GRAPH}\n\nend`));
    test('cursor outside the block: the code is hidden, space for the diagram is reserved', () => {
        cursorTo(0);
        for (let l = 2; l <= 5; l++) ok(hiddenAt(l), `line ${l} is not hidden`);
        ok(hasGap(5), 'no space was reserved below the block');
        const b = diagrams()[0];
        const [lineY] = ed.view.get_line_yrange(iterAtLine(buf, 5));
        // Its lines are ~1 px, so the diagram starts right below the closing line (after the GAP distance = 12).
        ok(b.collapsed && b.y > lineY && b.y <= lineY + 20, `the diagram (y=${b.y}) does not replace its code (y=${lineY})`);
    });
    test('cursor inside the block: the code is shown and the diagram becomes a preview below it', () => {
        cursorTo(3);
        for (let l = 2; l <= 5; l++) ok(!hiddenAt(l), `line ${l} is still hidden`);
        const b = diagrams()[0];
        pump();
        const [lineY] = ed.view.get_line_yrange(iterAtLine(buf, 5));
        ok(!b.collapsed && b.widget.get_visible(), 'the diagram vanished when the block was edited');
        ok(b.y > lineY, `the diagram (y=${b.y}) is not below the closing line (y=${lineY})`);
    });
    test('the image background is the same as the editor background', () => {
        const b = diagrams()[0];
        eq(pixel(b, 0, 0), [255, 255, 255], 'corner pixel (light)');
    });
    test('changing the code re-renders its diagram', () => {
        cursorTo(3);
        const before = diagrams()[0].pixbuf!;
        const it = iterAtLine(buf, 4);
        it.forward_to_line_end();
        buf.insert(it, '\n    B --> C[Extra]\n    C --> D[More]', -1);
        pump();
        waitMermaid();
        const b = diagrams()[0];
        eq(b.status, 'ok', `status (${b.error})`);
        ok(b.pixbuf !== before && b.pixbuf!.get_height() > before.get_height(), 'the image did not become taller');
    });
    test('invalid code shows an error and is not hidden', () => {
        setText('```mermaid\ngraph TD\n    A --> [\n```\n\ntext');
        cursorTo(5);
        waitMermaid();
        const b = diagrams()[0];
        eq(b.status, 'error', 'status');
        ok(!!b.error, 'the error message is empty');
        for (let l = 0; l <= 3; l++) ok(!hiddenAt(l), `line ${l} is hidden despite the error`);
    });
    test('fixing the invalid code restores the diagram', () => {
        const it = iterAtLine(buf, 2);
        const end = it.copy();
        end.forward_to_line_end();
        buf.delete(it, end);
        buf.insert(it, '    A --> B', -1);
        pump();
        waitMermaid();
        eq(diagrams()[0].status, 'ok', `status (${diagrams()[0].error})`);
    });
    test('several diagrams in one document', () => {
        setText(`${GRAPH}\n\nmiddle\n\n\`\`\`mermaid\npie title Contents\n    "A" : 3\n    "B" : 5\n\`\`\``);
        cursorTo(2);
        waitMermaid();
        eq(diagrams().map(b => b.status), ['ok', 'ok'], 'status');
        ok(diagrams()[0].y < diagrams()[1].y, 'the diagram order is wrong');
    });
    test('the diagram is reused when its lines shift', () => {
        const before = diagrams()[0];
        buf.insert(buf.get_start_iter(), 'new line\n', -1);
        pump();
        waitMermaid();
        ok(diagrams()[0] === before, 'the widget was recreated');
        eq(diagrams()[0].start, 1, 'start line');
    });
    test('non-mermaid, empty, or unclosed blocks are ignored', () => {
        setText('```js\nlet a;\n```\n\n```mermaid\n\n```\n\n```mermaid\ngraph TD\n  A-->B');
        waitMermaid();
        eq(diagrams().length, 0, 'number of diagrams');
    });
    test('source mode shows the code as is', () => {
        setText(`${GRAPH}\n\nend`);
        cursorTo(6);
        waitMermaid();
        ok(hiddenAt(1), 'the code should be hidden');
        action('source');
        ok(!hiddenAt(1) && !hasGap(3) && !diagrams()[0].widget.get_visible(), 'source mode still shows the diagram');
        action('source');
        ok(hiddenAt(1) && hasGap(3) && diagrams()[0].widget.get_visible(), 'the diagram did not appear again');
    });
    test('dark mode re-renders with a dark background', () => {
        cursorTo(6);
        action('dark');
        waitMermaid();
        const b = diagrams()[0];
        eq(b.status, 'ok', `status (${b.error})`);
        eq(pixel(b, 0, 0), [0x1e, 0x1e, 0x1e], 'corner pixel (dark)');
        action('dark');
        waitMermaid();
        eq(pixel(diagrams()[0], 0, 0), [255, 255, 255], 'corner pixel (light again)');
    });
    test('deleting the block deletes its widget', () => {
        setText('teks saja');
        eq(diagrams().length, 0, 'number of diagrams');
        ok(!hasGap(0), 'empty space was left behind');
    });

    section('DBML diagrams');
    const DBML = '```dbml\nTable users {\n  id int [pk]\n}\nTable posts {\n  id int [pk]\n  user_id int [ref: > users.id]\n}\n```';
    test('a dbml block is rendered as a diagram', () => {
        setText(`${DBML}\n\nend`);
        cursorTo(11);
        waitMermaid();
        eq(diagrams().length, 1, 'number of diagrams');
        const b = diagrams()[0];
        eq([b.kind, b.status], ['dbml', 'ok'], `kind and status (${b.error})`);
        ok(b.pixbuf!.get_width() > 40, 'the image is too small');
        ok(hiddenAt(1), 'the code should be hidden while the cursor is outside the block');
    });
    test('a DBML error is shown immediately and its code is not hidden', () => {
        setText('```dbml\nTable a {\n  id int\n```\n\ntext');
        cursorTo(5);
        const b = diagrams()[0];
        eq(b.status, 'error', 'status');
        ok((b.error ?? '').includes('line'), 'the error message has no line number');
        for (let l = 0; l <= 3; l++) ok(!hiddenAt(l), `line ${l} is hidden despite the error`);
    });
    test('fixed dbml is rendered; an empty dbml block is ignored', () => {
        setText('```dbml\nTable a { id int }\n```\n\n```dbml\n\n```');
        cursorTo(4);
        waitMermaid();
        eq(diagrams().map(b => b.status), ['ok'], 'status');
    });
    buf.set_modified(false);
}
