// Tabel Markdown (GFM): mengenali blok tabel, memecah baris menjadi sel, dan
// operasi atas tabel (tambah/hapus baris dan kolom, rata kiri/tengah/kanan,
// merapikan). Murni TypeScript tanpa GTK, sehingga mudah diuji.
//
// Bentuk tabel:
//
//   | Nama  | Nilai |      ← baris judul
//   | :---- | ----: |      ← baris pemisah; titik dua menentukan perataan
//   | satu  |     1 |      ← baris isi (boleh tanpa pipa di tepi)

import { RE, startsTable } from './syntax.js';

export type Align = 'left' | 'center' | 'right' | null;

// Rentang baris sebuah tabel di dokumen (inklusif): baris judul … baris isi terakhir.
export interface TableRange {
    start: number;
    end: number;
}

// Isi tabel. Jumlah kolom ditentukan baris judul, seperti GFM: sel berlebih di
// baris isi dibuang, sel yang kurang dianggap kosong.
export interface Table {
    header: string[];
    aligns: Align[];
    rows: string[][];
}

// ---------- Mengenali blok tabel ----------

// Baris isi terakhir tabel yang judulnya di baris `start` (pemisah di start + 1).
// Tabel berakhir di baris kosong, baris tanpa pipa, atau awal blok lain.
export function tableEnd(lines: string[], start: number): number {
    let end = start + 1;
    while (end + 1 < lines.length) {
        const line = lines[end + 1];
        if (!line.trim() || !line.includes('|') || RE.heading.test(line) || RE.fence.test(line)
            || RE.hr.test(line) || /^\s{0,3}>/.test(line)) break;
        end++;
    }
    return end;
}

// Semua tabel di dokumen, tidak termasuk yang berada di dalam blok kode.
export function findTables(lines: string[]): TableRange[] {
    const tables: TableRange[] = [];
    let fence: { ch: string; len: number } | null = null;
    for (let i = 0; i < lines.length; i++) {
        const m = RE.fence.exec(lines[i]);
        if (fence) {
            if (m && m[2][0] === fence.ch && m[2].length >= fence.len && !m[3].trim()) fence = null;
            continue;
        }
        if (m && !(m[2][0] === '`' && m[3].includes('`'))) {
            fence = { ch: m[2][0], len: m[2].length };
            continue;
        }
        if (startsTable(lines, i) && !RE.heading.test(lines[i])) {
            const end = tableEnd(lines, i);
            tables.push({ start: i, end });
            i = end;
        }
    }
    return tables;
}

// ---------- Memecah baris ----------

export interface CellSpan {
    text: string;    // isi sel tanpa spasi di tepi; Markdown mentah (\| tetap ada)
    start: number;   // posisi awal isi di baris (UTF-16); sel kosong: posisi kursor yang wajar
    end: number;
}

// Posisi pipa yang bukan bagian dari \|.
function pipePositions(line: string): number[] {
    const pipes: number[] = [];
    for (let i = 0; i < line.length; i++) {
        if (line[i] === '\\') i++;
        else if (line[i] === '|') pipes.push(i);
    }
    return pipes;
}

// Memecah satu baris tabel menjadi sel. Pipa di awal dan akhir baris hanya pembatas,
// bukan sel kosong: "| a | b |" dan "a | b" sama-sama berisi dua sel.
export function splitRow(line: string): CellSpan[] {
    const pipes = pipePositions(line);
    const leading = pipes.length > 0 && line.slice(0, pipes[0]).trim() === '';
    const lastPipe = pipes[pipes.length - 1];
    const trailing = pipes.length > 0 && !(leading && pipes.length === 1) && line.slice(lastPipe + 1).trim() === '';

    // Batas antar sel; -1 dan line.length adalah batas maya jika pipa di tepi tidak ada.
    const bounds = [...(leading ? [] : [-1]), ...pipes, ...(trailing ? [] : [line.length])];
    const cells: CellSpan[] = [];
    for (let k = 0; k + 1 < bounds.length; k++) {
        const from = bounds[k] + 1, to = bounds[k + 1];
        const raw = line.slice(from, to);
        const text = raw.trim();
        if (text) {
            const start = from + raw.length - raw.trimStart().length;
            cells.push({ text, start, end: start + text.length });
        } else {
            const at = Math.min(from + (raw.startsWith(' ') ? 1 : 0), to);  // setelah "| "
            cells.push({ text: '', start: at, end: at });
        }
    }
    return cells;
}

// Kolom (mulai 0) yang memuat posisi `offset` (UTF-16) di baris tabel.
export function cellIndexAt(line: string, offset: number): number {
    const pipes = pipePositions(line);
    const leading = pipes.length > 0 && line.slice(0, pipes[0]).trim() === '';
    const before = pipes.filter(p => p < offset).length;
    return Math.max(0, before - (leading ? 1 : 0));
}

// Posisi kursor (UTF-16) di awal isi sel `col`; di akhir baris jika sel itu tidak ada.
export function cellStart(line: string, col: number): number {
    const cells = splitRow(line);
    return cells[col]?.start ?? line.trimEnd().length;
}

