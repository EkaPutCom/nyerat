// Penyorot sintaks: membaca seluruh isi buffer, mengenali Markdown baris per baris,
// lalu memasang tag gaya. Juga mengumpulkan:
//
//   markers   rentang sintaks yang boleh disembunyikan, beserta baris tempat
//             sintaks itu "aktif": [awal, akhir, barisPertama, barisTerakhir]
//             (offset dalam code point). Untuk blok kode, rentang barisnya
//             adalah seluruh blok, jadi pembatas ``` muncul selama kursor ada
//             di dalam blok.
//   headings  daftar heading untuk outline: { level, text, line }
//   lines     isi dokumen per baris
//   images    gambar yang perlu ditampilkan: { line, url, alt }
//   codeBlocks isi blok kode beserta bahasanya, untuk diwarnai (lihat codehighlight.ts)
//   tables    rentang baris setiap tabel, untuk dirender sebagai grid (lihat tablelayer.ts)

import type Gtk from 'gi://Gtk?version=3.0';
import { RE, isTableSeparator } from '../markdown/syntax.js';
import { findTables, type TableRange } from '../markdown/table.js';
import { parseInline } from '../markdown/inline.js';
import { makeCpMap } from './offsets.js';
import { SYNTAX_TAGS, type TagName, type Tags } from './tags.js';

// Sintaks yang boleh disembunyikan: [awal, akhir, barisPertama, barisTerakhir].
export type Marker = [start: number, end: number, firstLine: number, lastLine: number];

export interface Heading {
    level: number;
    text: string;
    line: number;
}

export interface ImageRef {
    line: number;
    url: string;
    alt: string;
}

export interface CodeBlock {
    lang: string;     // teks setelah ``` (misalnya "js"); '' jika tidak ada
    start: number;    // offset (code point) awal isi blok di buffer
    text: string;     // isi blok tanpa baris pembatas
    startLine: number;  // baris pembatas pembuka
    endLine: number;    // baris pembatas penutup (baris terakhir dokumen jika tidak ditutup)
    closed: boolean;
}

export interface HighlightResult {
    text: string;
    lines: string[];
    markers: Marker[];
    headings: Heading[];
    images: ImageRef[];
    codeBlocks: CodeBlock[];
    tables: TableRange[];
}

