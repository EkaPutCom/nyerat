// Dekorasi yang bergantung pada posisi kursor. Dipanggil setiap kursor pindah baris.

import type Gtk from 'gi://Gtk?version=3.0';
import type { Marker } from './highlighter.js';
import { setTagRanges, type LineSpan, type LineTagger } from './tagsync.js';

// Inti efek sintaks tersembunyi: sembunyikan semua marker, kecuali yang aktif di
// baris l0..l1 (baris kursor atau baris yang terseleksi). Hanya baris yang
// keadaannya berubah yang disentuh (lihat LineTagger).
export function concealMarkers(tagger: LineTagger, tag: Gtk.TextTag, markers: Marker[], starts: number[], l0: number, l1: number, enabled: boolean): void {
    const spans: LineSpan[][] = starts.map(() => []);
    if (enabled) {
        for (const [a, b, r0, r1, line] of markers)
            if (r1 < l0 || r0 > l1) spans[line].push([tag, a - starts[line], b - starts[line]]);
    }
    tagger.apply(spans, starts);
}

// Mode fokus: redupkan semua teks di luar paragraf yang memuat baris l0..l1.
// Paragraf = baris-baris berurutan yang dibatasi baris kosong.
export function dimOutsideParagraph(buffer: Gtk.TextBuffer, tag: Gtk.TextTag, lines: string[], l0: number, l1: number, enabled: boolean): void {
    if (!enabled || !lines.length) {
        setTagRanges(buffer, tag, []);
        return;
    }
    const blank = (n: number) => !lines[n] || !lines[n].trim();
    let b0 = l0, b1 = l1;
    while (b0 > 0 && !blank(b0 - 1)) b0--;
    while (b1 < lines.length - 1 && !blank(b1 + 1)) b1++;
    const s = buffer.get_iter_at_line(b0);
    const e = buffer.get_iter_at_line(b1);
    e.forward_to_line_end();
    setTagRanges(buffer, tag, [[0, s.get_offset()], [e.get_offset(), buffer.get_char_count()]]);
}
