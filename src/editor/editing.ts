// Formatting commands that change the buffer contents: bold, link, heading, quote, etc.
// Each command is wrapped in begin/end_user_action so a single Ctrl+Z undoes it.

import type Gtk from 'gi://Gtk?version=4.0';
import { cpLength } from './offsets.js';
import { iterAtLine } from '../gtkutil.js';

const cursorIter = (buffer: Gtk.TextBuffer) => buffer.get_iter_at_mark(buffer.get_insert());

// Contents of one line with its start and end iters: [text, start, end].
export function lineText(buffer: Gtk.TextBuffer, iter: Gtk.TextIter): [string, Gtk.TextIter, Gtk.TextIter] {
    const s = iter.copy();
    s.set_line_offset(0);
    const e = iter.copy();
    if (!e.ends_line()) e.forward_to_line_end();
    return [buffer.get_text(s, e, true), s, e];
}

// First and last line numbers of the selection (or the cursor line).
export function selectedLines(buffer: Gtk.TextBuffer): [number, number] {
    const [has, s, e] = buffer.get_selection_bounds();
    const a = has ? s : cursorIter(buffer);
    const b = has ? e : a;
    return [a.get_line(), b.get_line()];
}

// Wrap the selection with a marker, e.g. ** for bold. If the selection is already
// wrapped, the marker is removed. Without a selection: insert a pair of markers and
// put the cursor in between.
export function wrapSelection(buffer: Gtk.TextBuffer, left: string, right = left): void {
    buffer.begin_user_action();
    const [has, s, e] = buffer.get_selection_bounds();
    if (has) {
        // Only the markers are inserted/removed, the selection is never empty. On X11,
        // a selection that was briefly empty releases the PRIMARY clipboard, and GTK 4 cancels the new
        // selection as soon as the server confirms that release (the second Ctrl+B then does not remove **).
        const txt = buffer.get_text(s, e, true);
        const so = s.get_offset(), eo = e.get_offset();
        const l = cpLength(left), r = cpLength(right);
        const at = (offset: number) => buffer.get_iter_at_offset(offset);
        if (txt.length >= left.length + right.length && txt.startsWith(left) && txt.endsWith(right)) {
            buffer.delete(at(eo - r), at(eo));
            buffer.delete(at(so), at(so + l));
            buffer.select_range(at(so), at(eo - l - r));
        } else {
            buffer.insert(at(eo), right, -1);
            buffer.insert(at(so), left, -1);
            buffer.select_range(at(so), at(eo + l + r));
        }
    } else {
        buffer.insert_at_cursor(left + right, -1);
        const it = cursorIter(buffer);
        it.backward_chars(cpLength(right));
        buffer.place_cursor(it);
    }
    buffer.end_user_action();
}

// Selected text → [text](), selected URL → [](url). The cursor is placed in the empty part.
export function insertLink(buffer: Gtk.TextBuffer): void {
    const [has, s, e] = buffer.get_selection_bounds();
    buffer.begin_user_action();
    if (has) {
        const txt = buffer.get_text(s, e, true);
        const isUrl = /^(https?:|mailto:)/.test(txt);
        buffer.delete(s, e);
        buffer.insert(s, isUrl ? `[](${txt})` : `[${txt}]()`, -1);
        const it = cursorIter(buffer);
        it.backward_chars(isUrl ? cpLength(txt) + 3 : 1);
        buffer.place_cursor(it);
    } else {
        buffer.insert_at_cursor('[]()', -1);
        const it = cursorIter(buffer);
        it.backward_chars(3);
        buffer.place_cursor(it);
    }
    buffer.end_user_action();
}

// Insert a block (code block, table) and put the cursor between before and after.
export function insertBlock(buffer: Gtk.TextBuffer, before: string, after: string): void {
    const [line] = lineText(buffer, cursorIter(buffer));
    buffer.begin_user_action();
    const lead = line.trim() ? '\n\n' : '';
    buffer.insert_at_cursor(lead + before + after, -1);
    const it = cursorIter(buffer);
    it.backward_chars(cpLength(after));
    buffer.place_cursor(it);
    buffer.end_user_action();
}

// Add/remove a line prefix ("> ", "- ", "1. ") on all selected lines.
// If all lines already have the prefix, the prefix is removed.
export function togglePrefix(buffer: Gtk.TextBuffer, re: RegExp, prefix: string): void {
    const [l0, l1] = selectedLines(buffer);
    const all: string[] = [];
    for (let n = l0; n <= l1; n++) all.push(lineText(buffer, iterAtLine(buffer, n))[0]);
    const remove = all.every(l => re.test(l));
    buffer.begin_user_action();
    for (let n = l0; n <= l1; n++) {
        const ls = iterAtLine(buffer, n);
        const line = lineText(buffer, ls)[0];
        if (remove) {
            const e = ls.copy();
            e.forward_chars(cpLength(re.exec(line)![0]));
            buffer.delete(ls, e);
        } else {
            buffer.insert(ls, prefix === '1. ' ? `${n - l0 + 1}. ` : prefix, -1);
        }
    }
    buffer.end_user_action();
}

// Make the cursor line a level 1–6 heading; level 0 or the same level = plain paragraph.
export function setHeading(buffer: Gtk.TextBuffer, level: number): void {
    const [line, ls] = lineText(buffer, cursorIter(buffer));
    const m = /^#{1,6}[ \t]*/.exec(line);
    const cur = m ? m[0].replace(/\s/g, '').length : 0;
    buffer.begin_user_action();
    if (m) {
        const e = ls.copy();
        e.forward_chars(m[0].length);
        buffer.delete(ls, e);
    }
    if (level > 0 && level !== cur) buffer.insert(ls, `${'#'.repeat(level)} `, -1);
    buffer.end_user_action();
}
