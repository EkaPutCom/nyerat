// Perintah format yang mengubah isi buffer: tebal, tautan, heading, kutipan, dll.
// Setiap perintah dibungkus begin/end_user_action supaya satu Ctrl+Z membatalkannya.

import { cpLength } from './offsets.js';

const cursorIter = buffer => buffer.get_iter_at_mark(buffer.get_insert());

// Isi satu baris beserta iter awal dan akhirnya: [teks, awal, akhir].
export function lineText(buffer, iter) {
    const s = iter.copy();
    s.set_line_offset(0);
    const e = iter.copy();
    if (!e.ends_line()) e.forward_to_line_end();
    return [buffer.get_text(s, e, true), s, e];
}

// Nomor baris pertama dan terakhir dari seleksi (atau baris kursor).
export function selectedLines(buffer) {
    const [has, s, e] = buffer.get_selection_bounds();
    const a = has ? s : cursorIter(buffer);
    const b = has ? e : a;
    return [a.get_line(), b.get_line()];
}

// Bungkus seleksi dengan penanda, misalnya ** untuk tebal. Jika seleksi sudah
// terbungkus, penandanya dilepas. Tanpa seleksi: sisipkan pasangan penanda dan
// taruh kursor di tengahnya.
export function wrapSelection(buffer, left, right = left) {
    buffer.begin_user_action();
    const [has, s, e] = buffer.get_selection_bounds();
    if (has) {
        const txt = buffer.get_text(s, e, true);
        const so = s.get_offset();
        buffer.delete(s, e);
        const out = txt.length >= left.length + right.length && txt.startsWith(left) && txt.endsWith(right)
            ? txt.slice(left.length, txt.length - right.length)
            : left + txt + right;
        buffer.insert(buffer.get_iter_at_offset(so), out, -1);
        buffer.select_range(buffer.get_iter_at_offset(so), buffer.get_iter_at_offset(so + cpLength(out)));
    } else {
        buffer.insert_at_cursor(left + right, -1);
        const it = cursorIter(buffer);
        it.backward_chars(cpLength(right));
        buffer.place_cursor(it);
    }
    buffer.end_user_action();
}

// Seleksi berupa teks → [teks](), berupa URL → [](url). Kursor ditaruh di bagian yang kosong.
export function insertLink(buffer) {
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

// Sisipkan blok (blok kode, tabel) dan taruh kursor di antara before dan after.
export function insertBlock(buffer, before, after) {
    const [line] = lineText(buffer, cursorIter(buffer));
    buffer.begin_user_action();
    const lead = line.trim() ? '\n\n' : '';
    buffer.insert_at_cursor(lead + before + after, -1);
    const it = cursorIter(buffer);
    it.backward_chars(cpLength(after));
    buffer.place_cursor(it);
    buffer.end_user_action();
}

// Tambah/hapus awalan baris ("> ", "- ", "1. ") pada semua baris terseleksi.
// Jika semua baris sudah berawalan, awalan dihapus.
export function togglePrefix(buffer, re, prefix) {
    const [l0, l1] = selectedLines(buffer);
    const all = [];
    for (let n = l0; n <= l1; n++) all.push(lineText(buffer, buffer.get_iter_at_line(n))[0]);
    const remove = all.every(l => re.test(l));
    buffer.begin_user_action();
    for (let n = l0; n <= l1; n++) {
        const ls = buffer.get_iter_at_line(n);
        const line = lineText(buffer, ls)[0];
        if (remove) {
            const e = ls.copy();
            e.forward_chars(cpLength(re.exec(line)[0]));
            buffer.delete(ls, e);
        } else {
            buffer.insert(ls, prefix === '1. ' ? `${n - l0 + 1}. ` : prefix, -1);
        }
    }
    buffer.end_user_action();
}

// Jadikan baris kursor heading level 1–6; level 0 atau level yang sama = paragraf biasa.
export function setHeading(buffer, level) {
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
