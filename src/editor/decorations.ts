// Dekorasi yang bergantung pada posisi kursor. Dipanggil setiap kursor pindah baris.

import type Gtk from 'gi://Gtk?version=3.0';
import type { Marker } from './highlighter.js';

// Inti efek "ala Typora": sembunyikan semua marker, kecuali yang aktif di
// baris l0..l1 (baris kursor atau baris yang terseleksi).
export function concealMarkers(buffer: Gtk.TextBuffer, tag: Gtk.TextTag, markers: Marker[], l0: number, l1: number, enabled: boolean): void {
    const [start, end] = buffer.get_bounds();
    buffer.remove_tag(tag, start, end);
    if (!enabled) return;
    for (const [a, b, r0, r1] of markers) {
        if (r1 < l0 || r0 > l1)
            buffer.apply_tag(tag, buffer.get_iter_at_offset(a), buffer.get_iter_at_offset(b));
    }
}

// Mode fokus: redupkan semua teks di luar paragraf yang memuat baris l0..l1.
// Paragraf = baris-baris berurutan yang dibatasi baris kosong.
export function dimOutsideParagraph(buffer: Gtk.TextBuffer, tag: Gtk.TextTag, lines: string[], l0: number, l1: number, enabled: boolean): void {
    const [start, end] = buffer.get_bounds();
    buffer.remove_tag(tag, start, end);
    if (!enabled || !lines.length) return;
    const blank = (n: number) => !lines[n] || !lines[n].trim();
    let b0 = l0, b1 = l1;
    while (b0 > 0 && !blank(b0 - 1)) b0--;
    while (b1 < lines.length - 1 && !blank(b1 + 1)) b1++;
    const s = buffer.get_iter_at_line(b0);
    const e = buffer.get_iter_at_line(b1);
    e.forward_to_line_end();
    buffer.apply_tag(tag, start, s);
    buffer.apply_tag(tag, e, end);
}
