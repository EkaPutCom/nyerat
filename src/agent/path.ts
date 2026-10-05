// Validasi nama dilengkapi penolakan symlink agar penulisan tetap di folder proyek.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { cleanNewName } from './changes.js';

export function projectPath(root: string, file: string): string {
    if (cleanNewName(file) !== file) throw Error('path di luar folder kerja atau tidak valid');
    let current = root;
    for (const part of file.split('/')) {
        current = GLib.build_filenamev([current, part]);
        const entry = Gio.File.new_for_path(current);
        try {
            const info = entry.query_info('standard::is-symlink', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            if (info.get_is_symlink()) throw Error('path melewati tautan simbolik di luar batas akses agent');
        } catch (e) {
            if (e instanceof GLib.Error && e.matches(Gio.io_error_quark(), Gio.IOErrorEnum.NOT_FOUND)) continue;
            throw e;
        }
    }
    return current;
}
