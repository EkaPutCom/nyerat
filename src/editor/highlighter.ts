// Penyorot sintaks: mengurai rentang suntingan sampai batas blok kembali stabil,
// lalu memasang tag gaya. Juga mengumpulkan:
//
//   markers   rentang sintaks yang boleh disembunyikan, beserta baris tempat
//             sintaks itu "aktif": [awal, akhir, barisPertama, barisTerakhir, baris]
//             (offset dalam code point; baris = tempat marker itu berada). Untuk
//             blok kode, rentang barisnya adalah seluruh blok, jadi pembatas ```
//             muncul selama kursor ada di dalam blok.
//   headings  daftar heading untuk outline: { level, text, line }
//   lines     isi dokumen per baris
//   images    gambar yang perlu ditampilkan: { line, url, alt }
//   codeBlocks isi blok kode beserta bahasanya, untuk diwarnai (lihat codehighlight.ts)
//   tables    rentang baris setiap tabel, untuk dirender sebagai grid (lihat tablelayer.ts)
//   starts    offset (code point) awal setiap baris
//
// Tag dipasang lewat LineTagger (tagsync.ts), jadi hanya baris yang berubah yang disentuh.

import type Gtk from 'gi://Gtk?version=3.0';
import { RE, isTableSeparator } from '../markdown/syntax.js';
import { findTables, type TableRange } from '../markdown/table.js';
import { parseInline } from '../markdown/inline.js';
import { makeCpMap, cpLength } from './offsets.js';
import { type TagName, type Tags } from './tags.js';
import type { LineSpan, LineTagger } from './tagsync.js';

// Sintaks yang boleh disembunyikan: [awal, akhir, barisPertama, barisTerakhir, baris].
export type Marker = [start: number, end: number, firstLine: number, lastLine: number, line: number];

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
    starts: number[];
    words: number;
    characters: number;
}

interface Parsed extends HighlightResult {
    spans: LineSpan[][];
    checkpoints: number[];
    lineWords: number[];
}

const lowerBound = (items: number[], value: number): number => {
    let a = 0, b = items.length;
    while (a < b) { const mid = (a + b) >>> 1; if (items[mid] < value) a = mid + 1; else b = mid; }
    return a;
};

// Baris di luar kode/tabel tanpa pipa adalah batas netral. Ia tidak bisa
// menjadi judul/lanjutan tabel. Fence baru boleh memperpanjang rentang parsing.
function checkpoints(lines: string[], code: CodeBlock[], tables: TableRange[]): number[] {
    const points: number[] = [];
    let c = 0, t = 0;
    for (let i = 0; i < lines.length; i++) {
        if (code[c]?.startLine === i) { i = code[c++].endLine; continue; }
        if (tables[t]?.start === i) { i = tables[t++].end; continue; }
        if (!lines[i].includes('|')) points.push(i);
    }
    return points;
}

interface CachedLine {
    spans: LineSpan[];
    markers: [number, number][];
    headings: Omit<Heading, 'line'>[];
    images: Omit<ImageRef, 'line'>[];
}

// Hanya simpan baris dokumen saat ini, bukan seluruh riwayat suntingan. Cache
// berisi offset relatif; offset dan konteks blok dihitung ulang setelah teks bergeser.
export class HighlightCache {
    private snapshot: Parsed | null = null;
    parsedLines = 0;
    private previous = new Map<string, CachedLine>();
    private current = new Map<string, CachedLine>();
    private length = 0;

