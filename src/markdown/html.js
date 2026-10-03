// Konversi Markdown → HTML untuk fitur "Ekspor HTML".
// Murni JavaScript, tanpa GTK, sehingga mudah diuji.
//
// Alurnya dua tahap:
//   1. blocksHtml()  memecah dokumen per baris menjadi blok: heading, paragraf,
//                    daftar, kutipan, tabel, blok kode.
//   2. inlineHtml()  memformat isi tiap blok: tebal, miring, kode, tautan, dll.

import { RE, ESCAPE_OR_CODE, startsTable } from './syntax.js';

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slug = s => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');

function emphHtml(s) {
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

function inlineHtml(s) {
    const codes = [], escs = [], links = [];
    s = s.replace(ESCAPE_OR_CODE(), (_, ch, ticks, code) => ch !== undefined
        ? `\u0002${escs.push(esc(ch)) - 1}\u0002`
        : `\u0001${codes.push(`<code>${esc(code)}</code>`) - 1}\u0001`);
    s = esc(s);
    const tok = html => `\u0003${links.push(html) - 1}\u0003`;
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]*)(?:\s+&quot;(.*?)&quot;)?\)/g,
        (_, alt, src, t) => tok(`<img src="${src}" alt="${alt}"${t ? ` title="${t}"` : ''}>`));
    s = s.replace(/\[([^\]]*)\]\(([^)\s]*)(?:\s+&quot;(.*?)&quot;)?\)/g,
        (_, txt, href, t) => tok(`<a href="${href}"${t ? ` title="${t}"` : ''}>${emphHtml(txt)}</a>`));
    s = s.replace(/&lt;((?:https?|mailto|ftp):[^\s&]+)&gt;/g, (_, u) => tok(`<a href="${u}">${u}</a>`));
    s = s.replace(/\bhttps?:\/\/[^\s<\u0003]*[^\s<\u0003.,;:!?)\]'"]/g, u => tok(`<a href="${u}">${u}</a>`));
    s = emphHtml(s);
    s = s.replace(/ {2,}\n|\\\n/g, '<br>\n');
    s = s.replace(/\u0003(\d+)\u0003/g, (_, i) => links[i]);
    s = s.replace(/\u0002(\d+)\u0002/g, (_, i) => escs[i]);
    s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => codes[i]);
    return s;
}

const tableCells = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim());
const indentWidth = s => s.replace(/\t/g, '    ').length;

function parseList(lines, i) {
    const first = RE.list.exec(lines[i]);
    const ordered = /\d/.test(first[2]);
    const base = indentWidth(first[1]);
    const items = [];
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
            const ind = indentWidth(lines[j].match(/^[ \t]*/)[0]);
            if ((nm && ind === base) || ind > base) {
                loose = true;
                for (; i < j; i++) it.lines.push('');
                continue;
            }
            break;
        }
        const ind = indentWidth(lines[i].match(/^[ \t]*/)[0]);
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
    const body = items.map(it => {
        let html = blocksHtml(it.lines);
        if (!loose) html = html.replace(/^<p>([\s\S]*?)<\/p>/, '$1');
        if (it.task !== null)
            return `<li class="task"><input type="checkbox" disabled${it.task ? ' checked' : ''}> ${html}</li>`;
        return `<li>${html}</li>`;
    }).join('\n');
    return [`<${tag}${start}>\n${body}\n</${tag}>`, i];
}

function blocksHtml(lines) {
    const out = [];
    let para = [], i = 0, m;
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
            const head = tableCells(line);
            const al = tableCells(lines[i + 1]).map(c =>
                c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : '');
            const cell = (tg, c, k) => `<${tg}${al[k] ? ` style="text-align:${al[k]}"` : ''}>${inlineHtml(c)}</${tg}>`;
            let html = `<table>\n<thead><tr>${head.map((c, k) => cell('th', c, k)).join('')}</tr></thead>\n<tbody>\n`;
            for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++)
                html += `<tr>${tableCells(lines[i]).map((c, k) => cell('td', c, k)).join('')}</tr>\n`;
            out.push(`${html}</tbody>\n</table>`);
            continue;
        }
        if (RE.list.test(line) && (para.length === 0 || RE.list.exec(line)[3])) {
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

export function markdownToHtml(src, title) {
    const body = blocksHtml(src.replace(/\r\n?/g, '\n').split('\n'));
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
blockquote { margin: 1em 0; padding: 0 1em; color: #6a737d; border-left: 4px solid #dfe2e5; }
table { border-collapse: collapse; margin: 1em 0; } th, td { border: 1px solid #dfe2e5; padding: 6px 13px; }
tr:nth-child(2n) { background: #f8f8f8; }
hr { border: 0; border-top: 2px solid #eee; margin: 2em 0; }
img { max-width: 100%; } mark { background: #fff3a3; }
li.task { list-style: none; } li.task input { margin: 0 .3em 0 -1.3em; }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}
