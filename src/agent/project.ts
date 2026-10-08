// Reads the Markdown files in the project folder as context material. The result is cached by modification time
// and size, so re-reading on every question is cheap even if the book has dozens of files.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { readTextFile } from '../files.js';
import type { SourceFile } from './context.js';

const MARKDOWN_FILE = /\.(md|markdown|mdown|mkd)$/i;
const MAX_FILES = 300;
const MAX_FILE_BYTES = 2_000_000;
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build']);

const cache = new Map<string, { stamp: string; text: string }>();

// Walk the Markdown files under root (excluding dot files and the tools' built-in folders) alphabetically.
// visit receives the file info, the full path, and the relative name; false = stop.
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

// Relative names of all Markdown files under root without reading their contents (for [[note]] suggestions).
export function listMarkdownFiles(root: string, limit = 5000): string[] {
    const names: string[] = [];
    walkMarkdown(root, (_info, _path, name) => names.push(name) < limit);
    return names;
}

// All Markdown files under root (excluding dot files and the tools' built-in folders), except `except`.
// Names are returned relative to the root. `keep` filters by contents before the file limit, so a caller
// that only wants some files (Home: boards and inboxes) still finds them past the first MAX_FILES files.
export function readProject(root: string, except: string | null, fresh = false, keep?: (text: string) => boolean): SourceFile[] {
    const files: SourceFile[] = [];
    const seen = new Set<string>();
    let complete = true;
    walkMarkdown(root, (info, path, name) => {
        seen.add(path);
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
        if (keep && !keep(entry.text)) return true;
        files.push({ name, text: entry.text });
        complete = files.length < MAX_FILES;
        return complete;
    });
    // Forget files under root that were deleted or moved, so the cache does not grow with stale texts.
    if (complete) {
        const prefix = root.endsWith('/') ? root : `${root}/`;
        for (const path of cache.keys()) if (path.startsWith(prefix) && !seen.has(path)) cache.delete(path);
    }
    return files;
}