export function highlight(buffer: Gtk.TextBuffer, tags: Tags): HighlightResult {
    const [start, end] = buffer.get_bounds();
    const text = buffer.get_text(start, end, true);
    for (const name of SYNTAX_TAGS) buffer.remove_tag(tags[name], start, end);

    // Semua posisi di bawah ini dalam UTF-16 (string JS); dikonversi saat menyentuh buffer.
    const toCp = makeCpMap(text);
    const iter = (off: number) => buffer.get_iter_at_offset(toCp(off));
    const apply = (name: TagName, a: number, b: number) => { if (b > a) buffer.apply_tag(tags[name], iter(a), iter(b)); };
    const markers: Marker[] = [];
    const hide = (a: number, b: number, l0: number, l1: number) => { if (b > a) markers.push([toCp(a), toCp(b), l0, l1]); };
    const headings: Heading[] = [];
    const lines = text.split('\n');

    const images: ImageRef[] = [];

    // withImages = false untuk baris tabel: gambar di bawah baris tabel merusak tata letaknya.
    const inline = (base: number, s: string, line: number, withImages = true) => {
        const { tags: found, marks, images: imgs } = parseInline(s);
        for (const [n, a, b] of found) apply(n, base + a, base + b);
        for (const [a, b] of marks) hide(base + a, base + b, line, line);
        if (!withImages) return;
        for (const img of imgs) {
            images.push({ line, url: img.url, alt: img.alt });
            // Seperti Typora: di baris yang tidak aktif, seluruh ![alt](url) disembunyikan
            // dan hanya gambarnya yang terlihat (lihat editor/images.ts).
            hide(base + img.start, base + img.end, line, line);
        }
    };

    // Tabel dikenali lebih dulu dari seluruh dokumen, supaya aturannya sama dengan
    // yang dipakai perintah edit dan ekspor HTML (markdown/table.ts).
    const tables = findTables(lines);
    const tableOf = new Map<number, TableRange>();
    for (const t of tables) for (let l = t.start; l <= t.end; l++) tableOf.set(l, t);

    let off = 0;
    let fence: { line: number; ch: string; len: number; a: number; b: number; lang: string } | null = null;
    const codeBlocks: CodeBlock[] = [];
    // Blok kode selesai di baris lastLine (eksklusif): catat isinya.
    const closeBlock = (f: NonNullable<typeof fence>, lastLine: number) =>
        codeBlocks.push({
            lang: f.lang, start: toCp(f.b), text: lines.slice(f.line + 1, lastLine).join('\n'),
            startLine: f.line, endLine: Math.min(lastLine, lines.length - 1), closed: lastLine < lines.length,
        });
    for (let i = 0; i < lines.length; off += lines[i].length + 1, i++) {
        const line = lines[i];
        const lineEnd = off + line.length;
        const nl = i < lines.length - 1 ? 1 : 0;
        let m: RegExpExecArray | null;

        // Di dalam blok kode: tidak ada format lain, cari pembatas penutup.
        if (fence) {
            m = RE.fence.exec(line);
            apply('codeblock', off, lineEnd + nl);
            if (m && m[2][0] === fence.ch && m[2].length >= fence.len && !m[3].trim()) {
                apply('fence', off, lineEnd);
                hide(fence.a, fence.b, fence.line, i);
                hide(off, lineEnd + nl, fence.line, i);
                closeBlock(fence, i);
                fence = null;
            }
            continue;
        }
        if ((m = RE.fence.exec(line)) && !(m[2][0] === '`' && m[3].includes('`'))) {
            fence = { line: i, ch: m[2][0], len: m[2].length, a: off, b: lineEnd + nl, lang: m[3].trim().split(/\s+/)[0] ?? '' };
            apply('codeblock', off, lineEnd + nl);
            apply('fence', off, lineEnd);
            continue;
        }
        if ((m = RE.heading.exec(line))) {
            const lvl = m[1].length, pl = m[0].length;
            apply(`h${lvl}` as TagName, off, lineEnd);  // lvl selalu 1–6
            apply('marker', off, off + pl);
            hide(off, off + pl, i, i);
            inline(off + pl, line.slice(pl), i);
            headings.push({ level: lvl, text: line.slice(pl).replace(/\s+#+\s*$/, '').trim(), line: i });
            continue;
        }
        if (RE.hr.test(line)) { apply('hr', off, lineEnd); continue; }
        const table = tableOf.get(i);
        if (table) {
            apply('table', off, lineEnd);
            if (i === table.start) apply('tablehead', off, lineEnd);
            else if (i === table.start + 1 && isTableSeparator(line)) apply('tablesep', off, lineEnd);
            for (let k = 0; k < line.length; k++) if (line[k] === '|') apply('marker', off + k, off + k + 1);
            inline(off, line, i, false);
            continue;
        }

        // Kutipan, boleh diikuti daftar: "> - item"
        let p = 0;
        if ((m = RE.quote.exec(line))) {
            p = m[0].length;
            const depth = (m[0].match(/>/g) ?? []).length;
            apply('quote', off, lineEnd);
            if (depth >= 2) apply(depth >= 3 ? 'quote3' : 'quote2', off, lineEnd);
            apply('marker', off, off + p);
            hide(off, off + p, i, i);
        }
        const rest = line.slice(p);
        if ((m = RE.list.exec(rest))) {
            const bs = off + p + m[1].length;
            apply('bullet', bs, bs + m[2].length);
            const q = p + m[0].length;
            if (m[4]) {
                const ts = off + p + m[1].length + m[2].length + m[3].length;
                const checked = /x/i.test(m[4]);
                apply(checked ? 'taskdone' : 'task', ts, ts + 3);
                if (checked) apply('done', off + q, lineEnd);
            }
            inline(off + q, line.slice(q), i);
            continue;
        }
        inline(off + p, rest, i);
    }
    if (fence) {
        hide(fence.a, fence.b, fence.line, lines.length - 1);
        closeBlock(fence, lines.length);  // blok yang belum ditutup berlanjut sampai akhir dokumen
    }

    return { text, lines, markers, headings, images, codeBlocks, tables };
}
