// Name validation plus symlink rejection so that writes stay inside the project folder.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { cleanNewName } from './changes.js';

export function projectPath(root: string, file: string): string {
    if (cleanNewName(file) !== file) throw Error('path is outside the work folder or invalid');
    let current = root;
    for (const part of file.split('/')) {
        current = GLib.build_filenamev([current, part]);
        const entry = Gio.File.new_for_path(current);
        try {
            const info = entry.query_info('standard::is-symlink', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            if (info.get_is_symlink()) throw Error('path goes through a symbolic link outside the agent access boundary');
        } catch (e) {
            if (e instanceof GLib.Error && e.matches(Gio.io_error_quark(), Gio.IOErrorEnum.NOT_FOUND)) continue;
            throw e;
        }
    }
    return current;
}
