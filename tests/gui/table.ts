// GUI tests: Tables (grid and editing).

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import { cellIndexAt } from '../../src/markdown/table.js';
import { section, test, eq, ok } from '../framework.js';
import type { GuiContext } from './context.js';
import { iterAtLine } from '../../src/gtkutil.js';
import { emitClick } from '../widgets.js';

export function tableGridTests(c: GuiContext): void {
    const { w, ed, buf, pump, text, setText, cursorTo, key, action } = c;

    section('Tables (grid and editing)');
    //  0 top | 1 (empty) | 2 header | 3 separator | 4 one | 5 two | 6 (empty) | 7 bottom
    const DOC = 'top\n\n| Name | Value |\n| :--- | ---: |\n| one | 1 |\n| two | 2 |\n\nbottom';
    const settleT = () => { for (let i = 0; i < 30; i++) { pump(); GLib.usleep(10000); } };
    const tBlock = () => ed.tableLayer.blocks[0];
    const tableTag = (line: number) => iterAtLine(buf, line).has_tag(ed.tags.tablehide);
    const lineAt = (n: number) => text().split('\n')[n];
    const curLine = () => buf.get_iter_at_mark(buf.get_insert()).get_line();
    const curCol = () => cellIndexAt(lineAt(curLine()), buf.get_iter_at_mark(buf.get_insert()).get_line_offset());
    const tableLines = (from: number, to: number) => text().split('\n').slice(from, to + 1);
    const tableMessage = () => w.lastToast;

    test('a table outside the cursor is rendered as a grid', () => {
        setText(DOC); cursorTo(0); settleT();
        const b = tBlock();
        ok(b.collapsed && b.widget && b.widget.get_visible(), 'the grid is not shown');
        ok([2, 3, 4, 5].every(tableTag), 'the table lines were not shrunk');
        ok(!tableTag(1) && !tableTag(6) && !tableTag(0), 'text outside the table was shrunk too');
    });
    test('the document contents do not change because of the grid', () => eq(text(), DOC));
    test('the grid sits between the paragraphs above and below it', () => {
        const [prevY, prevH] = ed.view.get_line_yrange(iterAtLine(buf, 1));
        const [nextY] = ed.view.get_line_yrange(iterAtLine(buf, 6));
        const b = tBlock();
        ok(b.height > 0, 'tinggi grid 0');
        ok(b.y >= prevY + prevH, `the grid (y=${b.y}) overlaps the paragraph above it (bottom=${prevY + prevH})`);
        ok(b.y + b.height <= nextY, `the grid (bottom=${b.y + b.height}) overlaps the paragraph below it (top=${nextY})`);
    });
    test('cursor enters the table: the raw text is shown, the grid disappears', () => {
        cursorTo(4); settleT();
        const b = tBlock();
        ok(!b.collapsed && !b.widget?.get_visible(), 'grid masih tampil');
        ok(![2, 3, 4, 5].some(tableTag), 'the table lines are still shrunk');
    });
    test('cursor leaves again: the grid returns', () => {
        cursorTo(7); settleT();
        ok(tBlock().collapsed && tBlock().widget?.get_visible(), 'the grid did not return');
    });
    test('clicking a cell puts the cursor in that cell in the raw text', () => {
        cursorTo(0); settleT();
        ed.tableLayer.onActivate(5, 1);
        pump();
        eq([curLine(), curCol()], [5, 1], 'cell of row "two" column 2');
        ok(!tBlock().collapsed, 'the table did not open');
        cursorTo(0); ed.tableLayer.onActivate(2, 0); pump();
        eq([curLine(), curCol()], [2, 0], 'header cell column 1');
    });
    test('a reused grid directs clicks to the new line after the text shifts', () => {
        setText(DOC); cursorTo(0); settleT();
        const widget = tBlock().widget!;
        buf.insert(buf.get_start_iter(), 'extra\n', -1); pump(); settleT();
        ok(tBlock().widget === widget, 'the grid was rebuilt when only the lines shifted');
        emitClick(tBlock().grid!.get_child_at(0, 0)!);
        pump();
        eq(curLine(), 3, 'a click on the header used the shifted table line');
    });
    test('the cursor and selection only change the tags of tables whose state changed', () => {
        setText(`${DOC}\n\n${DOC}\n\n${DOC}`); cursorTo(0); settleT();
        const blocks = ed.tableLayer.blocks;
        eq(blocks.length, 3);
        const widgets = blocks.map(b => b.widget);
        const touched: number[] = [];
        const record = (_buf: Gtk.TextBuffer, tag: Gtk.TextTag, start: Gtk.TextIter) => {
            if (tag === ed.tags.tablehide || tag.name?.startsWith('table-gap-')) touched.push(start.get_line());
        };
        const applied = buf.connect('apply-tag', record);
        const removed = buf.connect('remove-tag', record);
        try {
            cursorTo(blocks[1].start);
            ok(touched.length > 0 && touched.every(l => l >= blocks[1].start && l <= blocks[1].end), 'the tag of another table was touched');
            eq(blocks.map(b => b.collapsed), [true, false, true]);
            touched.length = 0;
            cursorTo(blocks[1].end);
            eq(touched.length, 0, 'moving within the table reapplied the tags');
            buf.select_range(iterAtLine(buf, blocks[0].start), iterAtLine(buf, blocks[2].end));
            pump(); settleT();
            eq(blocks.map(b => b.collapsed), [false, false, false]);
            ok(blocks.every(b => !tableTag(b.start)), 'a selection across tables still hides the text');
            cursorTo(0); settleT();
            ok(blocks.every((b, i) => b.collapsed && b.widget === widgets[i] && b.widget?.get_visible()), 'the grid was not reused');
            ok(blocks.every(b => tableTag(b.start)), 'the tags did not return after the selection was released');
        } finally {
            buf.disconnect(applied);
            buf.disconnect(removed);
        }
    });
    test('an off-screen grid is positioned when scrolled without changing the table space', () => {
        setText(`${DOC}\n\n`.repeat(40)); cursorTo(0); settleT();
        const first = ed.tableLayer.blocks[0];
        const last = ed.tableLayer.blocks[39];
        ok(first.widget?.get_visible(), 'the first grid is not shown');
        eq(last.widget, null, 'an off-screen grid was created before it was needed');
        ok(ed.tableLayer.blocks.filter(b => b.widget).length < 10, 'too many grids were created on opening');
        const height = ed.view.get_vadjustment()!.upper;
        ed.view.scroll_to_iter(iterAtLine(buf, last.end), 0, true, 0, 0.5);
        settleT();
        ok(last.widget?.get_visible(), 'the last grid is not shown after scrolling');
        // The actual position of the widget (not the number stored by the layer) must scroll along.
        const [, gx, gy] = last.widget!.translate_coordinates(ed.view, 0, 0);
        eq([gx, gy], ed.view.buffer_to_window_coords(Gtk.TextWindowType.WIDGET, last.x, last.y), 'grid position after scrolling');
        eq(last.widget!.measure(Gtk.Orientation.VERTICAL, -1)[1], last.height, 'the placeholder height differs from the actual grid');
        ok(!first.widget?.get_visible(), 'the first grid was not hidden after scrolling');
        const [lineY, lineHeight] = ed.view.get_line_yrange(iterAtLine(buf, last.end));
        eq(last.y, lineY + lineHeight - last.height - 12, 'the position of the last grid is wrong');
        eq(ed.view.get_vadjustment()!.upper, height, 'hiding the grid changed the document height');
        ed.view.scroll_to_iter(buf.get_start_iter(), 0, true, 0, 0);
        settleT();
        ok(first.widget?.get_visible(), 'the first grid did not return');
    });
    test('the height of an off-screen table is exact for different contents, Unicode, and theme changes', () => {
        const docs = Array.from({ length: 30 }, (_, i) =>
            `top ${i}\n\n| **Title ${i}** | Value |\n| --- | --- |\n| 🎉 ${i} | \`code\` |\n` +
            (i % 2 ? '| extra row | ==highlight== |\n' : '') + '\nbottom\n\n');
        setText(docs.join('')); cursorTo(0); settleT();
        const last = ed.tableLayer.blocks[29];
        eq(last.widget, null, 'a different off-screen table was already created');
        const height = ed.view.get_vadjustment()!.upper;
        ed.view.scroll_to_iter(iterAtLine(buf, last.end), 0, true, 0, 0.5); settleT();
        ok(last.widget?.get_visible(), 'the last grid did not appear');
        eq(last.widget!.measure(Gtk.Orientation.VERTICAL, -1)[1], last.height, 'the measured height is wrong');
        eq(ed.view.get_vadjustment()!.upper, height, 'membuat grid menggeser tinggi dokumen');
        w.setDark(true); settleT();
        ok(last.widget?.get_visible(), 'the grid vanished when the theme changed');
        eq(last.widget!.measure(Gtk.Orientation.VERTICAL, -1)[1], last.height, 'the dark theme height is wrong');
        w.setDark(false); settleT();
    });
    test('Tab moves to the next cell, then to the next row', () => {
        setText(DOC); cursorTo(4, 2);
        key(Gdk.KEY_Tab); eq([curLine(), curCol()], [4, 1], 'second cell');
        key(Gdk.KEY_Tab); eq([curLine(), curCol()], [5, 0], 'baris berikutnya');
    });
    test('Tab in the last cell adds a new row', () => {
        cursorTo(5, 9);
        key(Gdk.KEY_Tab);
        eq(text().split('\n').length, DOC.split('\n').length + 1, 'number of lines');
        eq(lineAt(6), '|  |  |', 'new row');
        eq([curLine(), curCol()], [6, 0], 'cursor in the first cell of the new row');
    });
    test('Shift+Tab goes back, and stops at the first cell', () => {
        setText(DOC); cursorTo(5, 2);
        key(Gdk.KEY_ISO_Left_Tab, Gdk.ModifierType.SHIFT_MASK); eq([curLine(), curCol()], [4, 1], 'to the previous row');
        cursorTo(2, 2);
        key(Gdk.KEY_ISO_Left_Tab, Gdk.ModifierType.SHIFT_MASK); eq([curLine(), curCol()], [2, 0], 'stays in the first cell');
    });
    test('Enter moves to the same cell in the next row, skipping the separator row', () => {
        setText(DOC); cursorTo(2, 9);
        key(Gdk.KEY_Return); eq([curLine(), curCol()], [4, 1], 'from the header to the first body row');
        key(Gdk.KEY_Return); eq([curLine(), curCol()], [5, 1], 'to the next row');
    });
    test('Enter on the last row adds a row; on the last empty row it leaves the table', () => {
        key(Gdk.KEY_Return);
        eq(lineAt(6), '|  |  |', 'new row');
        eq([curLine(), curCol()], [6, 1], 'cursor in the same cell');
        key(Gdk.KEY_Return);
        eq(lineAt(6), '', 'the empty row was deleted');
        eq(text(), DOC, 'the document is back as it was');
        eq(curLine(), 6, 'cursor outside the table');
    });
    test('Enter outside a table is not handled by the table', () => {
        setText('text\n\n| a |\n| - |\n| 1 |'); cursorTo(0, 4);
        ok(!ed.onKey(Gdk.KEY_Return, 0), 'Enter in a plain paragraph was handled');
    });
    test('header-only table: Tab in the last cell adds a body row', () => {
        setText('| a | b |\n| --- | --- |\n\nx'); cursorTo(0, 6);
        key(Gdk.KEY_Tab);
        eq(tableLines(0, 3), ['| a | b |', '| --- | --- |', '|  |  |', ''], 'new row');
        eq([curLine(), curCol()], [2, 0], 'cursor');
    });

    test('command: add a row below (columns tidied up)', () => {
        setText(DOC); cursorTo(4, 2);
        ed.tableCommand('row-below');
        eq(tableLines(2, 6), ['| Name | Value |', '| :--- | ----: |', '| one  |     1 |', '|      |       |', '| two  |     2 |']);
        eq([curLine(), curCol()], [5, 0], 'cursor in the new row');
    });
    test('command: add a row above and delete a row', () => {
        setText(DOC); cursorTo(5, 2);
        ed.tableCommand('row-above');
        eq(tableLines(4, 6).map(l => l.trim()), ['| one  |     1 |', '|      |       |', '| two  |     2 |'], 'inserted above "two"');
        eq(curLine(), 5, 'cursor in the new row');
        ed.tableCommand('delete-row');
        eq(tableLines(2, 5), ['| Name | Value |', '| :--- | ----: |', '| one  |     1 |', '| two  |     2 |'], 'row deleted');
    });
    test('command: add and delete a column', () => {
        setText(DOC); cursorTo(4, 2);
        ed.tableCommand('col-right');   // cursor in column 1, so the new column is to its right
        eq(tableLines(2, 5), ['| Name |     | Value |', '| :--- | --- | ----: |', '| one  |     |     1 |', '| two  |     |     2 |'], 'new column');
        eq([curLine(), curCol()], [4, 1], 'cursor in the new column');
        ed.tableCommand('delete-col');
        eq(tableLines(2, 5), ['| Name | Value |', '| :--- | ----: |', '| one  |     1 |', '| two  |     2 |'], 'the new column was deleted; the other columns are intact');
        ed.tableCommand('col-left');    // the cursor is now in the "Value" column (replacing the deleted column)
        eq(lineAt(2), '| Name |     | Value |', 'new column to the left of "Value"');
    });
    test('command: align center and tidy up', () => {
        setText('| a | b |\n| --- | --- |\n| lengthy | 1 |'); cursorTo(0, 2);
        ed.tableCommand('align-center');
        eq(tableLines(0, 2), ['| a       | b   |', '| :-----: | --- |', '| lengthy | 1   |'].map((l, i) => i === 0 ? '|    a    | b   |' : l));
        ed.tableCommand('format');
        eq(lineAt(2), '| lengthy | 1   |', 'tidying does not change what is already tidy');
    });
    test('commands that are not allowed are refused with a message', () => {
        setText(DOC); cursorTo(2, 2);
        ed.tableCommand('delete-row'); eq(tableMessage(), 'The header row cannot be deleted');
        ed.tableCommand('row-above'); eq(tableMessage(), 'Cannot insert a row above the table header');
        cursorTo(0);
        ed.tableCommand('format'); eq(tableMessage(), 'The cursor must be inside a table');
        eq(text(), DOC, 'the document did not change');
    });
    test('one table command = one undo step', () => {
        setText(DOC); cursorTo(4, 2);
        ed.tableCommand('format');
        ok(text() !== DOC, 'the command did not change the document');
        buf.undo(); pump();
        eq(text(), DOC, 'after undo');
    });
    test('table commands through menu actions', () => {
        setText(DOC); cursorTo(4, 2);
        action('table-row-below');
        eq(text().split('\n').length, DOC.split('\n').length + 1, 'number of lines');
    });
    test('source mode shows the raw table', () => {
        setText(DOC); cursorTo(0); settleT();
        ok(tBlock().collapsed, 'start: the grid is shown');
        action('source');
        ok(!tBlock().collapsed && !tBlock().widget?.get_visible() && !tableTag(3), 'source mode: the grid is still shown');
        action('source');
        ok(tBlock().collapsed && tBlock().widget?.get_visible(), 'after source mode is turned off');
    });
    test('the grid is narrowed to fit the width of the text column', () => {
        const before = ed.tableLayer.maxWidth;
        setText(`| ${'x'.repeat(80)} | ${'y'.repeat(80)} |\n| --- | --- |\n| 1 | 2 |\n\nend`); cursorTo(4);
        settleT();
        const widget = tBlock().widget;
        const height = tBlock().height;
        ed.tableLayer.setMaxWidth(320);
        settleT();
        eq(tBlock().widget, widget, 'the width change rebuilt the grid');
        ok(tBlock().height > height, 'a long cell should wrap so the table is taller');
        const grid = tBlock().widget!.get_first_child()!;
        const wrapped = grid.get_allocated_height();
        ok(Math.abs(wrapped - tBlock().height) <= 2, `the table space ${tBlock().height}px is not equal to the grid height ${wrapped}px`);
        // TextView gives a child widget its minimum size; that is the width that is shown.
        const width = tBlock().widget!.get_allocated_width();
        ok(width > 0 && width <= 320, `the grid width ${width}px exceeds the 320px column`);
        ed.tableLayer.setMaxWidth(before);
    });
    test('typing in a table does not rebuild the grid while the cursor is inside it', () => {
        setText(DOC); cursorTo(4, 2); settleT();
        buf.insert_at_cursor('x', -1); pump();
        ok(tBlock().widget === null, 'the grid was built while the cursor was inside the table');
        cursorTo(0); settleT();
        ok(tBlock().widget?.get_visible(), 'the grid did not appear after the cursor left');
    });
    test('tables and images with emoji alt text do not trigger GTK/Pango warnings', () => {
        // A color emoji font at a near-zero text size once made GTK fail to draw.
        const warnings: string[] = [];
        const flags = GLib.LogLevelFlags.LEVEL_WARNING | GLib.LogLevelFlags.LEVEL_CRITICAL;
        const handlers = ['Gtk', 'Pango', 'Gdk'].map(domain =>
            [domain, GLib.log_set_handler(domain, flags, (_d, _l, message) => { warnings.push(`${domain}: ${message}`); })] as const);
        try {
            setText('top\n\n| 🎉 | b |\n| --- | --- |\n| 👍🏽 | ✨ |\n\n![🎉 alt](images/not-there.png)\n\nbottom');
            cursorTo(0); settleT();
            cursorTo(4); settleT();
            cursorTo(8); settleT();
        } finally {
            for (const [domain, id] of handlers) GLib.log_remove_handler(domain, id);
        }
        eq(warnings, [], 'warnings');
    });
    test('a table at the end of the document without a trailing newline', () => {
        setText('text\n\n| a |\n| - |\n| 1 |'); cursorTo(0); settleT();
        ok(tBlock().collapsed && tBlock().widget?.get_visible(), 'the grid is not shown');
        eq(text(), 'text\n\n| a |\n| - |\n| 1 |', 'document contents');
    });
    buf.set_modified(false);
}
