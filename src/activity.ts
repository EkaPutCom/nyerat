// Log aktivitas harian untuk jurnal: satu berkas JSONL per hari di <folder kerja>/.nyerat/aktivitas/.
// Hanya ditambah (append), jadi tidak ada indeks yang bisa basi dan tulisan yang terputus paling banyak
// merusak satu baris (dilewati saat dibaca). Folder bertitik tidak dibaca readProject, jadi agent tidak
// menelusurinya; isinya sampai ke agent hanya lewat bagian Aktivitas di berkas jurnal.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { readTextFile, writeTextFile } from './files.js';
import { parseActivity, serializeActivity, type Activity } from './markdown/jurnal.js';
import { localDate } from './markdown/home.js';

const enc = new TextEncoder();

export const activityDir = (root: string): string => GLib.build_filenamev([root, '.nyerat', 'aktivitas']);
const logPath = (root: string, date: string) => GLib.build_filenamev([activityDir(root), `${date}.jsonl`]);

// Catat satu aktivitas ke log hari itu (menurut waktunya). Gagal menulis tidak boleh mengganggu pekerjaan
// yang memicunya, jadi galat ditelan dan dilaporkan sebagai false.
export function recordActivity(root: string, activity: Activity): boolean {
    try {
        GLib.mkdir_with_parents(activityDir(root), 0o755);
        // Sama seperti riwayat percakapan: jangan ikut ter-commit tanpa disengaja.
        const ignore = GLib.build_filenamev([root, '.nyerat', '.gitignore']);
        if (!GLib.file_test(ignore, GLib.FileTest.EXISTS)) writeTextFile(ignore, '*\n');
        const file = Gio.File.new_for_path(logPath(root, localDate(new Date(activity.time * 1000))));
        const stream = file.append_to(Gio.FileCreateFlags.NONE, null);
        stream.write_all(enc.encode(`${serializeActivity(activity)}\n`), null);
        stream.close(null);
        return true;
    } catch (e) {
        return false;
    }
}

export function readActivity(root: string, date: string): Activity[] {
    const path = logPath(root, date);
    try {
        return GLib.file_test(path, GLib.FileTest.EXISTS) ? parseActivity(readTextFile(path)) : [];
    } catch (e) {
        return [];
    }
}
