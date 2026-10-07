// Mewarnai isi blok kode sesuai bahasanya (```js, ```python, ...).
//
// Pewarnaannya dikerjakan GtkSourceView sendiri, yang sudah punya definisi untuk
// ratusan bahasa dan beberapa skema warna:
//
//   1. Isi blok disalin ke GtkSource.Buffer tersembunyi (satu per bahasa) yang
//      bahasanya sudah diset, lalu ensure_highlight() menyorotinya saat itu juga.
//   2. Tag hasil sorotan dibaca rentang demi rentang, lalu gayanya (warna, tebal,
//      miring, ...) diringkas menjadi "segmen".
//   3. Setiap gaya yang berbeda mendapat satu tag "syntax:..." di buffer editor,
//      dan segmen dipasang dengan tag itu.
//
// Segmen disimpan di cache per (skema, bahasa, isi blok). Mengetik di luar blok
// kode, atau di blok lain, tidak membuat blok ini disorot ulang.

import Gtk from 'gi://Gtk?version=4.0';
import GtkSource from 'gi://GtkSource?version=5';
import Pango from 'gi://Pango';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import type { CodeBlock } from './highlighter.js';
import { setTagGroup, type Range } from './tagsync.js';

const CACHE_LIMIT = 300;  // jumlah blok yang disimpan; cache dikosongkan jika lebih

// Nama bahasa yang lazim ditulis setelah ``` → id bahasa GtkSourceView.
// Nama lain dicoba langsung sebagai id, lalu sebagai ekstensi file (rs, kt, ...).
const ALIASES: Record<string, string> = {
    javascript: 'js', mjs: 'js', cjs: 'js', node: 'js',
    ts: 'typescript', tsx: 'typescript-jsx',
    py: 'python3', python: 'python3', py3: 'python3',
    bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', shellscript: 'sh',
    'c++': 'cpp', cxx: 'cpp', hpp: 'cpp', h: 'c',
    'c#': 'c-sharp', cs: 'c-sharp', csharp: 'c-sharp',
    golang: 'go', rs: 'rust', rb: 'ruby', kt: 'kotlin',
    yml: 'yaml', md: 'markdown', svg: 'xml', jsonc: 'json', json5: 'json',
    htm: 'html', vue: 'html', patch: 'diff', make: 'makefile',
};

export function resolveLanguage(name: string): GtkSource.Language | null {
    if (!name) return null;
    const manager = GtkSource.LanguageManager.get_default();
    const id = name.toLowerCase();
    return manager.get_language(ALIASES[id] ?? id) ?? manager.guess_language(`berkas.${id}`, null);
}

// Rentang bergaya di dalam satu blok: [awal, akhir, kunci gaya] (offset code point).
type Segment = [start: number, end: number, style: string];

// Gaya yang disalin dari tag GtkSourceView. Latar belakang sengaja tidak disalin,
// supaya blok kode tetap memakai latar dari tema aplikasi.
interface Style {
    foreground?: string;
    weight?: Pango.Weight;
    style?: Pango.Style;
    underline?: Pango.Underline;
    strikethrough?: boolean;
}

function styleOf(tags: Gtk.TextTag[]): Style {
    const style: Style = {};
    // Tag dengan prioritas lebih tinggi menimpa yang lebih rendah.
    for (const tag of [...tags].sort((a, b) => a.get_priority() - b.get_priority())) {
        if (tag.foreground_set && tag.foreground_rgba) style.foreground = tag.foreground_rgba.to_string() ?? undefined;
        if (tag.weight_set) style.weight = tag.weight;
        if (tag.style_set) style.style = tag.style;
        if (tag.underline_set) style.underline = tag.underline;
        if (tag.strikethrough_set) style.strikethrough = tag.strikethrough;
    }
    return style;
}

const UNDERLINES = ['none', 'single', 'double', 'low', 'error'];

function spanAttributes(style: Style): string {
    let attrs = '';
    if (style.foreground) {
        const color = new Gdk.RGBA();
        if (color.parse(style.foreground)) {
            const hex = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
            attrs += ` foreground="#${hex(color.red)}${hex(color.green)}${hex(color.blue)}"`;
        }
    }
    if (style.weight !== undefined) attrs += ` weight="${style.weight}"`;
    if (style.style === Pango.Style.ITALIC) attrs += ' style="italic"';
    else if (style.style === Pango.Style.OBLIQUE) attrs += ' style="oblique"';
    if (style.underline) attrs += ` underline="${UNDERLINES[style.underline] ?? 'single'}"`;
    if (style.strikethrough) attrs += ' strikethrough="true"';
    return attrs;
}

export class CodeHighlighter {
    // Dipanggil setiap tag gaya baru dibuat, supaya pemanggil bisa menaikkan
    // prioritas tag yang harus tetap di atas (misalnya 'dim' dan 'hidden').
    onTagAdded: () => void = () => {};

