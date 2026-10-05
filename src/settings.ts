// Pengaturan pengguna, disimpan sebagai JSON di ~/.config/nyerat/settings.json.

import GLib from 'gi://GLib';
import { readTextFile, writeTextFile } from './files.js';

// Tab berfile yang terbuka saat jendela terakhir ditutup, dipulihkan pada pembukaan berikutnya.
export interface SavedTab {
    file: string;
    cursor: number;          // posisi kursor (code point)
}

export interface Settings {
    dark: boolean | null;
    sidebar: boolean;
    sidebarPage: 'files' | 'outline' | 'history';
    chat: boolean;           // panel asisten terbuka
    chatModel: string;       // model DeepSeek untuk asisten
    chatThinking: boolean;   // mode berpikir model (lebih teliti, lebih lambat)
    chatSave: boolean;       // simpan riwayat percakapan di <folder>/.nyerat/chats
    folder: string | null;   // folder yang terakhir dibuka
    tabs: SavedTab[];        // tab yang dipulihkan saat dibuka tanpa argumen
    activeTab: number;       // indeks tab aktif di tabs, -1 = tidak ada
    typewriter: boolean;
    focus: boolean;
    autosave: boolean;
    width: number;
    height: number;
    welcomed: boolean;
    projects: Record<string, string>;   // nama proyek → folder, untuk harness eksternal yang mengerjakan kartu kanban
}

export const DEFAULTS: Settings = {
    dark: null,          // null = ikuti tema sistem
    sidebar: true,
    sidebarPage: 'outline',
    chat: false,
    chatModel: 'deepseek-flash',
    chatThinking: false,
    chatSave: true,
    folder: null,
    tabs: [],
    activeTab: -1,
    typewriter: false,
    focus: false,
    autosave: true,      // simpan otomatis dokumen yang sudah punya file
    width: 1100,
    height: 760,
    welcomed: false,     // dokumen contoh sudah pernah ditampilkan
    projects: {},
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
