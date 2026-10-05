// Tautan antardokumen gaya Obsidian: [[Catatan]], [[Catatan|teks lain]], [[folder/Catatan#Bagian]].
// Murni, tanpa GTK: dipakai parser inline (penyorotan), ekspor HTML, klik tautan, dan saran nama saat mengetik [[.
//
// Target dicocokkan dengan nama berkas Markdown di folder proyek tanpa ekstensi dan tanpa membedakan huruf besar,
// sehingga [[catatan harian]] menemukan "Jurnal/Catatan Harian.md". Target yang memuat '/' dicocokkan dengan
// akhir path-nya. Path selalu relatif terhadap folder proyek dan memakai '/'.

export interface WikiLink {
    target: string;    // nama atau path catatan, tanpa #bagian
    heading: string;   // teks setelah '#', '' bila tidak ada
    alias: string;     // teks setelah '|', '' bila tidak ada
}

// Pola [[...]] di satu baris. Isinya tidak boleh memuat '[', ']', atau baris baru; '\0' adalah karakter
// yang sudah di-mask parser inline (kode inline).
export const WIKILINK = (): RegExp => /\[\[([^[\]\0\n|]+)(?:\|([^[\]\0\n]*))?\]\]/g;

const MARKDOWN_EXT = /\.(md|markdown|mdown|mkd)$/i;

// Isi di antara [[ dan ]] → bagian-bagiannya.
export function parseWikiLink(inner: string): WikiLink {
    const bar = inner.indexOf('|');
    const ref = bar < 0 ? inner : inner.slice(0, bar);
    const alias = bar < 0 ? '' : inner.slice(bar + 1).trim();
    const hash = ref.indexOf('#');
    return {
        target: (hash < 0 ? ref : ref.slice(0, hash)).trim(),
        heading: hash < 0 ? '' : ref.slice(hash + 1).trim(),
        alias,
    };
}

// Teks yang terlihat untuk tautan: alias bila ada, kalau tidak target beserta bagiannya.
export const wikiLabel = (link: WikiLink): string =>
    link.alias || [link.target, link.heading].filter(Boolean).join(' › ');

const stem = (path: string): string => path.replace(MARKDOWN_EXT, '');
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const dirName = (path: string): string => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const fold = (s: string): string => s.normalize('NFC').toLowerCase();

// Berkas proyek (path relatif) yang dituju target, atau null. `from` = path relatif dokumen yang memuat tautan
// (null untuk dokumen di luar proyek); bila ada beberapa berkas bernama sama, yang paling dekat dengannya menang,
// lalu yang path-nya paling pendek, seperti Obsidian.
export function resolveWikiLink(target: string, files: string[], from: string | null): string | null {
    const want = fold(stem(target.trim().replace(/^\.?\//, '')));
    if (!want) return null;
    const hasDir = want.includes('/');
    const matches = files.filter(f => {
        if (!MARKDOWN_EXT.test(f)) return false;
        const s = fold(stem(f));
        return hasDir ? s === want || s.endsWith(`/${want}`) : fold(stem(baseName(f))) === want;
    });
    if (!matches.length) return null;
    const here = from === null ? null : dirName(from);
    const score = (f: string) => {
        const d = dirName(f);
        if (here !== null && d === here) return 0;
        if (here !== null && here.startsWith(d ? `${d}/` : '')) return 1;   // folder induk dokumen
        return 2;
    };
    return matches.sort((a, b) => score(a) - score(b) || a.split('/').length - b.split('/').length || a.localeCompare(b))[0];
}

// Path relatif untuk catatan baru dari target yang belum ada, atau null bila namanya tidak aman.
// Target tanpa folder dibuat di samping dokumen yang menautkannya; target dengan folder relatif terhadap proyek.
export function newNotePath(target: string, from: string | null): string | null {
    const clean = target.trim().replace(/^\.?\//, '');
    const parts = clean.split('/');
    if (!clean || parts.some(p => !p.trim() || p === '.' || p === '..' || p.startsWith('.'))) return null;
    if (/[\0\\:*?"<>|]/.test(clean)) return null;
    const name = MARKDOWN_EXT.test(clean) ? clean : `${clean}.md`;
    if (parts.length > 1) return name;
    const dir = from === null ? '' : dirName(from);
    return dir ? `${dir}/${name}` : name;
}

// Teks yang paling ringkas untuk menautkan berkas `file`: nama tanpa ekstensi bila unik di proyek,
// kalau tidak path tanpa ekstensi.
export function wikiTargetFor(file: string, files: string[]): string {
    const name = fold(stem(baseName(file)));
    const twins = files.filter(f => MARKDOWN_EXT.test(f) && fold(stem(baseName(f))) === name).length;
    return twins > 1 ? stem(file) : stem(baseName(file));
}

// Bagian yang sedang diketik setelah [[ yang belum ditutup di teks sebelum kursor, atau null.
// Saran berhenti setelah '|' (alias) dan '#' (bagian) karena keduanya bukan nama berkas.
export function wikiQuery(beforeCursor: string): string | null {
    const open = beforeCursor.lastIndexOf('[[');
    if (open < 0) return null;
    const typed = beforeCursor.slice(open + 2);
    if (/[[\]|#\n]/.test(typed)) return null;
    // `kode` sebelum [[ yang belum ditutup: di dalam kode inline tidak ada tautan.
    if ((beforeCursor.slice(0, open).match(/`/g)?.length ?? 0) % 2) return null;
    return typed;
}

// Berkas Markdown yang cocok dengan teks yang diketik, paling relevan dulu: awalan nama, awalan kata,
// lalu potongan di mana saja di path. Teks kosong = semua berkas menurut abjad.
export function suggestNotes(query: string, files: string[], limit = 8): string[] {
    const q = fold(query.trim());
    const ranked: [number, string][] = [];
    for (const f of files) {
        if (!MARKDOWN_EXT.test(f)) continue;
        const name = fold(stem(baseName(f)));
        const path = fold(stem(f));
        let rank: number;
        if (!q) rank = 0;
        else if (name.startsWith(q)) rank = 0;
        else if (name.split(/[\s_-]+/).some(w => w.startsWith(q))) rank = 1;
        else if (path.includes(q)) rank = 2;
        else continue;
        ranked.push([rank, f]);
    }
    ranked.sort((a, b) => a[0] - b[0] || baseName(a[1]).localeCompare(baseName(b[1]), 'id', { numeric: true }) || a[1].localeCompare(b[1]));
    return ranked.slice(0, limit).map(r => r[1]);
}
