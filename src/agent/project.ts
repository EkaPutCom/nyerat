// Membaca berkas Markdown di folder proyek sebagai bahan konteks. Hasil di-cache menurut waktu ubah
// dan ukuran, jadi membaca ulang tiap pertanyaan murah walau bukunya puluhan berkas.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { readTextFile } from '../files.js';
import type { SourceFile } from './context.js';

const MARKDOWN_FILE = /\.(md|markdown|mdown|mkd)$/i;
const MAX_FILES = 300;
const MAX_FILE_BYTES = 2_000_000;
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build']);

const cache = new Map<string, { stamp: string; text: string }>();

// Semua berkas Markdown di bawah root (tanpa yang bertitik dan folder bawaan alat), kecuali `except`.
// Nama dikembalikan relatif terhadap root.
export function readProject(root: string, except: string | null): SourceFile[] {
    const files: SourceFile[] = [];
    const walk = (dir: string, prefix: string) => {
        if (files.length >= MAX_FILES) return;
        let children: Gio.FileInfo[] = [];
        try {
            const enumerator = Gio.File.new_for_path(dir).enumerate_children('standard::name,standard::type,standard::size,time::modified', Gio.FileQueryInfoFlags.NONE, null);
            for (let info = enumerator.next_file(null); info; info = enumerator.next_file(null)) children.push(info);
            enumerator.close(null);
        } catch (e) {
            return;
        }
        children.sort((a, b) => a.get_name().localeCompare(b.get_name(), 'id', { numeric: true }));
        for (const info of children) {
            const name = info.get_name();
            if (name.startsWith('.') || files.length >= MAX_FILES) continue;
            const path = GLib.build_filenamev([dir, name]);
            const type = info.get_file_type();
            if (type === Gio.FileType.DIRECTORY) {
                if (!SKIPPED_DIRS.has(name)) walk(path, `${prefix}${name}/`);
            } else if (type === Gio.FileType.REGULAR && path !== except && MARKDOWN_FILE.test(name)) {
                if (info.get_size() > MAX_FILE_BYTES) continue;
                const stamp = `${info.get_size()}:${info.get_modification_date_time()?.to_unix() ?? 0}`;
                let entry = cache.get(path);
                if (entry?.stamp !== stamp) {
                    try {
                        entry = { stamp, text: readTextFile(path) };
                    } catch (e) {
                        continue;
                    }
                    cache.set(path, entry);
                }
                files.push({ name: `${prefix}${name}`, text: entry.text });
            }
        }
    };
    walk(root, '');
    return files;
}
