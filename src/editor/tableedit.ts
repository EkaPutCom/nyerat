// Editing tables in their raw text: Tab/Enter move between cells and rows, plus
// commands to add/delete rows and columns, align, and tidy up columns.
//
// All functions here re-read the document from the buffer (not from the last
// highlighting result), so they always match the text being displayed.
// The table logic itself is in markdown/table.ts.

import type Gtk from 'gi://Gtk?version=4.0';
import { cpLength, cpToU16 } from './offsets.js';
import {
    cellIndexAt, cellStart, deleteColumn, deleteRow, findTables, insertColumn, insertRow,
    parseTable, renderRow, renderTable, setAlign, splitRow, type Align, type TableRange,
} from '../markdown/table.js';
import { iterAtLine } from '../gtkutil.js';
import { _ } from '../i18n.js';

export type TableCommand =
    | 'row-below' | 'row-above' | 'col-right' | 'col-left' | 'delete-row' | 'delete-col'
    | 'align-left' | 'align-center' | 'align-right' | 'format';

export type CommandResult = { ok: true } | { ok: false; reason: string };

// Cursor position inside a table. Rows are counted "logically": 0 = header (the separator row
// is considered part of the header), 1 = first body row, etc.
interface Where {
    table: TableRange;
    lines: string[];
    row: number;
    col: number;
    columns: number;
}

const getLines = (buffer: Gtk.TextBuffer): string[] => {
    const [start, end] = buffer.get_bounds();
    return buffer.get_text(start, end, true).split('\n');
};

const lineOfRow = (table: TableRange, row: number): number => table.start + (row === 0 ? 0 : row + 1);
const lastRow = (table: TableRange): number => table.end - table.start - 1;

function whereIsCursor(buffer: Gtk.TextBuffer): Where | null {
    const lines = getLines(buffer);
    const cursor = buffer.get_iter_at_mark(buffer.get_insert());
    const line = cursor.get_line();
    const table = findTables(lines).find(t => line >= t.start && line <= t.end);
    if (!table) return null;
    const columns = splitRow(lines[table.start]).length;
    const offset = cpToU16(lines[line], cursor.get_line_offset());
    return {
        table, lines, columns,
        row: line <= table.start + 1 ? 0 : line - table.start - 1,
        col: Math.min(cellIndexAt(lines[line], offset), columns - 1),
    };
}

// Cursor to the start of the contents of cell (row, col). A row with fewer cells: to the end of the row.
function placeCursor(buffer: Gtk.TextBuffer, line: number, col: number): void {
    const [start, end] = buffer.get_bounds();
    const text = buffer.get_text(start, end, true).split('\n')[line] ?? '';
    const iter = iterAtLine(buffer, line);
    iter.forward_chars(cpLength(text.slice(0, cellStart(text, col))));
    buffer.place_cursor(iter);
}

// Replace lines start..end with newLines in a single undo step.
function replaceLines(buffer: Gtk.TextBuffer, start: number, end: number, newLines: string[]): void {
    const from = iterAtLine(buffer, start);
    const to = iterAtLine(buffer, end);
    if (!to.ends_line()) to.forward_to_line_end();
    buffer.begin_user_action();
    buffer.delete(from, to);
    buffer.insert(from, newLines.join('\n'), -1);
    buffer.end_user_action();
}

// Add one blank row below the table's last row.
function appendRow(buffer: Gtk.TextBuffer, table: TableRange, columns: number): void {
    const end = iterAtLine(buffer, table.end);
    if (!end.ends_line()) end.forward_to_line_end();
    buffer.begin_user_action();
    buffer.insert(end, `\n${renderRow(Array<string>(columns).fill(''))}`, -1);
    buffer.end_user_action();
}

// ---------- Tab and Enter ----------

