// Pola regex untuk mengenali sintaks Markdown.
// Dipakai bersama oleh penyorot editor (editor/highlighter.js) dan ekspor HTML (markdown/html.js).

// Pola tingkat blok: diuji terhadap satu baris utuh.
export const RE = {
    fence: /^(\s{0,3})(`{3,}|~{3,})(.*)$/,
    heading: /^(#{1,6})([ \t]+|$)/,
    hr: /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/,
    quote: /^(?:[ \t]*>[ \t]?)+/,
    list: /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)(\[[ xX]\](?:[ \t]+|$))?/,
    tableSep: /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/,
};

// Baris pemisah tabel ("| --- | :-: |" atau "--- | ---"). Wajib memuat '|' supaya
// tidak tertukar dengan garis pemisah "---".
export const isTableSeparator = line => line.includes('|') && RE.tableSep.test(line);

// Awal tabel: baris berisi '|' yang diikuti baris pemisah.
export const startsTable = (lines, i) => lines[i].includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]);

// Escape (\*) dan kode inline (`kode`) dalam SATU regex, supaya dikenali bersamaan
// dari kiri ke kanan seperti di CommonMark:
//   \`bukan kode\`   escape menang, karena backtick-nya sudah "dimakan" escape
//   `C:\*`           kode menang, karena backslash ada di dalam kode
// Grup: 1 = karakter yang di-escape, 2 = backtick pembuka, 3 = isi kode.
export const ESCAPE_OR_CODE = () => /\\([\\`*_{}[\]()#+\-.!~=|<>])|(`+)([^`]|[^`][\s\S]*?[^`])\2(?!`)/g;

// Pola penekanan inline: [nama tag, regex, panjang penanda].
// Urutannya penting: *** dicoba sebelum **, dan ** sebelum *.
export const EMPHASIS = [
    ['bolditalic', /(\*\*\*)(?=\S)([\s\S]*?\S)\*\*\*/g, 3],
    ['bolditalic', /(?<!\w)(___)(?=\S)([\s\S]*?\S)___(?!\w)/g, 3],
    ['bold', /(\*\*)(?=\S)([\s\S]*?\S)\*\*/g, 2],
    ['bold', /(?<!\w)(__)(?=\S)([\s\S]*?\S)__(?!\w)/g, 2],
    ['italic', /(\*)(?=[^\s*])([\s\S]*?[^\s*])\*/g, 1],
    ['italic', /(?<!\w)(_)(?=[^\s_])([\s\S]*?[^\s_])_(?!\w)/g, 1],
    ['strike', /(~~)(?=\S)([\s\S]*?\S)~~/g, 2],
    ['mark', /(==)(?=\S)([\s\S]*?\S)==/g, 2],
];
