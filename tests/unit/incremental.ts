// Parser berdasarkan rentang suntingan dibandingkan dengan parsing penuh independen.
import Gtk from 'gi://Gtk?version=4.0';
import { HighlightCache, highlight, type HighlightResult } from '../../src/editor/highlighter.js';
import { createTags, SYNTAX_TAGS } from '../../src/editor/tags.js';
import { LineTagger, tagRanges } from '../../src/editor/tagsync.js';
import { cpLength } from '../../src/editor/offsets.js';
import { section, test, eq, ok } from '../framework.js';
import { iterAtLine } from '../../src/gtkutil.js';

export function incrementalTests(): void {
    section('Parsing rentang suntingan');
    const buffer = new Gtk.TextBuffer();
    const tags = createTags(buffer);
    const tagger = new LineTagger(buffer, SYNTAX_TAGS.map(n => tags[n]));
    const cache = new HighlightCache();
    const start = buffer.create_mark(null, buffer.get_start_iter(), true);
    const end = buffer.create_mark(null, buffer.get_start_iter(), false);
    let dirty = false;
    const mark = (a: Gtk.TextIter, b: Gtk.TextIter) => {
        if (!dirty || a.compare(buffer.get_iter_at_mark(start)) < 0) buffer.move_mark(start, a);
        if (!dirty || b.compare(buffer.get_iter_at_mark(end)) > 0) buffer.move_mark(end, b);
        dirty = true;
    };
    buffer.connect_after('insert-text', (_buf, b, text) => {
        const a = b.copy(); a.backward_chars(cpLength(text)); mark(a, b);
    });
    buffer.connect_after('delete-range', (_buf, a) => mark(a, a));
    const text = () => { const [a, b] = buffer.get_bounds(); return buffer.get_text(a, b, true); };
    const reset = (source: string): HighlightResult => {
        buffer.set_text(source, -1);
        tagger.edited(0, buffer.get_line_count() - 1, buffer.get_line_count());
        dirty = false;
        return highlight(buffer, tags, tagger, cache);
    };
    const flush = (): HighlightResult => {
        const first = buffer.get_iter_at_mark(start).get_line(), last = buffer.get_iter_at_mark(end).get_line();
        if (dirty) tagger.edited(first, last, buffer.get_line_count());
        const result = highlight(buffer, tags, tagger, cache, dirty ? [first, last] : null);
        dirty = false;
        return result;
    };
    const reference = new Gtk.TextBuffer();
    const refTags = createTags(reference);
    const check = (result: HighlightResult) => {
        reference.set_text(text(), -1);
        const fresh = highlight(reference, refTags, new LineTagger(reference, SYNTAX_TAGS.map(n => refTags[n])));
        for (const field of ['text', 'lines', 'starts', 'markers', 'headings', 'tables', 'codeBlocks', 'words', 'characters'] as const)
            eq(result[field], fresh[field], `hasil ${field}`);
        const imageFields = (r: HighlightResult) => r.images.map(img => [img.line, img.url, img.alt]);
        eq(imageFields(result), imageFields(fresh), 'hasil images');
        for (const name of SYNTAX_TAGS)
            eq(tagRanges(buffer, tags[name]), tagRanges(reference, refTags[name]), `tag ${name}`);
    };
    test('perubahan fence, tabel, emoji, dan beberapa suntingan sebelum flush tetap setara', () => {
        reset('# Awal\n\nparagraf **tebal** 😀\n\nA | B\n-- | --\nx | y\n\n```js\nconst x = 1;\n```\n\nakhir');
        const insert = (line: number, value: string) => { buffer.insert(iterAtLine(buffer, line), value, -1); check(flush()); };
        insert(2, '```\n');
        insert(7, '```\n');
        insert(0, '🎉\n');
        buffer.delete(iterAtLine(buffer, 1), iterAtLine(buffer, 4)); check(flush());
        buffer.insert(buffer.get_start_iter(), 'baru\n', -1);
        buffer.insert(buffer.get_end_iter(), '\n![gambar](a.png)', -1); check(flush());
        reset('A | B\nx | y\nakhir');
        insert(1, '-- | --\n');  // pemisah baru mengubah baris sebelumnya menjadi judul tabel
        reset('teks\n```\na\n\nb\n\nc\n```\nakhir');
        buffer.delete(iterAtLine(buffer, 1), iterAtLine(buffer, 2)); check(flush());
    });
    test('200 rangkaian suntingan acak sama dengan parsing penuh', () => {
        reset('# Judul\n\n**tebal** dan `kode` 🎉\n\nA | B\n-- | --\nx | y\n\n```ts\nconst x = 1;\n```\n\nakhir\n');
        let seed = 17;
        const rand = (n: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
        const pieces = ['x', '\n', '**', '```\n', '~~~\n', '| a |', '# ', '> ', '😀', '\n\n', '![g](a.png)'];
        for (let round = 0; round < 200; round++) {
            for (let i = 0; i < 1 + rand(4); i++) {
                const at = buffer.get_iter_at_offset(rand(buffer.get_char_count() + 1));
                if (rand(3) === 0) {
                    const to = at.copy(); to.forward_chars(1 + rand(20)); buffer.delete(at, to);
                } else buffer.insert(at, pieces[rand(pieces.length)], -1);
            }
            check(flush());
        }
    });
    test('satu suntingan pada 50.000 baris hanya mengurai tetangganya tanpa membaca buffer penuh', () => {
        reset(Array.from({ length: 50000 }, (_, i) => `Paragraf ${i} dengan catatan yang berbeda.`).join('\n'));
        const read = buffer.get_text.bind(buffer);
        const reads: number[] = [];
        buffer.get_text = (a, b, hidden) => { reads.push(b.get_offset() - a.get_offset()); return read(a, b, hidden); };
        try {
            buffer.insert(iterAtLine(buffer, 25000), '😀 tambahan ', -1);
            const result = flush();
            ok(cache.parsedLines <= 4, `mengurai ${cache.parsedLines} baris`);
            ok(reads.length === 1 && reads[0] < 100, `rentang baca ${JSON.stringify(reads)}`);
            eq(result.characters, buffer.get_char_count(), 'jumlah karakter');
            eq(result.words, (result.text.match(/[^\s#>*_`~=|-]+/g) ?? []).length, 'jumlah kata');
            flush(); eq(cache.parsedLines, 0, 'tanpa suntingan tidak mengurai ulang');
        } finally { buffer.get_text = read; }
    });
}
