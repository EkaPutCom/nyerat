// Pemeriksaan struktur dokumen Markdown untuk verifikasi hasil agent: tabel yang jumlah selnya tidak cocok,
// heading kosong atau melompat level, blok kode yang tidak ditutup, dan daftar tautan lokal. Murni, tanpa GTK.
// Tiap masalah punya `key` tanpa nomor baris, supaya masalah lama yang hanya bergeser baris tidak dianggap baru.

import { ESCAPE_OR_CODE, RE, startsTable } from './syntax.js';
import { splitRow, tableEnd } from './table.js';

export interface Issue {
    line: number;   // 1-based
    key: string;    // identitas masalah tanpa nomor baris
    text: string;   // untuk dibaca model dan pengguna
}

export interface LocalLink {
    line: number;
    target: string;   // path apa adanya, tanpa #jangkar atau ?kueri, sudah di-decode
}

// Satu kali jalan per dokumen: frontmatter dan blok kode dilewati, tabel/heading/tautan dikumpulkan sekaligus.
// Dokumen yang diverifikasi bisa sepanjang buku dan diurai dua kali (sebelum/sesudah), jadi regex hanya dijalankan
// pada baris yang lolos saringan karakter murah.
export function scanDocument(text: string): { issues: Issue[]; links: LocalLink[] } {
    const lines = text.split('\n');
    const issues: Issue[] = [];
    const links: LocalLink[] = [];
    let i = 0;
    if (lines[0] === '---') {
        const end = lines.indexOf('---', 1);
        if (end > 0) i = end + 1;
    }
    let fence: { ch: string; len: number; line: number } | null = null;
    let level = 0;
    for (; i < lines.length; i++) {
        const line = lines[i];
        // Pagar kode boleh menjorok sampai tiga spasi; cukup lihat karakter pertama setelahnya.
        let indent = 0;
        while (indent < 3 && line.charCodeAt(indent) === 32) indent++;
        const first = line.charAt(indent);
        const m = (first === '`' || first === '~') ? RE.fence.exec(line) : null;
        if (fence) {
            if (m && m[2][0] === fence.ch && m[2].length >= fence.len && !m[3].trim()) fence = null;
            continue;
        }
        if (m && !(m[2][0] === '`' && m[3].includes('`'))) { fence = { ch: m[2][0], len: m[2].length, line: i }; continue; }
        if (indent === 0 && first === '#') {
            const h = RE.heading.exec(line);
            if (h) {
                const title = line.slice(h[0].length).replace(/\s+#+\s*$/, '').trim();
                const n = h[1].length;
                if (!title) issues.push({ line: i + 1, key: `heading-empty:${n}`, text: `heading kosong di baris ${i + 1}` });
                // Lompatan dari awal dokumen (mis. langsung ##) lazim di catatan, jadi hanya lompatan setelah heading pertama yang dihitung.
                else if (level && n > level + 1) issues.push({ line: i + 1, key: `heading-skip:${level}:${n}:${title}`, text: `heading "${title}" (baris ${i + 1}) melompat dari H${level} ke H${n}` });
                level = n;
                continue;
            }
        }
        if (line.includes('|') && startsTable(lines, i)) {
            const end = tableEnd(lines, i);
            const columns = splitRow(line).length;
            const separator = splitRow(lines[i + 1]).length;
            const heading = line.trim().slice(0, 60);
            if (separator !== columns) issues.push({ line: i + 2, key: `table-sep:${heading}`, text: `tabel baris ${i + 1}: judul ${columns} kolom, pemisah ${separator} kolom` });
            for (let r = i + 2; r <= end; r++) {
                const cells = splitRow(lines[r]).length;
                if (cells !== columns) issues.push({ line: r + 1, key: `table-row:${heading}:${lines[r].trim().slice(0, 60)}`, text: `tabel baris ${r + 1}: ${cells} sel, judul ${columns} kolom` });
            }
            for (let r = i; r <= end; r++) collectLinks(lines[r], r, links);
            i = end;
            continue;
        }
        if (line.includes('](')) collectLinks(line, i, links);
    }
    if (fence) issues.unshift({ line: fence.line + 1, key: `fence:${lines[fence.line].trim()}`, text: `blok kode yang dibuka di baris ${fence.line + 1} tidak ditutup` });
    return { issues, links };
}

// Tautan dan gambar ke path lokal (bukan URL, bukan #jangkar saja), di luar kode inline.
function collectLinks(line: string, index: number, links: LocalLink[]): void {
    if (!line.includes('](')) return;
    const plain = line.replace(ESCAPE_OR_CODE(), m => ' '.repeat(m.length));
    for (const m of plain.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
        const raw = m[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('#') || raw.startsWith('/')) continue;
        let target = raw.replace(/[#?].*$/, '');
        try { target = decodeURIComponent(target); } catch { /* biarkan apa adanya */ }
        if (target) links.push({ line: index + 1, target });
    }
}

export const structureIssues = (text: string): Issue[] => scanDocument(text).issues;
export const localLinks = (text: string): LocalLink[] => scanDocument(text).links;

// Path relatif tautan dari berkas `from` → path relatif terhadap folder proyek, atau null bila keluar dari folder.
export function resolveLink(from: string, target: string): string | null {
    const parts = from.split('/').slice(0, -1);
    for (const p of target.split('/')) {
        if (!p || p === '.') continue;
        if (p === '..') { if (!parts.length) return null; parts.pop(); }
        else parts.push(p);
    }
    return parts.join('/');
}

// Masalah di `after` yang tidak ada di `before` (dihitung per key, jadi masalah yang sama dua kali tetap terhitung).
export function newIssues(before: Issue[], after: Issue[]): Issue[] {
    const seen = new Map<string, number>();
    for (const i of before) seen.set(i.key, (seen.get(i.key) ?? 0) + 1);
    return after.filter(i => {
        const n = seen.get(i.key) ?? 0;
        if (n) { seen.set(i.key, n - 1); return false; }
        return true;
    });
}