// ---------- Membaca dan menulis ----------

const alignOf = (cell: string): Align => {
    const left = cell.startsWith(':'), right = cell.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
};

const fitCells = (cells: string[], n: number): string[] =>
    Array.from({ length: n }, (_, i) => cells[i] ?? '');

// lines: baris judul, baris pemisah, lalu baris isi.
export function parseTable(lines: string[]): Table {
    const header = splitRow(lines[0]).map(c => c.text);
    const n = header.length;
    const separators = splitRow(lines[1]);
    const aligns = Array.from({ length: n }, (_, c) => alignOf(separators[c]?.text ?? ''));
    const rows = lines.slice(2).map(line => fitCells(splitRow(line).map(c => c.text), n));
    return { header, aligns, rows };
}

// Lebar tampilan teks dalam kolom monospace: huruf CJK dan emoji dua kolom,
// tanda gabung dan pengubah emoji nol kolom.
const WIDE: [number, number][] = [
    [0x1100, 0x115F], [0x2E80, 0x303E], [0x3041, 0x33FF], [0x3400, 0x4DBF], [0x4E00, 0x9FFF],
    [0xA000, 0xA4CF], [0xAC00, 0xD7A3], [0xF900, 0xFAFF], [0xFE30, 0xFE6F], [0xFF00, 0xFF60],
    [0xFFE0, 0xFFE6], [0x1F300, 0x1F64F], [0x1F680, 0x1F6FF], [0x1F900, 0x1F9FF], [0x20000, 0x3FFFD],
];
const ZERO: [number, number][] = [
    [0x0300, 0x036F], [0x200B, 0x200F], [0x20D0, 0x20FF], [0xFE00, 0xFE0F], [0x1F3FB, 0x1F3FF],
];
const within = (ranges: [number, number][], cp: number) => ranges.some(([a, b]) => cp >= a && cp <= b);

export function displayWidth(text: string): number {
    let width = 0;
    for (const ch of text) {
        const cp = ch.codePointAt(0)!;
        width += within(ZERO, cp) ? 0 : within(WIDE, cp) ? 2 : 1;
    }
    return width;
}

function fit(text: string, width: number, align: Align): string {
    const gap = width - displayWidth(text);
    if (gap <= 0) return text;
    if (align === 'right') return ' '.repeat(gap) + text;
    if (align === 'center') return ' '.repeat(Math.floor(gap / 2)) + text + ' '.repeat(Math.ceil(gap / 2));
    return text + ' '.repeat(gap);
}

function separator(width: number, align: Align): string {
    if (align === 'center') return `:${'-'.repeat(width - 2)}:`;
    if (align === 'left') return `:${'-'.repeat(width - 1)}`;
    if (align === 'right') return `${'-'.repeat(width - 1)}:`;
    return '-'.repeat(width);
}

// Menulis tabel menjadi baris Markdown dengan kolom yang rapi (lebar kolom sama).
export function renderTable(table: Table): string[] {
    const n = table.header.length;
    const widths = Array.from({ length: n }, (_, c) =>
        Math.max(3, displayWidth(table.header[c]), ...table.rows.map(r => displayWidth(r[c]))));
    const row = (cells: string[]) => `| ${cells.map((t, c) => fit(t, widths[c], table.aligns[c])).join(' | ')} |`;
    return [
        row(table.header),
        `| ${widths.map((w, c) => separator(w, table.aligns[c])).join(' | ')} |`,
        ...table.rows.map(row),
    ];
}

// Satu baris saja, tanpa merapikan kolom (untuk baris baru yang disisipkan saat mengetik).
export const renderRow = (cells: string[]): string => `| ${cells.join(' | ')} |`;

// ---------- Operasi ----------
// Semua operasi mengembalikan tabel baru; tabel asal tidak diubah.

// Sisipkan baris kosong sebelum rows[at] (at = rows.length: di akhir).
export function insertRow(table: Table, at: number): Table {
    const rows = [...table.rows];
    rows.splice(at, 0, table.header.map(() => ''));
    return { ...table, rows };
}

export function deleteRow(table: Table, at: number): Table {
    return { ...table, rows: table.rows.filter((_, i) => i !== at) };
}

// Sisipkan kolom kosong sebelum kolom `at` (at = jumlah kolom: di kanan sendiri).
export function insertColumn(table: Table, at: number): Table {
    const put = <T>(cells: T[], value: T) => [...cells.slice(0, at), value, ...cells.slice(at)];
    return {
        header: put(table.header, ''),
        aligns: put<Align>(table.aligns, null),
        rows: table.rows.map(r => put(r, '')),
    };
}

// Kolom terakhir tidak bisa dihapus: tabel tanpa kolom bukan tabel.
export function deleteColumn(table: Table, at: number): Table {
    if (table.header.length <= 1) return table;
    const drop = <T>(cells: T[]) => cells.filter((_, i) => i !== at);
    return { header: drop(table.header), aligns: drop(table.aligns), rows: table.rows.map(drop) };
}

export function setAlign(table: Table, col: number, align: Align): Table {
    return { ...table, aligns: table.aligns.map((a, c) => (c === col ? align : a)) };
}
