// Tab Outline di sidebar: daftar heading dokumen. Klik heading untuk melompat ke sana.

import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import type { Heading } from '../editor/highlighter.js';

type Label = Pick<Heading, 'level' | 'text'>;

const BATCH = 50;   // baris outline yang dibuat/dihapus per giliran

export class Outline {
    readonly list: Gtk.ListBox;
    readonly widget: Gtk.Box;
    onJump: (line: number) => void = () => {};  // heading diklik

    private headings: Heading[] = [];
    private labels: Label[] = [];   // isi baris yang sedang tampil
    private rowHeading: (row: number) => number = i => i;   // indeks baris → indeks heading, -1 = belum ada
    private queued = 0;

    constructor() {
        this.list = new Gtk.ListBox({ activate_on_single_click: true });
        this.list.set_selection_mode(Gtk.SelectionMode.NONE);
        this.list.connect('row-activated', (_list, row) => {
            const heading = this.headings[this.rowHeading(row.get_index())];
            if (heading) this.onJump(heading.line);
        });
        const placeholder = new Gtk.Label({ label: 'Belum ada heading', margin_top: 16, margin_bottom: 16, margin_start: 16, margin_end: 16 });
        placeholder.add_css_class('dim-label');
        this.list.set_placeholder(placeholder);

        const title = new Gtk.Label({ label: 'OUTLINE', xalign: 0, margin_start: 16, margin_top: 4, margin_bottom: 8 });
        title.add_css_class('side-title');
        const scroll = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true });
        scroll.set_child(this.list);

        this.widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        this.widget.append(title);
        this.widget.append(scroll);
    }

    // Jendela ditutup: hentikan cicilan yang tertunda.
    destroy(): void {
        if (this.queued) GLib.source_remove(this.queued);
        this.queued = 0;
    }

    // headings dari editor/highlighter.ts
    update(headings: Heading[]): void {
        // Pergeseran baris mengubah tujuan klik, bukan tampilan label.
        this.headings = headings;
        this.sync();
    }

    // Samakan baris daftar dengan this.headings, paling banyak BATCH baris per panggilan.
    // Dipanggil tiap ketukan, jadi perbandingannya langsung per heading tanpa membuat string
    // seluruh daftar. Membuka naskah dengan ratusan heading membuat ratusan baris (±0,12 ms
    // per baris); sisanya dicicil di idle supaya membuka dokumen tidak tertahan.
    private sync(): void {
        const previous = this.labels;
        const headings = this.headings;

        // Pertahankan awalan/akhiran yang sama: mengedit satu heading tidak
        // membangun ulang seluruh sidebar dan memicu layout ratusan label.
        const same = (a: Label, b: Heading) => a.level === b.level && a.text === b.text;
        let first = 0, oldEnd = previous.length, newEnd = headings.length;
        while (first < oldEnd && first < newEnd && same(previous[first], headings[first])) first++;
        if (first === oldEnd && first === newEnd) {   // daftar tidak berubah
            this.rowHeading = i => i;
            return;
        }
        while (oldEnd > first && newEnd > first && same(previous[oldEnd - 1], headings[newEnd - 1])) { oldEnd--; newEnd--; }

        const removed = Math.min(oldEnd - first, BATCH);
        const added = removed === oldEnd - first ? Math.min(newEnd - first, BATCH - removed) : 0;
        for (let i = 0; i < removed; i++) {
            const row = this.list.get_row_at_index(first);
            if (row) this.list.remove(row);
        }
        for (let i = first; i < first + added; i++) this.list.insert(this.createRow(headings[i]), i);
        this.labels = [...previous.slice(0, first), ...headings.slice(first, first + added).map(({ level, text }) => ({ level, text })),
            ...previous.slice(first + removed)];

        // Selama cicilan berjalan, baris lama yang belum dihapus tidak punya tujuan, dan
        // baris akhiran yang sama menunjuk heading akhiran daftar baru.
        const done = first + added, stale = oldEnd - first - removed;
        this.rowHeading = i => i < done ? i : i < done + stale ? -1 : i - done - stale + newEnd;
        if (this.labels.length === headings.length && removed === oldEnd - first && added === newEnd - first) return;
        if (!this.queued) {
            this.queued = GLib.idle_add(GLib.PRIORITY_HIGH_IDLE + 23, () => {
                this.queued = 0;
                this.sync();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    private createRow(h: Heading): Gtk.ListBoxRow {
        const text = h.text || '(kosong)';
        const label = new Gtk.Label({
            label: text, xalign: 0, ellipsize: Pango.EllipsizeMode.END,
            margin_start: 16 + (h.level - 1) * 14, margin_end: 12,
        });
        if (h.level === 1) label.set_markup(`<b>${GLib.markup_escape_text(text, -1)}</b>`);
        return new Gtk.ListBoxRow({ child: label });
    }
}