    private applied: CodeBlock[] | null = null;
    private scheme: GtkSource.StyleScheme | null = null;
    private scratch = new Map<string, GtkSource.Buffer>();   // id bahasa → buffer tersembunyi
    private cache = new Map<string, Segment[]>();
    private styleTags = new Map<string, Gtk.TextTag>();      // kunci gaya → tag

    constructor(private readonly buffer: Gtk.TextBuffer) {}

    // Ganti skema warna (dipanggil saat tema terang/gelap berubah).
    setScheme(id: string): void {
        const scheme = GtkSource.StyleSchemeManager.get_default().get_scheme(id);
        if (scheme === this.scheme) return;
        this.scheme = scheme;
        for (const scratch of this.scratch.values()) scratch.set_style_scheme(scheme);
        this.applied = null;
        this.cache.clear();
        // Tag lama memakai warna skema lama; buang dari buffer.
        const table = this.buffer.get_tag_table();
        for (const tag of this.styleTags.values()) table.remove(tag);
        this.styleTags.clear();
    }

    // Warnai semua blok kode. Dipanggil setelah highlighter.ts selesai.
    apply(blocks: CodeBlock[], force = true): void {
        // GTK mempertahankan tag saat teks di luar blok berubah. Hindari membaca
        // semua rentang tag lagi jika isi blok tetap sama, meski offset bergeser.
        if (!force && this.applied && blocks.length === this.applied.length && blocks.every((b, i) => {
            const old = this.applied![i];
            return b.lang === old.lang && b.text === old.text;
        })) return;
        this.applied = blocks;

        const wanted = new Map<Gtk.TextTag, Range[]>();
        for (const block of blocks) {
            const language = resolveLanguage(block.lang);
            if (!language || !block.text) continue;
            for (const [a, b, key] of this.segments(language, block.text)) {
                const tag = this.styleTag(key);
                if (!wanted.has(tag)) wanted.set(tag, []);
                wanted.get(tag)!.push([block.start + a, block.start + b]);
            }
        }
        setTagGroup(this.buffer, this.styleTags.values(), wanted);
    }

    // Isi blok sebagai markup Pango berwarna, untuk blok kode yang dirender sebagai widget
    // (codelayer.ts). Memakai segmen dan cache yang sama dengan apply().
    markup(lang: string, code: string): string {
        const chars = Array.from(code);
        const text = (a: number, b: number) => GLib.markup_escape_text(chars.slice(a, b).join(''), -1);
        const language = resolveLanguage(lang);
        let out = '', pos = 0;
        for (const [a, b, key] of language ? this.segments(language, code) : []) {
            if (a < pos) continue;
            out += text(pos, a);
            out += `<span${spanAttributes(JSON.parse(key) as Style)}>${text(a, b)}</span>`;
            pos = b;
        }
        return out + text(pos, chars.length);
    }

    private segments(language: GtkSource.Language, code: string): Segment[] {
        const cacheKey = `${this.scheme?.get_id()}\0${language.get_id()}\0${code}`;
        const cached = this.cache.get(cacheKey);
        if (cached) return cached;

        const scratch = this.scratchBuffer(language);
        scratch.set_text(code, -1);
        const [start, end] = scratch.get_bounds();
        scratch.ensure_highlight(start, end);

        const segments: Segment[] = [];
        const iter = scratch.get_start_iter();
        while (!iter.is_end()) {
            const from = iter.get_offset();
            const tags = iter.get_tags();
            iter.forward_to_tag_toggle(null);
            if (!tags.length) continue;
            const key = JSON.stringify(styleOf(tags));
            if (key === '{}') continue;
            const last = segments[segments.length - 1];
            if (last && last[1] === from && last[2] === key) last[1] = iter.get_offset();  // gabungkan yang bersambung
            else segments.push([from, iter.get_offset(), key]);
        }

        if (this.cache.size >= CACHE_LIMIT) this.cache.clear();
        this.cache.set(cacheKey, segments);
        return segments;
    }

    private scratchBuffer(language: GtkSource.Language): GtkSource.Buffer {
        let scratch = this.scratch.get(language.get_id());
        if (!scratch) {
            scratch = new GtkSource.Buffer({ language, highlight_syntax: true });
            scratch.set_style_scheme(this.scheme);
            this.scratch.set(language.get_id(), scratch);
        }
        return scratch;
    }

    private styleTag(key: string): Gtk.TextTag {
        let tag = this.styleTags.get(key);
        if (!tag) {
            const style = JSON.parse(key) as Style;
            tag = new Gtk.TextTag({ name: `syntax:${key}` });
            if (style.foreground) tag.foreground = style.foreground;
            if (style.weight !== undefined) tag.weight = style.weight;
            if (style.style !== undefined) tag.style = style.style;
            if (style.underline !== undefined) tag.underline = style.underline;
            if (style.strikethrough !== undefined) tag.strikethrough = style.strikethrough;
            this.buffer.get_tag_table().add(tag);
            this.styleTags.set(key, tag);
            this.onTagAdded();
        }
        return tag;
    }
}
