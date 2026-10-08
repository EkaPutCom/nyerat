// Inline format parser (within one line): code, links, bold, italic, etc.
//
// The "masking" technique: once a part is recognized, its characters are replaced with '\0' in a
// copy of the string, so later patterns cannot recognize it again. Recognition order:
// escapes (\*) and inline code → [[wikilink]] → links/images → URLs → emphasis.
// Example: in `**x**` the ** part is already masked as code, so it does not become bold.
//
// Result: tags [name, start, end], marks [start, end] (syntax that may be
// hidden), and images [{ alt, url, start, end }].
// Positions are in UTF-16 units and relative to the start of the string.

import { EMPHASIS, ESCAPE_OR_CODE, type InlineTag } from './syntax.js';
import { WIKILINK } from './wikilink.js';

export interface InlineImage {
    alt: string;
    url: string;
    start: number;
    end: number;
}

export interface InlineResult {
    tags: [InlineTag, number, number][];
    marks: [number, number][];
    images: InlineImage[];
}

// Parses the inline formatting of one line. Result: tags [name, start, end] and
// "marker" ranges (syntax hidden while the cursor is on another line).
export function parseInline(s: string): InlineResult {
    const tags: InlineResult['tags'] = [], marks: InlineResult['marks'] = [], images: InlineImage[] = [];
    // A line without syntax needs no character copy. After masking, rebuild
    // the string only if a new part was closed by an earlier stage.
    let m: string[] | null = null;
    let current = s, changed = false;
    const mask = (a: number, b: number) => {
        m ??= s.split('');
        for (let i = a; i < b; i++) m[i] = '\0';
        changed = true;
    };
    const cur = () => {
        if (changed) { current = m!.join(''); changed = false; }
        return current;
    };
    const mark = (a: number, b: number) => { if (b > a) { marks.push([a, b]); tags.push(['marker', a, b]); } };
    let r: RegExpExecArray | null, t: string;

    const reEscCode = ESCAPE_OR_CODE();
    while ((r = reEscCode.exec(s))) {
        const a = r.index, b = a + r[0].length;
        if (r[1] !== undefined) {           // \* → hide the backslash
            mark(a, a + 1);
        } else {                            // `code`
            const n = r[2].length;
            tags.push(['code', a + n, b - n]); mark(a, a + n); mark(b - n, b);
        }
        mask(a, b);
    }

    // [[Note]] and [[Note|text]]: only the note name is visible, or the text when there is an alias.
    t = cur();
    if (t.includes('[[')) {
        const reWiki = WIKILINK();
        while ((r = reWiki.exec(t))) {
            const a = r.index, b = a + r[0].length;
            const ts = r[2] === undefined || !r[2].trim() ? a + 2 : a + 3 + r[1].length;
            if (!r[1].trim() || b - 2 <= ts) continue;
            tags.push(['link', ts, b - 2]);
            mark(a, ts); mark(b - 2, b); mask(a, b);
        }
    }

    t = cur();
    const reLink = /(!?)\[([^\]\0]*)\]\(([^)\0]*)\)/g;
    while ((r = reLink.exec(t))) {
        const a = r.index, b = a + r[0].length;
        const ts = a + r[1].length + 1, te = ts + r[2].length;
        tags.push([r[1] ? 'image' : 'link', ts, te]);
        mark(a, ts); mark(te, b); mask(a, ts); mask(te, b);
        // Image: url without the optional title, e.g. ![alt](photo.png "Title")
        if (r[1]) images.push({ alt: r[2], url: r[3].trim().split(/\s+/)[0] ?? '', start: a, end: b });
    }

    t = cur();
    const reAuto = /<((?:https?|mailto|ftp):[^\s>\0]+)>/g;
    while ((r = reAuto.exec(t))) {
        const a = r.index, b = a + r[0].length;
        tags.push(['link', a + 1, b - 1]); mark(a, a + 1); mark(b - 1, b); mask(a, b);
    }

    t = cur();
    const reUrl = /\bhttps?:\/\/[^\s<>\0]*[^\s<>\0.,;:!?)\]'"]/g;
    while ((r = reUrl.exec(t))) { tags.push(['link', r.index, r.index + r[0].length]); mask(r.index, r.index + r[0].length); }

    for (const [name, re, n] of EMPHASIS) {
        t = cur();
        re.lastIndex = 0;
        while ((r = re.exec(t))) {
            const a = r.index, b = a + r[0].length;
            tags.push([name, a + n, b - n]);
            mark(a, a + n); mark(b - n, b); mask(a, a + n); mask(b - n, b);
        }
    }
    return { tags, marks, images };
}
