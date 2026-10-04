// Baca/tulis file teks UTF-8. Melempar error jika gagal; penanganannya di pemanggil.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const enc = new TextEncoder();
const dec = new TextDecoder();

export function readTextFile(path: string): string {
    const [, bytes] = GLib.file_get_contents(path);
    return dec.decode(bytes);
}

export function writeTextFile(path: string, text: string): void {
    waitForWrites(path);
    GLib.file_set_contents(path, enc.encode(text));
}

// Penulisan latar yang sedang berjalan, per path.
const pending = new Map<string, number>();

// Tulis file tanpa menahan thread utama: Gio menulis ke file sementara, fsync, lalu
// mengganti file tujuan secara atomik di thread pekerja. Dipakai auto save supaya jeda
// fsync (bisa puluhan milidetik di disk lambat) tidak terasa saat pengguna lanjut mengetik.
// done dipanggil di thread utama; error = null jika berhasil.
export function writeTextFileAsync(path: string, text: string, done: (error: unknown) => void): void {
    pending.set(path, (pending.get(path) ?? 0) + 1);
    const finish = (error: unknown) => {
        const left = (pending.get(path) ?? 1) - 1;
        if (left > 0) pending.set(path, left);
        else pending.delete(path);
        done(error);
    };
    try {
        Gio.File.new_for_path(path).replace_contents_bytes_async(new GLib.Bytes(enc.encode(text)), null, false,
            Gio.FileCreateFlags.NONE, null, (file, result) => {
                try {
                    file!.replace_contents_finish(result);
                    finish(null);
                } catch (e) {
                    finish(e);
                }
            });
    } catch (e) {
        finish(e);
    }
}

// Tunggu penulisan latar ke `path` (atau ke file di dalam folder `path`) selesai. Dipanggil
// sebelum menulis, memindah, atau membuang file, supaya hasil penulisan latar yang lebih
// lama tidak menimpa perubahan sesudahnya. Jarang menunggu: penulisan latar hanya
// beberapa milidetik.
export function waitForWrites(path: string): void {
    const busy = () => [...pending.keys()].some(p => p === path || p.startsWith(`${path}/`));
    const context = GLib.MainContext.default();
    while (busy()) context.iteration(true);
}

export const fileExists = (path: string): boolean => GLib.file_test(path, GLib.FileTest.EXISTS);
