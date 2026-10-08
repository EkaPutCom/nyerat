// Syntax highlighter: parses the edited range until the block boundary is stable again,
// then applies style tags. It also collects:
//
//   markers   ranges of syntax that may be hidden, together with the lines where
//             that syntax is "active": [start, end, firstLine, lastLine, line]
//             (offsets in code points; line = where the marker is). For
//             code blocks, the line range is the whole block, so the ``` fences
//             show up while the cursor is inside the block.
//   headings  list of headings for the outline: { level, text, line }
//   lines     document contents per line
//   images    images to display: { line, url, alt }
//   codeBlocks contents of code blocks together with their language, to be colored (see codehighlight.ts)
//   tables    line range of each table, to be rendered as a grid (see tablelayer.ts)
//   starts    offset (code point) of the start of each line
//   reparsed  line ranges that were re-parsed (other lines gave the same result as before)
//   spans     syntax tags per line, for LineTagger
//
// Tags are applied through LineTagger (tagsync.ts), so only changed lines are touched.

import type Gtk from 'gi://Gtk?version=4.0';
import { RE, isTableSeparator } from '../markdown/syntax.js';
import { findTables, type TableRange } from '../markdown/table.js';
import { parseInline } from '../markdown/inline.js';
import { makeCpMap, cpLength, countWords } from './offsets.js';
import { type TagName, type Tags } from './tags.js';
import type { LineSpan, LineTagger } from './tagsync.js';
import { iterAtLine } from '../gtkutil.js';
import { listIndentFor } from './listindent.js';

// Syntax that may be hidden: [start, end, firstLine, lastLine, line].
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
    lang: string;     // text after ``` (e.g. "js"); '' if none
    start: number;    // offset (code point) of the start of the block contents in the buffer
    text: string;     // block contents without the fence lines
    startLine: number;  // opening fence line
    endLine: number;    // closing fence line (the last line of the document if not closed)
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
    reparsed: [first: number, last: number];
    spans: LineSpan[][];   // syntax tags per line (offsets relative to the start of the line)
}

interface Parsed extends HighlightResult {
    checkpoints: number[];
    lineWords: number[];
}

// First index with key(item) >= value in an array sorted by key.
const lowerBoundBy = <T>(items: T[], value: number, key: (item: T) => number): number => {
    let a = 0, b = items.length;
    while (a < b) { const mid = (a + b) >>> 1; if (key(items[mid]) < value) a = mid + 1; else b = mid; }
    return a;
};
const lowerBound = (items: number[], value: number): number => lowerBoundBy(items, value, n => n);

// Like splice() for a list sorted by `line`: items before line `from` stay,
// items from line `to` onward are shifted by `shift` lines in place (the old snapshot is no longer used).
function spliceByLine<T extends { line: number }>(old: T[], from: number, to: number, shift: number, mid: T[]): T[] {
    const tail = lowerBoundBy(old, to, item => item.line);
    if (shift) for (let i = tail; i < old.length; i++) old[i].line += shift;
    return splice(old, lowerBoundBy(old, from, item => item.line), tail, mid);
}

// old[0..from) + mid + old[to..) (optionally changed with tail), copied once into a new array.
// Called on every keystroke for document-sized arrays; spread/slice/map would create several
// intermediate copies that burden the GC.
function splice<T>(old: T[], from: number, to: number, mid: T[], tail?: (item: T) => T): T[] {
    const out = new Array<T>(from + mid.length + Math.max(0, old.length - to));
    let k = 0;
    for (let i = 0; i < from; i++) out[k++] = old[i];
    for (let i = 0; i < mid.length; i++) out[k++] = mid[i];
    if (tail) for (let i = to; i < old.length; i++) out[k++] = tail(old[i]);
    else for (let i = to; i < old.length; i++) out[k++] = old[i];
    return out;
}

// A line outside code/tables without a pipe is a neutral boundary. It cannot
// become a table header/continuation. A new fence may extend the parsing range.
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

