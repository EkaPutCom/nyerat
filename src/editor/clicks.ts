// Arti klik pada teks: mencentang kotak tugas dan membaca URL tautan.

import type Gtk from 'gi://Gtk?version=4.0';
import { cpToU16, cpLength } from './offsets.js';
import type { Tags } from './tags.js';
import { lineText } from './editing.js';

// Klik di "[ ]" / "[x]" → balik status centangnya. Mengembalikan true jika ditangani.
export function toggleTaskAt(buffer: Gtk.TextBuffer, iter: Gtk.TextIter, tags: Tags): boolean {
    if (!iter.has_tag(tags.task) && !iter.has_tag(tags.taskdone)) return false;
    const [line, ls] = lineText(buffer, iter);
    const k = line.lastIndexOf('[', cpToU16(line, iter.get_line_offset()));
    if (k < 0 || !/^\[[ xX]\]/.test(line.slice(k))) return false;
    const a = ls.copy();
    a.forward_chars(cpLength(line.slice(0, k + 1)));
    const b = a.copy();
    b.forward_char();
    buffer.begin_user_action();
    buffer.delete(a, b);
    buffer.insert(a, line[k + 1] === ' ' ? 'x' : ' ', -1);
    buffer.end_user_action();
    return true;
}

const LINK_PATTERNS = [
    /!?\[[^\]]*\]\(([^)\s]*)[^)]*\)/g,          // [teks](url) dan ![alt](url)
    /<((?:https?|mailto|ftp):[^\s>]+)>/g,          // <https://...>
    /\bhttps?:\/\/[^\s<>]*[^\s<>.,;:!?)\]'"]/g,  // URL polos
];

// URL dari tautan di posisi iter, atau null.
export function linkAt(buffer: Gtk.TextBuffer, iter: Gtk.TextIter, tags: Tags): string | null {
    if (!iter.has_tag(tags.link) && !iter.has_tag(tags.image)) return null;
    const [line] = lineText(buffer, iter);
    const pos = cpToU16(line, iter.get_line_offset());
    for (const re of LINK_PATTERNS) {
        re.lastIndex = 0;
        let r: RegExpExecArray | null;
        while ((r = re.exec(line))) {
            if (pos >= r.index && pos <= r.index + r[0].length) return r[1] ?? r[0];
        }
    }
    return null;
}
