// Menyunting tabel di teks mentahnya: Tab/Enter berpindah sel dan baris, serta
// perintah tambah/hapus baris dan kolom, perataan, dan merapikan kolom.
//
// Semua fungsi di sini membaca ulang dokumen dari buffer (bukan dari hasil
// penyorotan terakhir), jadi selalu sesuai dengan teks yang sedang tampil.
// Logika tabelnya sendiri ada di markdown/table.ts.

import type Gtk from 'gi://Gtk?version=4.0';
import { cpLength, cpToU16 } from './offsets.js';
import {
    cellIndexAt, cellStart, deleteColumn, deleteRow, findTables, insertColumn, insertRow,
    parseTable, renderRow, renderTable, setAlign, splitRow, type Align, type TableRange,
} from '../markdown/table.js';
import { iterAtLine } from '../gtkutil.js';

export type TableCommand =
    | 'row-below' | 'row-above' | 'col-right' | 'col-left' | 'delete-row' | 'delete-col'
    | 'align-left' | 'align-center' | 'align-right' | 'format';

export type CommandResult = { ok: true } | { ok: false; reason: string };

// Posisi kursor di dalam tabel. Baris dihitung "logis": 0 = judul (baris pemisah
// dianggap bagian dari judul), 1 = isi pertama, dst.
interface Where {
    table: TableRange;
    lines: string[];
    row: number;
    col: number;
    columns: number;
}

const getLines = (buffer: Gtk.TextBuffer): string[] => {
    const [start, end] = buffer.get_bounds();
    return buffer.get_text(start, end, true).split('\n');
};

const lineOfRow = (table: TableRange, row: number): number => table.start + (row === 0 ? 0 : row + 1);
const lastRow = (table: TableRange): number => table.end - table.start - 1;

function whereIsCursor(buffer: Gtk.TextBuffer): Where | null {
    const lines = getLines(buffer);
    const cursor = buffer.get_iter_at_mark(buffer.get_insert());
    const line = cursor.get_line();
    const table = findTables(lines).find(t => line >= t.start && line <= t.end);
    if (!table) return null;
    const columns = splitRow(lines[table.start]).length;
    const offset = cpToU16(lines[line], cursor.get_line_offset());
    return {
        table, lines, columns,
        row: line <= table.start + 1 ? 0 : line - table.start - 1,
        col: Math.min(cellIndexAt(lines[line], offset), columns - 1),
    };
}

// Kursor ke awal isi sel (row, col). Baris yang selnya kurang: ke akhir baris.
function placeCursor(buffer: Gtk.TextBuffer, line: number, col: number): void {
    const [start, end] = buffer.get_bounds();
    const text = buffer.get_text(start, end, true).split('\n')[line] ?? '';
    const iter = iterAtLine(buffer, line);
    iter.forward_chars(cpLength(text.slice(0, cellStart(text, col))));
    buffer.place_cursor(iter);
}

// Ganti baris start..end dengan newLines dalam satu langkah undo.
function replaceLines(buffer: Gtk.TextBuffer, start: number, end: number, newLines: string[]): void {
    const from = iterAtLine(buffer, start);
    const to = iterAtLine(buffer, end);
    if (!to.ends_line()) to.forward_to_line_end();
    buffer.begin_user_action();
    buffer.delete(from, to);
    buffer.insert(from, newLines.join('\n'), -1);
    buffer.end_user_action();
}

// Tambah satu baris kosong di bawah baris terakhir tabel.
function appendRow(buffer: Gtk.TextBuffer, table: TableRange, columns: number): void {
    const end = iterAtLine(buffer, table.end);
    if (!end.ends_line()) end.forward_to_line_end();
    buffer.begin_user_action();
    buffer.insert(end, `\n${renderRow(Array<string>(columns).fill(''))}`, -1);
    buffer.end_user_action();
}

// ---------- Tab dan Enter ----------

