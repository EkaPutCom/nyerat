// GUI tests: Code block colors.

import { section, test, eq, ok } from '../framework.js';
import type { GuiContext } from './context.js';

export function codeColorTests(c: GuiContext): void {
    const { ed, buf, pump, text, setText, cursorTo, offsetIn, tagAt, action } = c;

    section('Code block colors');
    const syntaxTags = (off: number) => buf.get_iter_at_offset(off).get_tags().filter(t => t.name?.startsWith('syntax:'));
    const colorAt = (off: number) => syntaxTags(off).map(t => t.foreground_rgba?.to_string()).find(Boolean) ?? null;
    test('keywords, strings, and comments are colored differently', () => {
        setText('text\n\n```js\nconst s = "hello"; // note\n```\n');
        const at = (needle: string) => offsetIn(text(), needle);
        ok(syntaxTags(at('const')).length > 0, 'the keyword is not colored');
        const str = colorAt(at('"hello"') + 1), comment = colorAt(at('// note') + 3);
        ok(str && comment && str !== comment, `the string color (${str}) and the comment color (${comment}) must differ`);
        ok(syntaxTags(at('text')).length === 0, 'text outside the block was colored too');
    });
    test('the document contents do not change because of coloring', () => {
        eq(text(), 'text\n\n```js\nconst s = "hello"; // note\n```\n');
    });
    test('a block without a language or with an unknown language is not colored', () => {
        setText('```\nconst a = 1;\n```\n\n```madeup\nconst b = 2;\n```');
        ok(syntaxTags(offsetIn(text(), 'const a')).length === 0, 'a block without a language was colored');
        ok(syntaxTags(offsetIn(text(), 'const b')).length === 0, 'a block with an unknown language was colored');
    });
    test('typing inside a block recolors it', () => {
        setText('```python\nx = 1\n```');
        ok(syntaxTags(offsetIn(text(), 'x')).length === 0, 'start: "x" is not styled');
        cursorTo(1);
        buf.insert_at_cursor('def ', -1);
        pump();
        ok(syntaxTags(offsetIn(text(), 'def')).length > 0, '"def" is not colored after being typed');
    });
    test('an emoji before the block does not shift the colors', () => {
        setText('🎉🎉\n```js\nreturn 1;\n```');
        const off = offsetIn(text(), 'return');
        ok(syntaxTags(off).length > 0 && syntaxTags(off + 5).length > 0, '"return" is not colored whole');
        ok(syntaxTags(off - 1).length === 0, 'the color shifted to before "return"');
    });
    test('the color cache stays correct after the block shifts and the document is reloaded', () => {
        const doc = 'start\n\n```js\nconst s = "hello";\n```';
        setText(doc);
        buf.insert(buf.get_start_iter(), '😀 extra\n', -1); pump();
        ok(syntaxTags(offsetIn(text(), 'const')).length > 0, 'the color vanished after the block shifted');
        ok(syntaxTags(0).length === 0, 'the extra text was colored too');
        setText(doc);
        ok(syntaxTags(offsetIn(text(), 'const')).length > 0, 'the color vanished after setText');
        cursorTo(3);
        buf.insert_at_cursor('/*', -1); pump();
        ok(colorAt(offsetIn(text(), 'hello')) !== null, 'the comment color vanished');
        buf.undo(); pump();
        ok(syntaxTags(offsetIn(text(), 'const')).length > 0, 'undo did not restore the color');
    });
    test('dark mode uses another color scheme', () => {
        setText('```js\nconst s = "hello";\n```');
        const off = offsetIn(text(), '"halo"') + 1;
        const light = colorAt(off);
        action('dark');
        const dark = colorAt(off);
        action('dark');
        ok(light && dark && light !== dark, `the light color (${light}) and the dark color (${dark}) are the same`);
        eq(colorAt(off), light, 'back to the light color');
    });
    test('focus mode still dims code blocks in other paragraphs', () => {
        setText('paragraph\n\n```js\nconst s = 1;\n```');
        cursorTo(0);
        action('focus');
        // dim and hidden must be above all the code color tags, so that their color wins.
        const maxSyntax = Math.max(...syntaxTags(offsetIn(text(), 'const')).map(t => t.get_priority()));
        ok(ed.tags.dim.get_priority() > maxSyntax && ed.tags.hidden.get_priority() > maxSyntax,
            `the dim/hidden priority (${ed.tags.dim.get_priority()}/${ed.tags.hidden.get_priority()}) is not above the code colors (${maxSyntax})`);
        ok(tagAt(offsetIn(text(), 'const'), 'dim'), 'the code block was not dimmed');
        action('focus');
    });
}