// Only keep the lines of the current document, not the whole edit history. The cache
// holds relative offsets; offsets and block context are recomputed after the text shifts.
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
        const from = iterAtLine(buffer, first);
        const to = last + 1 < buffer.get_line_count() ? iterAtLine(buffer, last + 1) : buffer.get_end_iter();
        const raw = buffer.get_text(from, to, true);
        const changed = (last + 1 < buffer.get_line_count() ? raw.slice(0, -1) : raw).split('\n');
        if (afterOldEdit < first || changed.length !== last - first + 1)
            return this.update(buffer, tags);  // delimiter that does not match the JS line splitting
        const lines = splice(old.lines, first, afterOldEdit, changed);
        const before = lowerBound(old.checkpoints, first);
        const startLine = before > 0 ? old.checkpoints[before - 1] : 0;
        const after = lowerBound(old.checkpoints, afterOldEdit);
        let endLine = old.checkpoints[after] ?? old.lines.length - 1;
        let part: Parsed;
        for (;;) {
            part = parseLines(lines.slice(startLine, endLine + shift + 1), tags, this);
            this.parsedLines += part.lines.length;
            if (endLine === old.lines.length - 1 || !part.codeBlocks.some(b => !b.closed)) break;
            // A new fence can change the context far below. Expand
            // geometrically so paragraphs are not re-parsed one by one.
            const next = lowerBound(old.checkpoints, endLine + Math.max(16, endLine - startLine + 1));
            endLine = old.checkpoints[next] ?? old.lines.length - 1;
        }
        const afterOld = endLine + 1;
        const base = old.starts[startLine];
        const oldLength = (old.starts[afterOld] ?? old.characters) - base;
        const delta = part.characters + (afterOld < old.lines.length ? 1 : 0) - oldLength;
        const starts = splice(old.starts, startLine, afterOld, part.starts.map(n => n + base), n => n + delta);
        const lineWords = splice(old.lineWords, startLine, afterOld, part.lineWords);
        let oldWords = 0;
        for (let i = startLine; i < afterOld; i++) oldWords += old.lineWords[i];
        // Markers are ordered by their line, so the old section boundary is found with a binary search.
        // Markers after the parsed section are shifted in place: the old snapshot is no longer used
        // and a long document can have tens of thousands of markers.
        const markerAt = (line: number) => lowerBoundBy(old.markers, line, m => m[4]);
        const markerTail = markerAt(afterOld);
        if (delta || shift) {
            for (let i = markerTail; i < old.markers.length; i++) {
                const m = old.markers[i];
                m[0] += delta; m[1] += delta; m[2] += shift; m[3] += shift; m[4] += shift;
            }
        }
        let text: string | null = null;
        const result: Parsed = {
            get text() { return text ??= lines.join('\n'); },
            lines, starts, lineWords, reparsed: [startLine, endLine + shift],
            words: old.words - oldWords + part.words,
            characters: old.characters + delta,
            spans: splice(old.spans, startLine, afterOld, part.spans),
            checkpoints: splice(old.checkpoints, lowerBound(old.checkpoints, startLine), lowerBound(old.checkpoints, afterOld),
                part.checkpoints.map(n => n + startLine), n => n + shift),
            markers: splice(old.markers, markerAt(startLine), markerTail,
                part.markers.map(([a, b, first, last, line]): Marker => [a + base, b + base, first + startLine, last + startLine, line + startLine])),
            headings: spliceByLine(old.headings, startLine, afterOld, shift, part.headings.map(h => ({ ...h, line: h.line + startLine }))),
            images: spliceByLine(old.images, startLine, afterOld, shift, part.images.map(img => ({ ...img, line: img.line + startLine }))),
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
    // All positions below are in UTF-16 (JS strings); converted when touching the buffer.
    const toCp = makeCpMap(text);
    const spans: LineSpan[][] = lines.map(() => []);
    cache?.begin();
    const starts: number[] = [];
    // Each tag is applied on the line being processed (`row`, starting at offset `rowStart`).
    let row = 0, rowStart = 0;
    const apply = (name: TagName, a: number, b: number) => {
        if (b > a) spans[row].push([tags[name], toCp(a) - rowStart, toCp(b) - rowStart]);
    };
    const markers: Marker[] = [];
    const hide = (a: number, b: number, l0: number, l1: number, line = l0) => { if (b > a) markers.push([toCp(a), toCp(b), l0, l1, line]); };
    const headings: Heading[] = [];

    const images: ImageRef[] = [];

    // withImages = false for table rows: an image below a table row breaks its layout.
    const inline = (base: number, s: string, line: number, withImages = true) => {
        const { tags: found, marks, images: imgs } = parseInline(s);
        for (const [n, a, b] of found) apply(n, base + a, base + b);
        for (const [a, b] of marks) hide(base + a, base + b, line, line);
        if (!withImages) return;
        for (const img of imgs) {
            images.push({ line, url: img.url, alt: img.alt });
            // On an inactive line, the whole ![alt](url) is hidden
            // and only the image is visible (see editor/images.ts).
            hide(base + img.start, base + img.end, line, line);
        }
    };

    // Tables are recognized first from the parsing range, so the rules are the same as
    // those used by the edit commands and HTML export (markdown/table.ts).
    const tables = findTables(lines);
    const tableOf = new Map<number, TableRange>();
    for (const t of tables) for (let l = t.start; l <= t.end; l++) tableOf.set(l, t);

    let off = 0;
    let fence: { line: number; ch: string; len: number; a: number; b: number; lang: string } | null = null;
    const codeBlocks: CodeBlock[] = [];
    // The code block ends at line lastLine (exclusive): record its contents.
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

        // Inside a code block: no other formatting, look for the closing fence.
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
                apply(`h${lvl}` as TagName, off, lineEnd);  // lvl is always 1–6
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

            // Quote, may be followed by a list: "> - item"
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
                // Continuation lines (from wrapping) line up with the item text. In a quote
                // the left margin is already set by the quote tag, so it is skipped.
                const hanging = p === 0 ? listIndentFor(tags) : undefined;
                if (hanging && lineEnd > off) {
                    const tag = hanging.tag(m[1], m[2], m[3], m[4]?.slice(0, 3) ?? '', m[4]?.slice(3) ?? '');
                    spans[row].push([tag, 0, toCp(lineEnd) - rowStart]);
                }
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
        closeBlock(fence, lines.length);  // an unclosed block continues to the end of the document
    }

    cache?.end();
    const lineWords = lines.map(countWords);
    return { text, lines, markers, headings, images, codeBlocks, tables, starts, spans, lineWords, reparsed: [0, lines.length - 1],
        words: lineWords.reduce((a, b) => a + b, 0), characters: cpLength(text),
        checkpoints: checkpoints(lines, codeBlocks, tables) };
}