    update(buffer: Gtk.TextBuffer, tags: Tags, edited?: [number, number] | null): Parsed {
        const old = this.snapshot;
        this.parsedLines = 0;
        if (!old || edited === undefined) {
            const [start, end] = buffer.get_bounds();
            const result = parseLines(buffer.get_text(start, end, true).split('\n'), tags, this);
            this.parsedLines = result.lines.length;
            return this.snapshot = result;
        }
        if (!edited) return old;
        const [first, last] = edited;
        const shift = buffer.get_line_count() - old.lines.length;
        const afterOldEdit = last + 1 - shift;
        const from = buffer.get_iter_at_line(first);
        const to = last + 1 < buffer.get_line_count() ? buffer.get_iter_at_line(last + 1) : buffer.get_end_iter();
        const raw = buffer.get_text(from, to, true);
        const changed = (last + 1 < buffer.get_line_count() ? raw.slice(0, -1) : raw).split('\n');
        if (afterOldEdit < first || changed.length !== last - first + 1)
            return this.update(buffer, tags);  // delimiter yang tidak cocok dengan pemisahan baris JS
        const lines = [...old.lines.slice(0, first), ...changed, ...old.lines.slice(afterOldEdit)];
        const before = lowerBound(old.checkpoints, first);
        const startLine = before > 0 ? old.checkpoints[before - 1] : 0;
        const after = lowerBound(old.checkpoints, afterOldEdit);
        let endLine = old.checkpoints[after] ?? old.lines.length - 1;
        let part: Parsed;
        for (;;) {
            part = parseLines(lines.slice(startLine, endLine + shift + 1), tags, this);
            this.parsedLines += part.lines.length;
            if (endLine === old.lines.length - 1 || !part.codeBlocks.some(b => !b.closed)) break;
            // Fence baru bisa mengubah konteks sampai jauh ke bawah. Perluas secara
            // geometris supaya tidak mengurai ulang tiap paragraf satu per satu.
            const next = lowerBound(old.checkpoints, endLine + Math.max(16, endLine - startLine + 1));
            endLine = old.checkpoints[next] ?? old.lines.length - 1;
        }
        const afterOld = endLine + 1;
        const base = old.starts[startLine];
        const oldLength = (old.starts[afterOld] ?? old.characters) - base;
        const delta = part.characters + (afterOld < old.lines.length ? 1 : 0) - oldLength;
        const starts = [...old.starts.slice(0, startLine), ...part.starts.map(n => n + base),
            ...old.starts.slice(afterOld).map(n => n + delta)];
        const lineWords = [...old.lineWords.slice(0, startLine), ...part.lineWords, ...old.lineWords.slice(afterOld)];
        const oldWords = old.lineWords.slice(startLine, afterOld).reduce((a, b) => a + b, 0);
        let text: string | null = null;
        const result: Parsed = {
            get text() { return text ??= lines.join('\n'); },
            lines, starts, lineWords,
            words: old.words - oldWords + part.words,
            characters: old.characters + delta,
            spans: [...old.spans.slice(0, startLine), ...part.spans, ...old.spans.slice(afterOld)],
            checkpoints: [...old.checkpoints.slice(0, lowerBound(old.checkpoints, startLine)),
                ...part.checkpoints.map(n => n + startLine),
                ...old.checkpoints.slice(lowerBound(old.checkpoints, afterOld)).map(n => n + shift)],
            markers: [
                ...old.markers.filter(m => m[4] < startLine),
                ...part.markers.map(([a, b, first, last, line]): Marker => [a + base, b + base, first + startLine, last + startLine, line + startLine]),
                ...old.markers.filter(m => m[4] >= afterOld).map(([a, b, first, last, line]): Marker => [a + delta, b + delta, first + shift, last + shift, line + shift]),
            ],
            headings: [...old.headings.filter(h => h.line < startLine),
                ...part.headings.map(h => ({ ...h, line: h.line + startLine })),
                ...old.headings.filter(h => h.line >= afterOld).map(h => ({ ...h, line: h.line + shift }))],
            images: [...old.images.filter(img => img.line < startLine),
                ...part.images.map(img => ({ ...img, line: img.line + startLine })),
                ...old.images.filter(img => img.line >= afterOld).map(img => ({ ...img, line: img.line + shift }))],
            tables: [...old.tables.filter(t => t.end < startLine),
                ...part.tables.map(t => ({ start: t.start + startLine, end: t.end + startLine })),
                ...old.tables.filter(t => t.start >= afterOld).map(t => ({ start: t.start + shift, end: t.end + shift }))],
            codeBlocks: [...old.codeBlocks.filter(b => b.endLine < startLine),
                ...part.codeBlocks.map(b => ({ ...b, start: b.start + base, startLine: b.startLine + startLine, endLine: b.endLine + startLine })),
                ...old.codeBlocks.filter(b => b.startLine >= afterOld).map(b => ({ ...b, start: b.start + delta, startLine: b.startLine + shift, endLine: b.endLine + shift }))],
        };
        return this.snapshot = result;
    }

    begin(): void { this.current = new Map(); this.length = 0; }
    get(key: string): CachedLine | undefined { return this.current.get(key) ?? this.previous.get(key); }
    put(key: string, value: CachedLine): void {
        if (this.current.has(key) || key.length > 4096 || this.current.size >= 10000 || this.length + key.length > 4194304) return;
        this.current.set(key, value);
        this.length += key.length;
    }
    end(): void { this.previous = this.current; }
}

export function highlight(buffer: Gtk.TextBuffer, tags: Tags, tagger: LineTagger, cache?: HighlightCache, edited?: [number, number] | null): HighlightResult {
    const result = (cache ?? new HighlightCache()).update(buffer, tags, edited);
    tagger.apply(result.spans, result.starts);
    return result;
}

