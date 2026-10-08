// Enter and Tab behavior inside lists and quotes.

import type Gtk from 'gi://Gtk?version=4.0';
import { RE } from '../markdown/syntax.js';
import { lineText } from './editing.js';

// Is line lineNo inside a ``` code block?
export function isInCodeBlock(lines: string[], lineNo: number): boolean {
    let open: string | null = null;
    for (let i = 0; i < lineNo && i < lines.length; i++) {
        const m = RE.fence.exec(lines[i]);
        if (!m) continue;
        if (!open) open = m[2][0];
        else if (m[2][0] === open && !m[3].trim()) open = null;
    }
    return open !== null;
}

// Enter on a list/quote line. Returns true if handled:
//   "- one"   → new line "- "
//   "9. a"     → new line "10. "
//   "- [x] a"  → new line "- [ ] "
//   "> a"      → new line "> "
//   empty item ("- " or "> ") → its prefix is removed, the list/quote ends
export function continueBlock(buffer: Gtk.TextBuffer): boolean {
    const [line, ls, le] = lineText(buffer, buffer.get_iter_at_mark(buffer.get_insert()));
    const qp = /^(?:[ \t]*>[ \t]?)*/.exec(line)![0];
    const rest = line.slice(qp.length);
    const lm = RE.list.exec(rest);
    let prefix: string | null = null;
    if (lm) {
        if (!rest.slice(lm[0].length).trim()) {
            buffer.begin_user_action();
            buffer.delete(ls, le);
            buffer.insert(ls, qp.replace(/[ \t]*>[ \t]?$/, ''), -1);
            buffer.end_user_action();
            return true;
        }
        let marker = lm[2];
        const num = parseInt(marker);
        if (!isNaN(num)) marker = `${num + 1}${marker.slice(-1)}`;
        prefix = `${qp}${lm[1]}${marker}${lm[3] || ' '}${lm[4] ? '[ ] ' : ''}`;
    } else if (qp) {
        if (!rest.trim()) {
            buffer.begin_user_action();
            buffer.delete(ls, le);
            buffer.end_user_action();
            return true;
        }
        prefix = qp.endsWith(' ') ? qp : `${qp} `;
    }
    if (prefix === null) return false;
    buffer.begin_user_action();
    buffer.insert_at_cursor(`\n${prefix}`, -1);
    buffer.end_user_action();
    return true;
}

// Tab / Shift+Tab on a list line: increase or decrease the indentation by 4 spaces.
export function indentListItem(buffer: Gtk.TextBuffer, outdent: boolean): boolean {
    const [line, ls] = lineText(buffer, buffer.get_iter_at_mark(buffer.get_insert()));
    if (!RE.list.test(line.replace(/^(?:[ \t]*>[ \t]?)+/, ''))) return false;
    buffer.begin_user_action();
    if (outdent) {
        const n = /^( {1,4}|\t)/.exec(line);
        if (n) {
            const e = ls.copy();
            e.forward_chars(n[0].length);
            buffer.delete(ls, e);
        }
    } else {
        buffer.insert(ls, '    ', -1);
    }
    buffer.end_user_action();
    return true;
}
