// Pengaturan pengguna, disimpan sebagai JSON di ~/.config/nyerat/settings.json.

import GLib from 'gi://GLib';
import { readTextFile, writeTextFile } from './files.js';

export interface Settings {
    dark: boolean | null;
    sidebar: boolean;
    typewriter: boolean;
    focus: boolean;
    width: number;
    height: number;
    welcomed: boolean;
}

export const DEFAULTS: Settings = {
    dark: null,          // null = ikuti tema sistem
    sidebar: true,
    typewriter: false,
    focus: false,
    width: 1100,
    height: 760,
    welcomed: false,     // dokumen contoh sudah pernah ditampilkan
};

// Dihitung saat dipanggil (bukan saat import) supaya tes bisa mengganti XDG_CONFIG_HOME.
const configDir = () => GLib.build_filenamev([GLib.get_user_config_dir(), 'nyerat']);
const configFile = () => GLib.build_filenamev([configDir(), 'settings.json']);

export function loadSettings(): Settings {
    try {
        return { ...DEFAULTS, ...JSON.parse(readTextFile(configFile())) };
    } catch (e) {
        return { ...DEFAULTS };
    }
}

export function saveSettings(settings: Settings): void {
    try {
        GLib.mkdir_with_parents(configDir(), 0o755);
        writeTextFile(configFile(), JSON.stringify(settings, null, 2));
    } catch (e) {
        logError(e);
    }
}