function parseLines(lines: string[], tags: Tags, cache: HighlightCache): Parsed {
    const text = lines.join('\n');
    // Semua posisi di bawah ini dalam UTF-16 (string JS); dikonversi saat menyentuh buffer.
    const toCp = makeCpMap(text);
    const spans: LineSpan[][] = lines.map(() => []);
    cache?.begin();
    const starts: number[] = [];
    // Setiap tag dipasang di baris yang sedang diproses (`row`, mulai offset `rowStart`).
    let row = 0, rowStart = 0;
    const apply = (name: TagName, a: number, b: number) => {
        if (b > a) spans[row].push([tags[name], toCp(a) - rowStart, toCp(b) - rowStart]);
    };
    const markers: Marker[] = [];
    const hide = (a: number, b: number, l0: number, l1: number, line = l0) => { if (b > a) markers.push([toCp(a), toCp(b), l0, l1, line]); };
    const headings: Heading[] = [];

    const images: ImageRef[] = [];

    // withImages = false untuk baris tabel: gambar di bawah baris tabel merusak tata letaknya.
    const inline = (base: number, s: string, line: number, withImages = true) => {
        const { tags: found, marks, images: imgs } = parseInline(s);
        for (const [n, a, b] of found) apply(n, base + a, base + b);
        for (const [a, b] of marks) hide(base + a, base + b, line, line);
        if (!withImages) return;
        for (const img of imgs) {
            images.push({ line, url: img.url, alt: img.alt });
            // Di baris yang tidak aktif, seluruh ![alt](url) disembunyikan
            // dan hanya gambarnya yang terlihat (lihat editor/images.ts).
            hide(base + img.start, base + img.end, line, line);
        }
    };

    // Tabel dikenali lebih dulu dari rentang parsing, supaya aturannya sama dengan
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
        row = i;
        rowStart = toCp(off);
        starts.push(rowStart);
        const nl = i < lines.length - 1 ? 1 : 0;
        let m: RegExpExecArray | null;

        // Di dalam blok kode: tidak ada format lain, cari pembatas penutup.
        if (fence) {
            m = RE.fence.exec(line);
            apply('codeblock', off, lineEnd + nl);
            if (m && m[2][0] === fence.ch && m[2].length >= fence.len && !m[3].trim()) {
                apply('fence', off, lineEnd);
                hide(fence.a, fence.b, fence.line, i);
                hide(off, lineEnd + nl, fence.line, i, i);
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
        const table = tableOf.get(i);
        const role = !table ? '' : i === table.start ? 'head' : i === table.start + 1 ? 'separator' : 'body';
        const key = `${nl}:${role}\0${line}`;
        const cached = cache?.get(key);
        if (cached) {
            spans[i] = cached.spans;
            for (const [a, b] of cached.markers) markers.push([rowStart + a, rowStart + b, i, i, i]);
            for (const h of cached.headings) headings.push({ ...h, line: i });
            for (const img of cached.images) images.push({ ...img, line: i });
            cache!.put(key, cached);
            continue;
        }
        const markerStart = markers.length, headingStart = headings.length, imageStart = images.length;
        const parseLine = () => {
            if ((m = RE.heading.exec(line))) {
                const lvl = m[1].length, pl = m[0].length;
                apply(`h${lvl}` as TagName, off, lineEnd);  // lvl selalu 1–6
                apply('marker', off, off + pl);
                hide(off, off + pl, i, i);
                inline(off + pl, line.slice(pl), i);
                headings.push({ level: lvl, text: line.slice(pl).replace(/\s+#+\s*$/, '').trim(), line: i });
                return;
            }
            if (RE.hr.test(line)) { apply('hr', off, lineEnd); return; }
            if (table) {
                apply('table', off, lineEnd);
                if (i === table.start) apply('tablehead', off, lineEnd);
                else if (i === table.start + 1 && isTableSeparator(line)) apply('tablesep', off, lineEnd);
                for (let k = 0; k < line.length; k++) if (line[k] === '|') apply('marker', off + k, off + k + 1);
                inline(off, line, i, false);
                return;
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
                return;
            }
            inline(off + p, rest, i);
        };
        parseLine();
        cache?.put(key, {
            spans: spans[i],
            markers: markers.slice(markerStart).map(([a, b]) => [a - rowStart, b - rowStart]),
            headings: headings.slice(headingStart).map(({ level, text }) => ({ level, text })),
            images: images.slice(imageStart).map(({ url, alt }) => ({ url, alt })),
        });
    }
    if (fence) {
        hide(fence.a, fence.b, fence.line, lines.length - 1);
        closeBlock(fence, lines.length);  // blok yang belum ditutup berlanjut sampai akhir dokumen
    }

    cache?.end();
    const lineWords = lines.map(line => (line.match(/[^\s#>*_`~=|-]+/g) ?? []).length);
    return { text, lines, markers, headings, images, codeBlocks, tables, starts, spans, lineWords,
        words: lineWords.reduce((a, b) => a + b, 0), characters: cpLength(text),
        checkpoints: checkpoints(lines, codeBlocks, tables) };
}
