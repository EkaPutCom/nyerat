// Turns the assistant's Markdown answers into Pango markup for Gtk.Label: headings, lists, quotes,
// code blocks, and inline formatting (through cellMarkup). Pure TypeScript without GTK.
// Called repeatedly while an answer streams in, so it tolerates text cut off in the middle
// (an unclosed code block is still treated as code until the end of the text).

import { cellMarkup, escapeMarkup, type MarkupColors } from './pango.js';

const FENCE = /^\s*(```|~~~)/;

export function chatMarkup(text: string, colors: MarkupColors): string {
    const out: string[] = [];
    let fenced = false;
    for (const line of text.replace(/\r/g, '').split('\n')) {
        if (FENCE.test(line)) {
            fenced = !fenced;
            continue;
        }
        if (fenced) {
            out.push(`<span font_family="monospace" foreground="${colors.code}" background="${colors.codeBg}">${escapeMarkup(line) || ' '}</span>`);
            continue;
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
            const size = heading[1].length <= 2 ? 'larger' : 'medium';
            out.push(`<span font_weight="bold" size="${size}">${cellMarkup(heading[2], colors)}</span>`);
            continue;
        }
        const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
        if (bullet) {
            out.push(`${'    '.repeat(Math.floor(bullet[1].length / 2))}•  ${cellMarkup(bullet[2], colors)}`);
            continue;
        }
        const quote = /^\s*>\s?(.*)$/.exec(line);
        if (quote) {
            out.push(`<span foreground="${colors.link}">▎</span> <span font_style="italic">${cellMarkup(quote[1], colors)}</span>`);
            continue;
        }
        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
            out.push('──────');
            continue;
        }
        out.push(cellMarkup(line, colors));
    }
    return out.join('\n');
}
