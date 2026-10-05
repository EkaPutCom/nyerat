// Konversi Markdown → HTML untuk fitur "Ekspor HTML".
// Murni JavaScript, tanpa GTK, sehingga mudah diuji.
//
// Alurnya dua tahap:
//   1. blocksHtml()  memecah dokumen per baris menjadi blok: heading, paragraf,
//                    daftar, kutipan, tabel, blok kode.
//   2. inlineHtml()  memformat isi tiap blok: tebal, miring, kode, tautan, dll.

import { RE, ESCAPE_OR_CODE, startsTable } from './syntax.js';
import { parseTable, tableEnd } from './table.js';
import { dbmlToMermaid } from './dbml.js';
import { WIKILINK, parseWikiLink, wikiLabel } from './wikilink.js';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (s: string): string => s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
const slug = (s: string): string => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');

function emphHtml(s: string): string {
    return s
        .replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, '<strong><em>$1</em></strong>')
        .replace(/(?<!\w)___(?=\S)([\s\S]*?\S)___(?!\w)/g, '<strong><em>$1</em></strong>')
        .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
        .replace(/(?<!\w)__(?=\S)([\s\S]*?\S)__(?!\w)/g, '<strong>$1</strong>')
        .replace(/\*(?=[^\s*])([\s\S]*?[^\s*])\*/g, '<em>$1</em>')
        .replace(/(?<!\w)_(?=[^\s_])([\s\S]*?[^\s_])_(?!\w)/g, '<em>$1</em>')
        .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
        .replace(/==(?=\S)([\s\S]*?\S)==/g, '<mark>$1</mark>');
}

function inlineHtml(s: string): string {
    const codes: string[] = [], escs: string[] = [], links: string[] = [];
    s = s.replace(ESCAPE_OR_CODE(), (_: string, ch: string | undefined, _ticks: string, code: string) => ch !== undefined
        ? `\u0002${escs.push(esc(ch)) - 1}\u0002`
        : `\u0001${codes.push(`<code>${esc(code)}</code>`) - 1}\u0001`);
    s = esc(s);
    const tok = (html: string) => `\u0003${links.push(html) - 1}\u0003`;
    // [[Catatan#Bagian|teks]] → <a href="Catatan.md#bagian">teks</a>. Isinya sudah di-escape, jadi href
    // dibangun dari teks asli lalu di-escape ulang.
    s = s.replace(WIKILINK(), (whole: string, ref: string, alias?: string) => {
        const link = parseWikiLink(unesc(alias === undefined ? ref : `${ref}|${alias}`));
        if (!link.target && !link.heading) return whole;
        const file = link.target ? encodeURI(/\.(md|markdown)$/i.test(link.target) ? link.target : `${link.target}.md`) : '';
        const href = file + (link.heading ? `#${slug(link.heading)}` : '');
        return tok(`<a class="wikilink" href="${esc(href)}">${esc(wikiLabel(link))}</a>`);
    });
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]*)(?:\s+&quot;(.*?)&quot;)?\)/g,
        (_: string, alt: string, src: string, t?: string) => tok(`<img src="${src}" alt="${alt}"${t ? ` title="${t}"` : ''}>`));
    s = s.replace(/\[([^\]]*)\]\(([^)\s]*)(?:\s+&quot;(.*?)&quot;)?\)/g,
        (_: string, txt: string, href: string, t?: string) => tok(`<a href="${href}"${t ? ` title="${t}"` : ''}>${emphHtml(txt)}</a>`));
    s = s.replace(/&lt;((?:https?|mailto|ftp):[^\s&]+)&gt;/g, (_: string, u: string) => tok(`<a href="${u}">${u}</a>`));
    s = s.replace(/\bhttps?:\/\/[^\s<\u0003]*[^\s<\u0003.,;:!?)\]'"]/g, u => tok(`<a href="${u}">${u}</a>`));
    s = emphHtml(s);
    s = s.replace(/ {2,}\n|\\\n/g, '<br>\n');
    s = s.replace(/\u0003(\d+)\u0003/g, (_, i: string) => links[Number(i)]);
    s = s.replace(/\u0002(\d+)\u0002/g, (_, i: string) => escs[Number(i)]);
    s = s.replace(/\u0001(\d+)\u0001/g, (_, i: string) => codes[Number(i)]);
    return s;
}

