// Hanging indent for list items: continuation lines (from wrapping) line up
// with the item text, not with the "-" / "1." marker on its left.
//
// A GtkTextTag uses a negative `indent` (the first line of the paragraph is full, the rest indented) together with
// left_margin. The width of the prefix ("  - ", "10. ", "- [ ] ") depends on its text, so tags are created
// on demand, one per pixel width, and their left_margin is updated when the editor margin changes.

import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
import { FONT_MONO } from '../config.js';
import type { Tags } from './tags.js';

const TAB_WIDTH = 4;

export class ListIndent {
    private readonly tags = new Map<number, Gtk.TextTag>();
    private readonly widths = new Map<string, number>();   // awalan → lebar piksel
    private margin = 0;

    constructor(private readonly view: Gtk.TextView, private readonly buffer: Gtk.TextBuffer, private readonly onCreate: (tag: Gtk.TextTag) => void) {}

    // The editor's left margin changed: shift the margin of all tags.
    setMargin(margin: number): void {
        this.margin = margin;
        for (const [width, tag] of this.tags) tag.left_margin = margin + width;
    }

    // Tag for a list item with a prefix: indent + marker ("-", "1.") + gap (space) +
    // task ("[ ]"/"[x]" or '') + tail (space after the task box).
    tag(indent: string, marker: string, gap: string, task: string, tail: string): Gtk.TextTag {
        const width = this.measure(indent, marker, gap, task, tail);
        let tag = this.tags.get(width);
        if (!tag) {
            tag = new Gtk.TextTag({ name: `list-indent-${width}`, left_margin: this.margin + width, indent: -width });
            this.buffer.get_tag_table().add(tag);
            this.tags.set(width, tag);
            this.onCreate(tag);
        }
        return tag;
    }

    // Prefix width as drawn: bold marker, bold monospace task box.
    private measure(indent: string, marker: string, gap: string, task: string, tail: string): number {
        const key = `${indent}\n${marker}\n${gap}\n${task}\n${tail}`;
        let width = this.widths.get(key);
        if (width !== undefined) return width;
        const esc = (s: string) => GLib.markup_escape_text(s.replace(/\t/g, ' '.repeat(TAB_WIDTH)), -1);
        let markup = `${esc(indent)}<b>${esc(marker)}</b>${esc(gap)}`;
        if (task) markup += `<span font_family="${FONT_MONO}" weight="bold">${esc(task)}</span>${esc(tail)}`;
        const layout = this.view.create_pango_layout(null);
        layout.set_markup(markup, -1);
        width = layout.get_pixel_size()[0];
        this.widths.set(key, width);
        return width;
    }
}

const registry = new WeakMap<Tags, ListIndent>();

// Called by the editor: highlighter.ts finds ListIndent through its own Tags object.
export function registerListIndent(tags: Tags, indent: ListIndent): void {
    registry.set(tags, indent);
}

export function listIndentFor(tags: Tags): ListIndent | undefined {
    return registry.get(tags);
}