// Tab / Shift+Tab: move to the next / previous cell. In the last cell, Tab
// adds a new row. true if the cursor is in a table (the key was handled).
export function tabInTable(buffer: Gtk.TextBuffer, backward: boolean): boolean {
    const at = whereIsCursor(buffer);
    if (!at) return false;
    const { table, row, col, columns } = at;

    let toRow = row, toCol = col;
    if (!backward) {
        if (col + 1 < columns) toCol = col + 1;
        else { toRow = row + 1; toCol = 0; }
    } else if (col > 0) {
        toCol = col - 1;
    } else if (row > 0) {
        toRow = row - 1;
        toCol = columns - 1;
    } else {
        return true;  // first cell: there is nothing before it
    }
    if (toRow > lastRow(table)) appendRow(buffer, table, columns);
    placeCursor(buffer, lineOfRow(table, toRow), toCol);
    return true;
}

// Enter: move to the same cell in the next row (a new row if already on the last
// row). On an empty last body row, Enter deletes that row and leaves
// the table, like Enter on an empty list item.
export function enterInTable(buffer: Gtk.TextBuffer): boolean {
    const at = whereIsCursor(buffer);
    if (!at) return false;
    const { table, lines, row, col, columns } = at;

    if (row > 0 && row === lastRow(table) && splitRow(lines[table.end]).every(c => c.text === '')) {
        if ((lines[table.end + 1] ?? null) !== null && lines[table.end + 1].trim() === '') {
            // There is already a blank line below the table: just delete the whole blank line
            // (together with the row separator), and the cursor moves to the existing blank line.
            const from = iterAtLine(buffer, table.end - 1);
            from.forward_to_line_end();
            const to = iterAtLine(buffer, table.end);
            to.forward_to_line_end();
            buffer.begin_user_action();
            buffer.delete(from, to);
            buffer.end_user_action();
        } else {
            replaceLines(buffer, table.end, table.end, ['']);  // leave a blank line as a separator
        }
        placeCursor(buffer, table.end, 0);
        return true;
    }
    if (row + 1 > lastRow(table)) appendRow(buffer, table, columns);
    placeCursor(buffer, lineOfRow(table, row + 1), col);
    return true;
}

// ---------- Perintah menu ----------

const ALIGN_OF: Partial<Record<TableCommand, Align>> = { 'align-left': 'left', 'align-center': 'center', 'align-right': 'right' };

// Runs a command on the table at the cursor position. The result is always a table that has been
// tidied (column widths equalized), because adding/deleting columns changes their widths.
export function runTableCommand(buffer: Gtk.TextBuffer, command: TableCommand): CommandResult {
    const at = whereIsCursor(buffer);
    if (!at) return { ok: false, reason: _('The cursor must be inside a table') };
    const { table, lines, row, col, columns } = at;
    let model = parseTable(lines.slice(table.start, table.end + 1));
    let cursorRow = row, cursorCol = col;
    const body = row - 1;   // index into model.rows; -1 = header

    switch (command) {
        case 'row-below':
            model = insertRow(model, body + 1);
            cursorRow = row + 1;
            break;
        case 'row-above':
            if (row === 0) return { ok: false, reason: _('Cannot insert a row above the table header') };
            model = insertRow(model, body);
            break;
        case 'delete-row':
            if (row === 0) return { ok: false, reason: _('The header row cannot be deleted') };
            model = deleteRow(model, body);
            cursorRow = Math.min(row, model.rows.length);
            break;
        case 'col-right':
            model = insertColumn(model, col + 1);
            cursorCol = col + 1;
            break;
        case 'col-left':
            model = insertColumn(model, col);
            break;
        case 'delete-col':
            if (columns <= 1) return { ok: false, reason: _('The last column cannot be deleted') };
            model = deleteColumn(model, col);
            cursorCol = Math.min(col, columns - 2);
            break;
        case 'format':
            break;
        default:
            model = setAlign(model, col, ALIGN_OF[command] ?? null);
    }

    replaceLines(buffer, table.start, table.end, renderTable(model));
    placeCursor(buffer, lineOfRow({ start: table.start, end: table.start + model.rows.length + 1 }, cursorRow), cursorCol);
    return { ok: true };
}
