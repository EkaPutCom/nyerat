// Tag GtkTextTag = "gaya" yang ditempel ke rentang teks (tebal, heading, kode, ...).
//
// Urutan di TAG_DEFS menentukan prioritas: tag yang dibuat belakangan menang jika
// dua tag mengatur properti yang sama. Karena itu 'marker', 'dim', dan 'hidden'
// ada di akhir.

import Gtk from 'gi://Gtk?version=3.0';
import Pango from 'gi://Pango';
import { FONT_MONO } from '../config.js';
import type { Palette } from '../ui/theme.js';

const W = Pango.Weight, S = Pango.Style;

const TAG_DEFS = {
    // Hasil penyorotan sintaks (dipasang ulang setiap teks berubah)
    h1: { scale: 2.0, weight: W.ULTRABOLD, pixels_above_lines: 22, pixels_below_lines: 10 },
    h2: { scale: 1.6, weight: W.BOLD, pixels_above_lines: 18, pixels_below_lines: 8 },
    h3: { scale: 1.35, weight: W.BOLD, pixels_above_lines: 14, pixels_below_lines: 6 },
    h4: { scale: 1.2, weight: W.BOLD, pixels_above_lines: 12, pixels_below_lines: 4 },
    h5: { scale: 1.1, weight: W.BOLD, pixels_above_lines: 10, pixels_below_lines: 4 },
    h6: { scale: 1.0, weight: W.BOLD, pixels_above_lines: 10, pixels_below_lines: 4 },
    bold: { weight: W.BOLD },
    italic: { style: S.ITALIC },
    bolditalic: { weight: W.BOLD, style: S.ITALIC },
    strike: { strikethrough: true },
    mark: {},
    code: { family: FONT_MONO, scale: 0.9 },
    codeblock: { family: FONT_MONO, scale: 0.9, pixels_above_lines: 0, pixels_below_lines: 0 },
    fence: {},
    link: { underline: Pango.Underline.SINGLE },
    image: { style: S.ITALIC },
    quote: {},
    hr: { justification: Gtk.Justification.CENTER, pixels_above_lines: 10, pixels_below_lines: 10 },
    table: { family: FONT_MONO, scale: 0.92 },
    tablehead: { weight: W.BOLD },
    tablesep: {},
    bullet: { weight: W.BOLD },
    task: { family: FONT_MONO, weight: W.BOLD },
    taskdone: { family: FONT_MONO, weight: W.BOLD },
    done: { strikethrough: true },
    marker: { weight: W.NORMAL, style: S.NORMAL, strikethrough: false, underline: Pango.Underline.NONE },

    // Dekorasi yang bergantung pada posisi kursor (lihat decorations.ts)
    dim: {},
    // Bukan `invisible`: teks tak terlihat di GtkTextView GTK 3 bisa memicu crash
    // "Byte index is off the end of the line". Marker cukup dibuat sangat kecil
    // dan berwarna sama dengan latar.
    hidden: { size: 1, letter_spacing: 0, strikethrough: false, underline: Pango.Underline.NONE },
} satisfies Record<string, Partial<Gtk.TextTag.ConstructorProps>>;

export type TagName = keyof typeof TAG_DEFS;
export type Tags = Record<TagName, Gtk.TextTag>;

// Tag yang dihapus lalu dipasang ulang oleh highlighter.ts.
export const SYNTAX_TAGS = (Object.keys(TAG_DEFS) as TagName[]).filter(n => n !== 'dim' && n !== 'hidden');

// Membuat semua tag di buffer. Hasil: { namaTag: Gtk.TextTag }.
export function createTags(buffer: Gtk.TextBuffer): Tags {
    const table = buffer.get_tag_table();
    const tags = {} as Tags;
    for (const [name, props] of Object.entries(TAG_DEFS) as [TagName, Partial<Gtk.TextTag.ConstructorProps>][]) {
        tags[name] = new Gtk.TextTag({ name, ...props });
        table.add(tags[name]);
    }
    return tags;
}

// Mewarnai tag sesuai palet tema (ui/theme.ts).
export function paintTags(t: Tags, p: Palette): void {
    for (const h of ['h1', 'h2', 'h3', 'h4', 'h5'] as const) t[h].foreground = p.heading;
    t.h6.foreground = p.quoteFg;
    t.mark.background = p.markBg;
    t.code.foreground = p.codeFg;
    t.code.background = p.codeBg;
    t.codeblock.paragraph_background = p.codeBg;
    t.codeblock.foreground = p.fg;
    t.fence.foreground = p.faint;
    t.link.foreground = p.accent;
    t.image.foreground = p.accent;
    t.quote.foreground = p.quoteFg;
    t.quote.paragraph_background = p.quoteBg;
    t.hr.foreground = p.faint;
    t.tablesep.foreground = p.faint;
    t.bullet.foreground = p.accent;
    t.task.foreground = p.accent;
    t.taskdone.foreground = p.faint;
    t.done.foreground = p.faint;
    t.marker.foreground = p.faint;
    t.dim.foreground = p.dim;
    t.hidden.foreground = p.bg;
}

// Margin tag bersifat absolut, jadi perlu diperbarui saat margin editor berubah.
export function setTagMargins(t: Tags, margin: number): void {
    t.codeblock.left_margin = margin + 18;
    t.codeblock.right_margin = margin + 18;
    t.quote.left_margin = margin + 22;
}