const indentWidth = (s: string): number => s.replace(/\t/g, '    ').length;
// Lebar indentasi di awal baris (tab = 4 spasi).
const indentOf = (line: string): number => indentWidth(/^[ \t]*/.exec(line)![0]);

interface ListItem {
    num: number;
    task: boolean | null;   // null = bukan daftar tugas
    lines: string[];
    ci: number;             // indentasi isi item
}

// Mengurai daftar mulai baris i. Hasil: [html, indeks baris setelah daftar].
function parseList(lines: string[], i: number): [string, number] {
    const first = RE.list.exec(lines[i])!;
    const ordered = /\d/.test(first[2]);
    const base = indentWidth(first[1]);
    const items: ListItem[] = [];
    let loose = false;
    while (i < lines.length) {
        const m = RE.list.exec(lines[i]);
        if (m && indentWidth(m[1]) === base && /\d/.test(m[2]) === ordered) {
            const contentIndent = base + m[2].length + Math.max(1, m[3].length);
            items.push({ num: parseInt(m[2]), task: m[4] ? /x/i.test(m[4]) : null,
                lines: [lines[i].slice(m[0].length)], ci: contentIndent });
            i++;
            continue;
        }
        const it = items[items.length - 1];
        if (!lines[i].trim()) {
            let j = i;
            while (j < lines.length && !lines[j].trim()) j++;
            if (j >= lines.length) break;
            const nm = RE.list.exec(lines[j]);
            const ind = indentOf(lines[j]);
            if ((nm && ind === base) || ind > base) {
                loose = true;
                for (; i < j; i++) it.lines.push('');
                continue;
            }
            break;
        }
        const ind = indentOf(lines[i]);
        if (ind > base) {
            it.lines.push(lines[i].replace(/^[ \t]*/, ' '.repeat(Math.max(0, ind - it.ci))));
            i++;
        } else if (!RE.list.test(lines[i]) && !RE.fence.test(lines[i]) && !RE.heading.test(lines[i]) &&
                   !RE.hr.test(lines[i]) && !/^[ \t]*>/.test(lines[i])) {
            it.lines.push(lines[i]);  // baris lanjutan (lazy)
            i++;
        } else {
            break;
        }
    }
    const tag = ordered ? 'ol' : 'ul';
    const start = ordered && items[0].num !== 1 ? ` start="${items[0].num}"` : '';
    const body = items.map((it): string => {
        let html: string = blocksHtml(it.lines);
        if (!loose) html = html.replace(/^<p>([\s\S]*?)<\/p>/, '$1');
        if (it.task !== null)
            return `<li class="task"><input type="checkbox" disabled${it.task ? ' checked' : ''}> ${html}</li>`;
        return `<li>${html}</li>`;
    }).join('\n');
    return [`<${tag}${start}>\n${body}\n</${tag}>`, i];
}

