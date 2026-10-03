// Pengurai format inline (di dalam satu baris): kode, tautan, tebal, miring, dll.
//
// Teknik "masking": setelah suatu bagian dikenali, karakternya diganti '\0' di
// salinan string, sehingga pola berikutnya tidak bisa mengenalinya lagi. Urutan
// pengenalan: escape (\*) dan kode inline → tautan/gambar → URL → penekanan.
// Contoh: di `**x**` bagian ** sudah di-mask sebagai kode, jadi tidak jadi tebal.
//
// Hasil: tags [nama, awal, akhir], marks [awal, akhir] (sintaks yang boleh
// disembunyikan), dan images [{ alt, url, start, end }].
// Posisi dalam satuan UTF-16 dan relatif terhadap awal string.

import { EMPHASIS, ESCAPE_OR_CODE, type InlineTag } from './syntax.js';

export interface InlineImage {
    alt: string;
    url: string;
    start: number;
    end: number;
}

export interface InlineResult {
    tags: [InlineTag, number, number][];
    marks: [number, number][];
    images: InlineImage[];
}

// Mengurai format inline satu baris. Hasil: tag [nama, awal, akhir] dan
// rentang "marker" (sintaks yang disembunyikan saat kursor di baris lain).
export function parseInline(s: string): InlineResult {
    const tags: InlineResult['tags'] = [], marks: InlineResult['marks'] = [], images: InlineImage[] = [];
    // Baris tanpa sintaks tidak perlu salinan karakter. Setelah masking, rangkai
    // ulang string hanya jika ada bagian baru yang ditutup oleh tahap sebelumnya.
    let m: string[] | null = null;
    let current = s, changed = false;
    const mask = (a: number, b: number) => {
        m ??= s.split('');
        for (let i = a; i < b; i++) m[i] = '\0';
        changed = true;
    };
    const cur = () => {
        if (changed) { current = m!.join(''); changed = false; }
        return current;
    };
    const mark = (a: number, b: number) => { if (b > a) { marks.push([a, b]); tags.push(['marker', a, b]); } };
    let r: RegExpExecArray | null, t: string;

    const reEscCode = ESCAPE_OR_CODE();
    while ((r = reEscCode.exec(s))) {
        const a = r.index, b = a + r[0].length;
        if (r[1] !== undefined) {           // \* → sembunyikan backslash-nya
            mark(a, a + 1);
        } else {                            // `kode`
            const n = r[2].length;
            tags.push(['code', a + n, b - n]); mark(a, a + n); mark(b - n, b);
        }
        mask(a, b);
    }

    t = cur();
    const reLink = /(!?)\[([^\]\0]*)\]\(([^)\0]*)\)/g;
    while ((r = reLink.exec(t))) {
        const a = r.index, b = a + r[0].length;
        const ts = a + r[1].length + 1, te = ts + r[2].length;
        tags.push([r[1] ? 'image' : 'link', ts, te]);
        mark(a, ts); mark(te, b); mask(a, ts); mask(te, b);
        // Gambar: url tanpa judul opsional, misalnya ![alt](foto.png "Judul")
        if (r[1]) images.push({ alt: r[2], url: r[3].trim().split(/\s+/)[0] ?? '', start: a, end: b });
    }

    t = cur();
    const reAuto = /<((?:https?|mailto|ftp):[^\s>\0]+)>/g;
    while ((r = reAuto.exec(t))) {
        const a = r.index, b = a + r[0].length;
        tags.push(['link', a + 1, b - 1]); mark(a, a + 1); mark(b - 1, b); mask(a, b);
    }

    t = cur();
    const reUrl = /\bhttps?:\/\/[^\s<>\0]*[^\s<>\0.,;:!?)\]'"]/g;
    while ((r = reUrl.exec(t))) { tags.push(['link', r.index, r.index + r[0].length]); mask(r.index, r.index + r[0].length); }

    for (const [name, re, n] of EMPHASIS) {
        t = cur();
        re.lastIndex = 0;
        while ((r = re.exec(t))) {
            const a = r.index, b = a + r[0].length;
            tags.push([name, a + n, b - n]);
            mark(a, a + n); mark(b - n, b); mask(a, a + n); mask(b - n, b);
        }
    }
    return { tags, marks, images };
}
