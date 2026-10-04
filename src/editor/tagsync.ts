// Memasang tag dengan selisih: hanya rentang yang berubah yang disentuh.
//
// Menghapus tag di seluruh buffer lalu memasangnya lagi memang sederhana, tetapi untuk tag
// yang memengaruhi ukuran (font, spasi baris) GTK lalu menata ulang seluruh dokumen, dan
// itu yang paling mahal saat mengetik atau memindah kursor di dokumen panjang.

import type Gtk from 'gi://Gtk?version=3.0';

// Rentang [awal, akhir) dalam offset code point.
export type Range = [start: number, end: number];

// Rentang tempat `tag` terpasang sekarang, berurutan.
export function tagRanges(buffer: Gtk.TextBuffer, tag: Gtk.TextTag): Range[] {
    const out: Range[] = [];
    const it = buffer.get_start_iter();
    if (!it.has_tag(tag) && !it.forward_to_tag_toggle(tag)) return out;
    for (;;) {
        const a = it.get_offset();
        it.forward_to_tag_toggle(tag);
        out.push([a, it.get_offset()]);
        if (!it.forward_to_tag_toggle(tag)) return out;
    }
}

// Urutkan dan gabungkan rentang yang bertumpuk atau bersambung; rentang kosong dibuang.
export function normalize(ranges: Range[]): Range[] {
    const sorted = ranges.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
    const out: Range[] = [];
    for (const [a, b] of sorted) {
        const last = out[out.length - 1];
        if (last && a <= last[1]) last[1] = Math.max(last[1], b);
        else out.push([a, b]);
    }
    return out;
}

// Bagian dari `a` yang tidak tercakup `b` (keduanya sudah dinormalisasi).
export function subtract(a: Range[], b: Range[]): Range[] {
    const out: Range[] = [];
    let j = 0;
    for (const [s0, e] of a) {
        let s = s0;
        while (j < b.length && b[j][1] <= s) j++;
        for (let k = j; k < b.length && b[k][0] < e; k++) {
            if (b[k][0] > s) out.push([s, b[k][0]]);
            s = Math.max(s, b[k][1]);
        }
        if (s < e) out.push([s, e]);
    }
    return out;
}

// Samakan tag di buffer dengan `wanted`.
export function setTagRanges(buffer: Gtk.TextBuffer, tag: Gtk.TextTag, wanted: Range[]): void {
    const want = normalize(wanted);
    const have = tagRanges(buffer, tag);
    const iter = (n: number) => buffer.get_iter_at_offset(n);
    for (const [a, b] of subtract(have, want)) buffer.remove_tag(tag, iter(a), iter(b));
    for (const [a, b] of subtract(want, have)) buffer.apply_tag(tag, iter(a), iter(b));
}

// Seperti setTagRanges untuk sekelompok tag sekaligus; tag yang tidak disebut di `wanted`
// dihapus seluruhnya.
export function setTagGroup(buffer: Gtk.TextBuffer, tags: Iterable<Gtk.TextTag>, wanted: Map<Gtk.TextTag, Range[]>): void {
    for (const tag of new Set([...tags, ...wanted.keys()])) setTagRanges(buffer, tag, wanted.get(tag) ?? []);
}

// ---------- Tag per baris ----------
//
// Untuk tag yang rentangnya selalu di dalam satu baris (penyorotan sintaks, marker yang
// disembunyikan). LineTagger mengingat tag yang terakhir dipasang di tiap baris, sehingga
// pemasangan berikutnya hanya menyentuh baris yang tagnya berbeda atau teksnya disunting.
// Tag ikut bergeser bersama teks di GtkTextBuffer, jadi baris yang tidak disunting tetap
// memakai tag yang sama walaupun posisinya berpindah.

// Tag di satu baris: offset relatif terhadap awal baris; akhir boleh mencakup newline.
export type LineSpan = [tag: Gtk.TextTag, start: number, end: number];

const sameSpans = (a: LineSpan[], b: LineSpan[]): boolean =>
    a.length === b.length && a.every((s, k) => s[0] === b[k][0] && s[1] === b[k][1] && s[2] === b[k][2]);

export class LineTagger {
    private applied: (LineSpan[] | null)[] = [];   // null = belum diketahui, pasang ulang