function blocksHtml(lines: string[]): string {
    const out: string[] = [];
    let para: string[] = [], i = 0, m: RegExpExecArray | null;
    const flush = () => { if (para.length) { out.push(`<p>${inlineHtml(para.join('\n'))}</p>`); para = []; } };
    while (i < lines.length) {
        const line = lines[i];
        if ((m = RE.fence.exec(line))) {
            flush();
            const ch = m[2][0], n = m[2].length, lang = m[3].trim(), code = [];
            for (i++; i < lines.length; i++) {
                const c = RE.fence.exec(lines[i]);
                if (c && c[2][0] === ch && c[2].length >= n && !c[3].trim()) { i++; break; }
                code.push(lines[i]);
            }
            // Diagram Mermaid digambar oleh skrip di <head> saat halaman dibuka (lihat markdownToHtml).
            if (lang.split(/\s+/)[0].toLowerCase() === 'mermaid') { out.push(`<pre class="mermaid">${esc(code.join('\n'))}</pre>`); continue; }
            // DBML diterjemahkan ke diagram ER Mermaid; yang salah sintaks tampil sebagai blok kode biasa.
            if (lang.split(/\s+/)[0].toLowerCase() === 'dbml') {
                try { out.push(`<pre class="mermaid">${esc(dbmlToMermaid(code.join('\n')))}</pre>`); continue; } catch { /* jatuh ke blok kode */ }
            }
            out.push(`<pre><code${lang ? ` class="language-${esc(lang)}"` : ''}>${esc(code.join('\n'))}</code></pre>`);
            continue;
        }
        if (!line.trim()) { flush(); i++; continue; }
        if ((m = /^(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line))) {
            flush();
            const t = m[2] || '';
            out.push(`<h${m[1].length} id="${slug(t)}">${inlineHtml(t)}</h${m[1].length}>`);
            i++; continue;
        }
        if (RE.hr.test(line)) { flush(); out.push('<hr>'); i++; continue; }
        if (/^[ \t]*>/.test(line)) {
            flush();
            const q = [];
            while (i < lines.length && /^[ \t]*>/.test(lines[i])) q.push(lines[i++].replace(/^[ \t]*>[ \t]?/, ''));
            out.push(`<blockquote>\n${blocksHtml(q)}\n</blockquote>`);
            continue;
        }
        if (startsTable(lines, i)) {
            flush();
            const end = tableEnd(lines, i);
            const table = parseTable(lines.slice(i, end + 1));
            const cell = (tag: string, text: string, col: number) =>
                `<${tag}${table.aligns[col] ? ` style="text-align:${table.aligns[col]}"` : ''}>${inlineHtml(text)}</${tag}>`;
            const row = (tag: string, cells: string[]) => `<tr>${cells.map((c, k) => cell(tag, c, k)).join('')}</tr>`;
            out.push(`<table>\n<thead>${row('th', table.header)}</thead>\n<tbody>\n${table.rows.map(r => `${row('td', r)}\n`).join('')}</tbody>\n</table>`);
            i = end + 1;
            continue;
        }
        if (RE.list.test(line) && (para.length === 0 || RE.list.exec(line)![3])) {
            flush();
            const [html, ni] = parseList(lines, i);
            out.push(html);
            i = ni;
            continue;
        }
        para.push(line);
        i++;
    }
    flush();
    return out.join('\n');
}

export function markdownToHtml(src: string, title: string): string {
    const body = blocksHtml(src.replace(/\r\n?/g, '\n').split('\n'));
    // Mermaid dimuat dari CDN hanya jika dokumennya punya diagram, jadi dokumen biasa tetap mandiri.
    const mermaid = body.includes('<pre class="mermaid">') ? `<script type="module">
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
mermaid.initialize({ startOnLoad: true, theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default' });
</script>
` : '';
    return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
body { max-width: 760px; margin: 40px auto; padding: 0 20px; font: 16px/1.65 "Noto Sans", "Helvetica Neue", Arial, sans-serif; color: #333; }
h1, h2 { border-bottom: 1px solid #eee; padding-bottom: .3em; }
h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.4em 0 .6em; color: #1f2328; }
a { color: #4183c4; text-decoration: none; } a:hover { text-decoration: underline; }
code { font-family: "DejaVu Sans Mono", monospace; font-size: .9em; background: #f3f4f4; padding: 2px 4px; border-radius: 3px; color: #c7254e; }
pre { background: #f6f8fa; padding: 12px 16px; border-radius: 6px; overflow: auto; }
pre code { background: none; padding: 0; color: inherit; }
pre.mermaid { background: none; text-align: center; }
blockquote { margin: 1em 0; padding: 0 1em; color: #6a737d; border-left: 4px solid #dfe2e5; }
table { border-collapse: collapse; margin: 1em 0; } th, td { border: 1px solid #dfe2e5; padding: 6px 13px; }
tr:nth-child(2n) { background: #f8f8f8; }
hr { border: 0; border-top: 2px solid #eee; margin: 2em 0; }
img { max-width: 100%; } mark { background: #fff3a3; }
li.task { list-style: none; } li.task input { margin: 0 .3em 0 -1.3em; }
</style>
${mermaid}</head>
<body>
${body}
</body>
</html>
`;
}
