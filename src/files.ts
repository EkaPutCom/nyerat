// Baca/tulis file teks UTF-8. Melempar error jika gagal; penanganannya di pemanggil.

import GLib from 'gi://GLib';

const enc = new TextEncoder();
const dec = new TextDecoder();

export function readTextFile(path: string): string {
    const [, bytes] = GLib.file_get_contents(path);
    return dec.decode(bytes);
}

export function writeTextFile(path: string, text: string): void {
    GLib.file_set_contents(path, enc.encode(text));
}

export const fileExists = (path: string): boolean => GLib.file_test(path, GLib.FileTest.EXISTS);
