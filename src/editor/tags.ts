// A GtkTextTag = a "style" attached to a text range (bold, heading, code, ...).
//
// The order in TAG_DEFS sets the priority: a tag created later wins if
// two tags set the same property. That is why 'marker', 'dim', and 'hidden'
// are at the end.

import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { FONT_MONO } from '../config.js';
import type { Palette } from '../ui/theme.js';

const W = Pango.Weight, S = Pango.Style;

// Font size of "hidden" text, in Pango units (1/1024 pt). Not 1:
// color emoji fonts are bitmap fonts, and at size 1 their scale becomes zero,
// so GTK fails to draw the whole window ("invalid matrix (not invertible)").
// 256 (a quarter point) is already invisible and safe.
const TINY = 256;

const TAG_DEFS = {
    // Syntax highlighting results (reapplied every time the text changes)
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
    // Nested quotes: applied after quote (higher priority) so its margin takes over.
    quote2: {},
    quote3: {},
    hr: { justification: Gtk.Justification.CENTER, pixels_above_lines: 10, pixels_below_lines: 10 },
    table: { family: FONT_MONO, scale: 0.92 },
    tablehead: { weight: W.BOLD },
    tablesep: {},
    bullet: { weight: W.BOLD },
    task: { family: FONT_MONO, weight: W.BOLD },
    taskdone: { family: FONT_MONO, weight: W.BOLD },
    done: { strikethrough: true },
    marker: { weight: W.NORMAL, style: S.NORMAL, strikethrough: false, underline: Pango.Underline.NONE },

    // Decorations that depend on the cursor position (see decorations.ts, tablelayer.ts)
    // Table rows already rendered as a grid: shrunk to ~1 px and without paragraph
    // spacing; the space for the grid is provided by tablelayer.ts.
    tablehide: { size: TINY, letter_spacing: 0, pixels_above_lines: 0, pixels_below_lines: 0, strikethrough: false, underline: Pango.Underline.NONE },
    // ```mermaid blocks already rendered as a diagram (see mermaid.ts). A separate tag
    // from tablehide because each layer removes its tag across the whole document when syncing.
    mermaidhide: { size: TINY, letter_spacing: 0, pixels_above_lines: 0, pixels_below_lines: 0, strikethrough: false, underline: Pango.Underline.NONE },
    // Code blocks already rendered as a widget that can be scrolled sideways (see codelayer.ts).
    codehide: { size: TINY, letter_spacing: 0, pixels_above_lines: 0, pixels_below_lines: 0, strikethrough: false, underline: Pango.Underline.NONE },
    dim: {},
    // Not `invisible`: invisible text in a GTK 3 GtkTextView can trigger a crash
    // "Byte index is off the end of the line". Markers are just made very small
    // and the same color as the background.
    hidden: { size: TINY, letter_spacing: 0, strikethrough: false, underline: Pango.Underline.NONE },
} satisfies Record<string, Partial<Gtk.TextTag.ConstructorProps>>;

export type TagName = keyof typeof TAG_DEFS;
export type Tags = Record<TagName, Gtk.TextTag>;

// Tags applied by highlighter.ts.
export const SYNTAX_TAGS = (Object.keys(TAG_DEFS) as TagName[]).filter(n => n !== 'dim' && n !== 'hidden' && n !== 'tablehide' && n !== 'mermaidhide' && n !== 'codehide');

// Creates all tags in the buffer. Result: { tagName: Gtk.TextTag }.
export function createTags(buffer: Gtk.TextBuffer): Tags {
    const table = buffer.get_tag_table();
    const tags = {} as Tags;
    for (const [name, props] of Object.entries(TAG_DEFS) as [TagName, Partial<Gtk.TextTag.ConstructorProps>][]) {
        tags[name] = new Gtk.TextTag({ name, ...props });
        table.add(tags[name]);
    }
    return tags;
}

// Colors the tags according to the theme palette (ui/theme.ts).
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
    t.quote2.paragraph_background = p.quoteBg;
    t.quote3.paragraph_background = p.quoteBg;
    t.hr.foreground = p.faint;
    t.tablesep.foreground = p.faint;
    t.bullet.foreground = p.accent;
    t.task.foreground = p.accent;
    t.taskdone.foreground = p.faint;
    t.done.foreground = p.faint;
    t.marker.foreground = p.faint;
    t.dim.foreground = p.dim;
    t.hidden.foreground = p.bg;
    t.tablehide.foreground = p.bg;
    t.mermaidhide.foreground = p.bg;
    t.codehide.foreground = p.bg;
    t.codehide.paragraph_background = p.bg;
    t.mermaidhide.paragraph_background = p.bg;  // covers the code block background on the hidden lines
}

// Tag margins are absolute, so they need to be updated when the editor margin changes.
export function setTagMargins(t: Tags, margin: number): void {
    t.codeblock.left_margin = margin + 18;
    t.codeblock.right_margin = margin + 18;
    t.quote.left_margin = margin + 22;
    t.quote2.left_margin = margin + 44;
    t.quote3.left_margin = margin + 66;
}
