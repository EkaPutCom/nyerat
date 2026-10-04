// Dekorasi yang bergantung pada posisi kursor. Dipanggil setiap kursor pindah baris.

import type Gtk from 'gi://Gtk?version=3.0';
import type { Marker } from './highlighter.js';
import { setTagRanges, type LineSpan, type LineTagger } from './tagsync.js';

// Inti efek sintaks tersembunyi: sembunyikan semua marker, kecuali yang aktif di
// baris l0..l1 (baris kursor atau baris yang terseleksi).
//
// Dipanggil tiap ketukan dan tiap kursor pindah baris, jadi tidak boleh bekerja sebanding
// panjang dokumen. Keadaan bawaan sebuah baris adalah "semua marker tersembunyi"; yang
// berbeda hanya baris aktif. Karena itu yang diperiksa hanya baris aktif lama dan baru,
// baris yang diurai ulang penyorot, dan baris yang tagnya belum diketahui (LineTagger).
export class MarkerConcealer {
    private markers: Marker[] = [];
    private multiLine: Marker[] = [];   // marker yang aktif di beberapa baris (pembatas blok kode)
    private active: number[] = [];      // baris yang dipasang dalam keadaan aktif, urut naik
    private recheck: [number, number][] = [];
    private enabled: boolean | null = null;

    constructor(private readonly tagger: LineTagger, private readonly tag: Gtk.TextTag) {}

    // Teks disunting di baris first..last (nomor baris sekarang), jumlah baris kini `count`.
    edited(first: number, last: number, count: number): void {
        const shift = count - this.tagger.lineCount;
        // Baris di rentang suntingan menjadi "tidak diketahui" di tagger dan pasti diperiksa.
        this.active = this.active.flatMap(l => l < first ? [l] : l > last - shift ? [l + shift] : []);
        this.recheck = this.recheck.map(([a, b]): [number, number] => b < first ? [a, b] : a > last - shift ? [a + shift, b + shift]
            : [Math.min(a, first), Math.max(b + shift, last)]);
        this.tagger.edited(first, last, count);
    }

    // Penyorot mengurai ulang baris first..last: marker-nya mungkin berubah walaupun teksnya
    // tidak (mis. pembatas ``` baru mengubah baris di bawahnya menjadi isi blok kode).
    reparsed(markers: Marker[], first: number, last: number): void {
        this.markers = markers;
        this.multiLine = markers.filter(m => m[2] !== m[3]);
        if (last >= first) this.recheck.push([first, last]);
    }

    apply(starts: number[], l0: number, l1: number, enabled: boolean): void {
        const count = starts.length;
        const visit = new Set<number>(this.active);
        const active: number[] = [];
        if (enabled) {
            for (let l = Math.max(0, l0); l <= l1 && l < count; l++) active.push(l);
            for (const m of this.multiLine) if (!(m[3] < l0 || m[2] > l1) && m[4] < count) active.push(m[4]);
        }
        for (const l of active) visit.add(l);
        for (const [a, b] of this.recheck) for (let l = Math.max(0, a); l <= b && l < count; l++) visit.add(l);
        this.recheck = [];
        const markers = this.markers;
        const spansOf = (line: number): LineSpan[] => {
            if (!enabled) return [];
            const spans: LineSpan[] = [];
            for (let k = lowerBound(markers, line); k < markers.length && markers[k][4] === line; k++) {
                const [a, b, r0, r1] = markers[k];
                if (r1 < l0 || r0 > l1) spans.push([this.tag, a - starts[line], b - starts[line]]);
            }
            return spans;
        };
        if (enabled !== this.enabled) {
            // Mode source dihidupkan/dimatikan: keadaan bawaan setiap baris berubah.
            this.enabled = enabled;
            this.tagger.apply(starts.map((_, i) => spansOf(i)), starts);
        } else {
            this.tagger.applyLines([...visit].sort((a, b) => a - b), spansOf, starts);
        }
        this.active = [...new Set(active)].sort((a, b) => a - b);
    }
}

// Indeks marker pertama di baris `line` (marker urut menurut barisnya).
function lowerBound(markers: Marker[], line: number): number {
    let a = 0, b = markers.length;
    while (a < b) { const mid = (a + b) >>> 1; if (markers[mid][4] < line) a = mid + 1; else b = mid; }
    return a;
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