// Tab / Shift+Tab: pindah ke sel berikutnya / sebelumnya. Di sel terakhir, Tab
// menambah baris baru. true jika kursor ada di tabel (tombolnya sudah ditangani).
export function tabInTable(buffer: Gtk.TextBuffer, backward: boolean): boolean {
    const at = whereIsCursor(buffer);
    if (!at) return false;
    const { table, row, col, columns } = at;

    let toRow = row, toCol = col;
    if (!backward) {
        if (col + 1 < columns) toCol = col + 1;
        else { toRow = row + 1; toCol = 0; }
    } else if (col > 0) {
        toCol = col - 1;
    } else if (row > 0) {
        toRow = row - 1;
        toCol = columns - 1;
    } else {
        return true;  // sel pertama: tidak ada yang sebelumnya
    }
    if (toRow > lastRow(table)) appendRow(buffer, table, columns);
    placeCursor(buffer, lineOfRow(table, toRow), toCol);
    return true;
}

// Enter: pindah ke sel yang sama di baris berikutnya (baris baru jika sudah di baris
// terakhir). Di baris isi terakhir yang kosong, Enter menghapus baris itu dan keluar
// dari tabel, seperti Enter di item daftar yang kosong.
export function enterInTable(buffer: Gtk.TextBuffer): boolean {
    const at = whereIsCursor(buffer);
    if (!at) return false;
    const { table, lines, row, col, columns } = at;

    if (row > 0 && row === lastRow(table) && splitRow(lines[table.end]).every(c => c.text === '')) {
        if ((lines[table.end + 1] ?? null) !== null && lines[table.end + 1].trim() === '') {
            // Sudah ada baris kosong di bawah tabel: hapus saja seluruh baris kosongnya
            // (beserta pemisah baris), dan kursor pindah ke baris kosong yang ada.
            const from = iterAtLine(buffer, table.end - 1);
            from.forward_to_line_end();
            const to = iterAtLine(buffer, table.end);
            to.forward_to_line_end();
            buffer.begin_user_action();
            buffer.delete(from, to);
            buffer.end_user_action();
        } else {
            replaceLines(buffer, table.end, table.end, ['']);  // sisakan baris kosong sebagai pemisah
        }
        placeCursor(buffer, table.end, 0);
        return true;
    }
    if (row + 1 > lastRow(table)) appendRow(buffer, table, columns);
    placeCursor(buffer, lineOfRow(table, row + 1), col);
    return true;
}

// ---------- Perintah menu ----------

const ALIGN_OF: Partial<Record<TableCommand, Align>> = { 'align-left': 'left', 'align-center': 'center', 'align-right': 'right' };

// Menjalankan perintah pada tabel di posisi kursor. Hasilnya selalu tabel yang sudah
// dirapikan (lebar kolom disamakan), karena menambah/menghapus kolom mengubah lebarnya.
export function runTableCommand(buffer: Gtk.TextBuffer, command: TableCommand): CommandResult {
    const at = whereIsCursor(buffer);
    if (!at) return { ok: false, reason: 'Kursor harus berada di dalam tabel' };
    const { table, lines, row, col, columns } = at;
    let model = parseTable(lines.slice(table.start, table.end + 1));
    let cursorRow = row, cursorCol = col;
    const body = row - 1;   // indeks di model.rows; -1 = judul

    switch (command) {
        case 'row-below':
            model = insertRow(model, body + 1);
            cursorRow = row + 1;
            break;
        case 'row-above':
            if (row === 0) return { ok: false, reason: 'Tidak bisa menyisipkan baris di atas judul tabel' };
            model = insertRow(model, body);
            break;
        case 'delete-row':
            if (row === 0) return { ok: false, reason: 'Baris judul tidak bisa dihapus' };
            model = deleteRow(model, body);
            cursorRow = Math.min(row, model.rows.length);
            break;
        case 'col-right':
            model = insertColumn(model, col + 1);
            cursorCol = col + 1;
            break;
        case 'col-left':
            model = insertColumn(model, col);
            break;
        case 'delete-col':
            if (columns <= 1) return { ok: false, reason: 'Kolom terakhir tidak bisa dihapus' };
            model = deleteColumn(model, col);
            cursorCol = Math.min(col, columns - 2);
            break;
        case 'format':
            break;
        default:
            model = setAlign(model, col, ALIGN_OF[command] ?? null);
    }

    replaceLines(buffer, table.start, table.end, renderTable(model));
    placeCursor(buffer, lineOfRow({ start: table.start, end: table.start + model.rows.length + 1 }, cursorRow), cursorCol);
    return { ok: true };
}