    // allTags: semua tag yang dikelola, dihapus dari baris yang isinya tidak diketahui.
    constructor(private readonly buffer: Gtk.TextBuffer, private readonly allTags: Gtk.TextTag[]) {}

    // Jumlah baris yang dikenal tagger (jumlah baris dokumen saat apply terakhir/edited).
    get lineCount(): number {
        return this.applied.length;
    }

    // Teks disunting di baris first..last (nomor baris sekarang), jumlah baris kini `count`.
    // Baris sebelum dan sesudahnya tidak berubah, hanya bergeser.
    edited(first: number, last: number, count: number): void {
        const old = this.applied;
        const shift = count - old.length;
        this.applied = Array.from({ length: count }, (_, i) =>
            i < first ? old[i] ?? null : i > last ? old[i - shift] ?? null : null);
    }

    // spans[i] = tag untuk baris i; starts[i] = offset awal baris i.
    apply(spans: LineSpan[][], starts: number[]): void {
        if (this.applied.length !== spans.length) this.applied = spans.map(() => null);
        this.run(spans.length, k => k, i => spans[i], starts);
    }

    // Seperti apply(), tetapi hanya memeriksa baris di `lines` (urut naik, tanpa duplikat)
    // ditambah baris yang tagnya belum diketahui. Baris lain dianggap sudah benar, jadi
    // pemanggil tidak perlu menyusun tag untuk seluruh dokumen.
    applyLines(lines: number[], spansOf: (line: number) => LineSpan[], starts: number[]): void {
        const count = starts.length;
        if (this.applied.length !== count) this.applied = starts.map(() => null);
        const visit: number[] = [];
        let k = 0;
        for (let i = 0; i < count; i++) {
            while (k < lines.length && lines[k] < i) k++;
            if (lines[k] === i || !this.applied[i]) visit.push(i);
        }
        this.run(visit.length, n => visit[n], spansOf, starts);
    }

    // Kunjungi baris lineAt(0..count-1) (urut naik) dan samakan tagnya dengan spansOf.
    private run(count: number, lineAt: (k: number) => number, spansOf: (line: number) => LineSpan[], starts: number[]): void {
        const buf = this.buffer;
        const total = buf.get_char_count();
        const at = (line: number) => buf.get_iter_at_offset(starts[line] ?? total);
        for (let k = 0; k < count; k++) {
            const i = lineAt(k);
            const want = spansOf(i);
            const prev = this.applied[i];
            if (prev && (prev === want || sameSpans(prev, want))) continue;
            if (!prev) {
                // Baris tak dikenal yang berurutan dibersihkan sekaligus (mis. setelah setText).
                let n = k;
                while (n + 1 < count && lineAt(n + 1) === lineAt(n) + 1 && !this.applied[lineAt(n + 1)]) n++;
                const j = lineAt(n);
                const s = at(i), e = at(j + 1);
                for (const tag of this.allTags) buf.remove_tag(tag, s, e);
                // Saat membuka/paste dokumen, gabungkan rentang tag yang bertemu
                // supaya GTK tidak menerima ribuan operasi untuk blok kode panjang.
                const ranges = new Map<Gtk.TextTag, Range[]>();
                for (let line = i; line <= j; line++) {
                    const spans = line === i ? want : spansOf(line);
                    for (const [tag, a, b] of spans) {
                        if (!ranges.has(tag)) ranges.set(tag, []);
                        ranges.get(tag)!.push([starts[line] + a, starts[line] + b]);
                    }
                    this.applied[line] = spans;
                }
                for (const [tag, wanted] of ranges)
                    for (const [a, b] of normalize(wanted))
                        buf.apply_tag(tag, buf.get_iter_at_offset(a), buf.get_iter_at_offset(b));
                k = n;
                continue;
            } else {
                const s = at(i), e = at(i + 1);
                for (const tag of new Set(prev.map(p => p[0]))) buf.remove_tag(tag, s, e);
            }
            for (const [tag, a, b] of want)
                buf.apply_tag(tag, buf.get_iter_at_offset(starts[i] + a), buf.get_iter_at_offset(starts[i] + b));
            this.applied[i] = want;
        }
    }
}
