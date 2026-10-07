// Indentasi menggantung untuk item daftar: baris lanjutan (hasil pembungkusan) sejajar
// dengan teks item, bukan dengan penanda "-" / "1." di kirinya.
//
// GtkTextTag memakai `indent` negatif (baris pertama paragraf penuh, sisanya menjorok) bersama
// left_margin. Lebar awalan ("  - ", "10. ", "- [ ] ") bergantung pada teksnya, jadi tag dibuat
// sesuai kebutuhan, satu per lebar piksel, dan left_margin-nya diperbarui saat margin editor berubah.

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

    // Margin kiri editor berubah: geser margin semua tag.
    setMargin(margin: number): void {
        this.margin = margin;
        for (const [width, tag] of this.tags) tag.left_margin = margin + width;
    }

    // Tag untuk item daftar dengan awalan: indent + marker ("-", "1.") + gap (spasi) +
    // task ("[ ]"/"[x]" atau '') + tail (spasi setelah kotak tugas).
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

    // Lebar awalan sebagaimana digambar: penanda tebal, kotak tugas bercetak tebal monospace.
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

// Dipanggil editor: highlighter.ts mencari ListIndent lewat objek Tags miliknya.
export function registerListIndent(tags: Tags, indent: ListIndent): void {
    registry.set(tags, indent);
}

export function listIndentFor(tags: Tags): ListIndent | undefined {
    return registry.get(tags);
}
