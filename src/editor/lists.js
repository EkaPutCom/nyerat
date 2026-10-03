// Perilaku Enter dan Tab di dalam daftar dan kutipan.

import { RE } from '../markdown/syntax.js';
import { lineText } from './editing.js';

// Apakah baris lineNo berada di dalam blok kode ```?
export function isInCodeBlock(lines, lineNo) {
    let open = null;
    for (let i = 0; i < lineNo && i < lines.length; i++) {
        const m = RE.fence.exec(lines[i]);
        if (!m) continue;
        if (!open) open = m[2][0];
        else if (m[2][0] === open && !m[3].trim()) open = null;
    }
    return open !== null;
}

// Enter di baris daftar/kutipan. Mengembalikan true jika ditangani:
//   "- satu"   → baris baru "- "
//   "9. a"     → baris baru "10. "
//   "- [x] a"  → baris baru "- [ ] "
//   "> a"      → baris baru "> "
//   item kosong ("- " atau "> ") → awalannya dihapus, daftar/kutipan berakhir
export function continueBlock(buffer) {
    const [line, ls, le] = lineText(buffer, buffer.get_iter_at_mark(buffer.get_insert()));
    const qp = /^(?:[ \t]*>[ \t]?)*/.exec(line)[0];
    const rest = line.slice(qp.length);
    const lm = RE.list.exec(rest);
    let prefix = null;
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

// Tab / Shift+Tab di baris daftar: tambah atau kurangi indentasi 4 spasi.
export function indentListItem(buffer, outdent) {
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
