// Mengubah teks Markdown inline (isi sel tabel) menjadi markup Pango untuk Gtk.Label:
// **tebal**, *miring*, ~~coret~~, ==stabilo==, `kode`, dan [tautan](url).
// Tanda Markdown-nya sendiri dibuang. Murni TypeScript tanpa GTK.

import { parseInline } from './inline.js';

export interface MarkupColors {
    code: string;
    codeBg: string;
    link: string;
    mark: string;
}

const BOLD = 1, ITALIC = 2, STRIKE = 4, CODE = 8, LINK = 16, MARK = 32, HIDDEN = 64;

const FLAG_OF = {
    bold: BOLD, italic: ITALIC, bolditalic: BOLD | ITALIC, strike: STRIKE, mark: MARK,
    code: CODE, link: LINK, image: ITALIC | LINK, marker: HIDDEN,
} as const;

export const escapeMarkup = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function attributes(flags: number, colors: MarkupColors): string {
    const attrs: string[] = [];
    if (flags & BOLD) attrs.push('font_weight="bold"');
    if (flags & ITALIC) attrs.push('font_style="italic"');
    if (flags & STRIKE) attrs.push('strikethrough="true"');
    if (flags & CODE) attrs.push(`font_family="monospace" foreground="${colors.code}" background="${colors.codeBg}"`);
    if (flags & LINK) attrs.push(`foreground="${colors.link}" underline="single"`);
    if (flags & MARK) attrs.push(`background="${colors.mark}"`);
    return attrs.join(' ');
}

export function cellMarkup(text: string, colors: MarkupColors): string {
    // Satu penanda gaya per unit UTF-16; gaya yang bertumpuk (tebal di dalam miring) digabung.
    const flags = new Uint8Array(text.length);
    for (const [name, a, b] of parseInline(text).tags)
        for (let i = a; i < b; i++) flags[i] |= FLAG_OF[name];

    let out = '';
    for (let i = 0; i < text.length;) {
        let j = i;
        while (j < text.length && flags[j] === flags[i]) j++;
        if (!(flags[i] & HIDDEN)) {
            const attrs = attributes(flags[i], colors);
            const piece = escapeMarkup(text.slice(i, j));
            out += attrs ? `<span ${attrs}>${piece}</span>` : piece;
        }
        i = j;
    }
    return out;
}
