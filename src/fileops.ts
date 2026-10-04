// Operasi berkas di disk untuk pohon folder: buat file, buat folder, pindahkan.
// Semua melempar Error berpesan bahasa Indonesia yang siap ditampilkan ke pengguna.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const MARKDOWN_EXTENSION = /\.(md|markdown|mdown|mkd)$/i;

const join = (dir: string, name: string): string => GLib.build_filenamev([dir, name]);
const exists = (path: string): boolean => GLib.file_test(path, GLib.FileTest.EXISTS);

// Kembalikan nama bersih, atau lempar jika tidak boleh dipakai.
function cleanName(raw: string): string {
    const name = raw.trim();
    if (!name) throw new Error('Nama tidak boleh kosong.');
    if (name.includes('/')) throw new Error('Nama tidak boleh memuat “/”.');
    if (name === '.' || name === '..') throw new Error('Nama tidak valid.');
    // Berkas bertitik tidak ditampilkan di pohon, jadi hasilnya akan seolah hilang.
    if (name.startsWith('.')) throw new Error('Nama tidak boleh diawali titik (akan disembunyikan dari pohon).');
    return name;
}

// Buat file kosong; ekstensi .md ditambahkan jika bukan ekstensi Markdown, supaya tampil di pohon.
export function createFile(dir: string, rawName: string): string {
    let name = cleanName(rawName);
    if (!MARKDOWN_EXTENSION.test(name)) name += '.md';
    const path = join(dir, name);
    if (exists(path)) throw new Error(`“${name}” sudah ada di folder ini.`);
    try {
        Gio.File.new_for_path(path).create(Gio.FileCreateFlags.NONE, null).close(null);
    } catch (e) {
        throw new Error(`Gagal membuat file: ${(e as Error).message}`);
    }
    return path;
}

export function createFolder(dir: string, rawName: string): string {
    const name = cleanName(rawName);
    const path = join(dir, name);
    if (exists(path)) throw new Error(`“${name}” sudah ada di folder ini.`);
    try {
        Gio.File.new_for_path(path).make_directory(null);
    } catch (e) {
        throw new Error(`Gagal membuat folder: ${(e as Error).message}`);
    }
    return path;
}

// Pindahkan file/folder ke dalam destDir. Mengembalikan path baru, atau null jika
// tidak ada yang berubah (sudah berada di folder itu).
export function moveEntry(source: string, destDir: string): string | null {
    const name = GLib.path_get_basename(source);
    if (GLib.path_get_dirname(source) === destDir) return null;
    if (destDir === source || destDir.startsWith(`${source}/`)) {
        throw new Error('Folder tidak bisa dipindahkan ke dalam dirinya sendiri.');
    }
    const target = join(destDir, name);
    if (exists(target)) throw new Error(`“${name}” sudah ada di folder tujuan.`);
    try {
        Gio.File.new_for_path(source).move(Gio.File.new_for_path(target), Gio.FileCopyFlags.NONE, null, null);
    } catch (e) {
        throw new Error(`Gagal memindahkan: ${(e as Error).message}`);
    }
    return target;
}

// Path setelah source dipindah ke target: path itu sendiri atau isi di dalamnya (jika source folder).
export function remapPath(path: string, source: string, target: string): string | null {
    if (path === source) return target;
    if (path.startsWith(`${source}/`)) return target + path.slice(source.length);
    return null;
}

// Ganti nama file/folder di tempatnya. Mengembalikan path baru, atau null jika namanya tidak berubah.
// File tetap diberi ekstensi Markdown supaya tidak hilang dari pohon.
export function renameEntry(path: string, rawName: string): string | null {
    let name = cleanName(rawName);
    const isDir = GLib.file_test(path, GLib.FileTest.IS_DIR);
    if (!isDir && !MARKDOWN_EXTENSION.test(name)) name += '.md';
    if (name === GLib.path_get_basename(path)) return null;
    const target = join(GLib.path_get_dirname(path), name);
    if (exists(target)) throw new Error(`“${name}” sudah ada di folder ini.`);
    try {
        Gio.File.new_for_path(path).move(Gio.File.new_for_path(target), Gio.FileCopyFlags.NONE, null, null);
    } catch (e) {
        throw new Error(`Gagal mengganti nama: ${(e as Error).message}`);
    }
    return target;
}

// Buang ke Tempat Sampah (bisa dipulihkan), bukan hapus permanen.
export function trashEntry(path: string): void {
    try {
        Gio.File.new_for_path(path).trash(null);
    } catch (e) {
        throw new Error(`Gagal menghapus: ${(e as Error).message}`);
    }
}
