// Penyimpanan API key. Urutan: variabel lingkungan DEEPSEEK_API_KEY, lalu keyring sistem (libsecret),
// lalu file ~/.config/nyerat/deepseek.key (mode 0600) jika keyring tidak tersedia (mis. desktop tanpa gnome-keyring).
// Key tidak pernah ditulis ke settings.json.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { readTextFile, writeTextFile, fileExists } from '../files.js';

export type KeySource = 'env' | 'keyring' | 'file';

export interface KeyStore {
    get(): Promise<{ key: string; source: KeySource } | null>;
    set(key: string): Promise<KeySource>;
    clear(): Promise<void>;
}

const ATTRIBUTES = { provider: 'deepseek' };
const keyFile = () => GLib.build_filenamev([GLib.get_user_config_dir(), 'nyerat', 'deepseek.key']);

// libsecret dimuat saat dibutuhkan; typelib yang hilang atau layanan keyring yang mati tidak boleh mematikan aplikasi.
function removeKeyFile(): void {
    try { Gio.File.new_for_path(keyFile()).delete(null); } catch (e) { /* belum ada */ }
}

async function loadSecret() {
    try {
        const Secret = (await import('gi://Secret')).default;
        const schema = Secret.Schema.new('com.ekaput.nyerat', Secret.SchemaFlags.NONE, { provider: Secret.SchemaAttributeType.STRING });
        return { Secret, schema };
    } catch (e) {
        return null;
    }
}

export const systemKeyStore: KeyStore = {
    async get() {
        const env = GLib.getenv('DEEPSEEK_API_KEY')?.trim();
        if (env) return { key: env, source: 'env' };
        const secret = await loadSecret();
        if (secret) {
            try {
                const key = secret.Secret.password_lookup_sync(secret.schema, ATTRIBUTES, null);
                if (key) return { key, source: 'keyring' };
            } catch (e) { /* lanjut ke file */ }
        }
        try {
            const key = fileExists(keyFile()) ? readTextFile(keyFile()).trim() : '';
            if (key) return { key, source: 'file' };
        } catch (e) { /* tidak terbaca = belum ada */ }
        return null;
    },

    async set(key) {
        const secret = await loadSecret();
        if (secret) {
            try {
                if (secret.Secret.password_store_sync(secret.schema, ATTRIBUTES, secret.Secret.COLLECTION_DEFAULT, 'Nyerat: API key DeepSeek', key, null)) {
                    removeKeyFile();
                    return 'keyring';
                }
            } catch (e) { /* keyring tidak tersedia; pakai file */ }
        }
        GLib.mkdir_with_parents(GLib.path_get_dirname(keyFile()), 0o700);
        writeTextFile(keyFile(), key);
        // Batasi akses: hanya pemilik yang boleh membaca.
        Gio.File.new_for_path(keyFile()).set_attribute_uint32('unix::mode', 0o600, Gio.FileQueryInfoFlags.NONE, null);
        return 'file';
    },

    async clear() {
        const secret = await loadSecret();
        if (secret) {
            try { secret.Secret.password_clear_sync(secret.schema, ATTRIBUTES, null); } catch (e) { /* abaikan */ }
        }
        removeKeyFile();
    },
};
