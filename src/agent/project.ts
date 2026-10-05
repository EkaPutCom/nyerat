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

// Telusuri berkas Markdown di bawah root (tanpa yang bertitik dan folder bawaan alat) menurut abjad.
// visit menerima info berkas, path lengkap, dan nama relatif; false = berhenti.
function walkMarkdown(root: string, visit: (info: Gio.FileInfo, path: string, name: string) => boolean): void {
    let stopped = false;
    const walk = (dir: string, prefix: string) => {
        let children: Gio.FileInfo[] = [];
        try {
            const enumerator = Gio.File.new_for_path(dir).enumerate_children('standard::name,standard::type,standard::size,time::modified,time::modified-usec', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            for (let info = enumerator.next_file(null); info; info = enumerator.next_file(null)) children.push(info);
            enumerator.close(null);
        } catch (e) {
            return;
        }
        children.sort((a, b) => a.get_name().localeCompare(b.get_name(), 'id', { numeric: true }));
        for (const info of children) {
            if (stopped) return;
            const name = info.get_name();
            if (name.startsWith('.')) continue;
            const path = GLib.build_filenamev([dir, name]);
            const type = info.get_file_type();
            if (type === Gio.FileType.DIRECTORY) {
                if (!SKIPPED_DIRS.has(name)) walk(path, `${prefix}${name}/`);
            } else if (type === Gio.FileType.REGULAR && MARKDOWN_FILE.test(name)) {
                if (!visit(info, path, `${prefix}${name}`)) stopped = true;
            }
        }
    };
    walk(root, '');
}

// Nama relatif semua berkas Markdown di bawah root tanpa membaca isinya (untuk saran [[catatan]]).
export function listMarkdownFiles(root: string, limit = 5000): string[] {
    const names: string[] = [];
    walkMarkdown(root, (_info, _path, name) => names.push(name) < limit);
    return names;
}

// Semua berkas Markdown di bawah root (tanpa yang bertitik dan folder bawaan alat), kecuali `except`.
// Nama dikembalikan relatif terhadap root.
export function readProject(root: string, except: string | null, fresh = false): SourceFile[] {
    const files: SourceFile[] = [];
    walkMarkdown(root, (info, path, name) => {
        if (path === except || info.get_size() > MAX_FILE_BYTES) return true;
        const stamp = `${info.get_size()}:${info.get_modification_date_time()?.to_unix() ?? 0}:${info.get_attribute_uint32('time::modified-usec')}`;
        let entry = cache.get(path);
        if (fresh || entry?.stamp !== stamp) {
            try {
                entry = { stamp, text: readTextFile(path) };
            } catch (e) {
                return true;
            }
            cache.set(path, entry);
        }
        files.push({ name, text: entry.text });
        return files.length < MAX_FILES;
    });
    return files;
}
