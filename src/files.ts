// Read/write UTF-8 text files. Throws on failure; handling is up to the caller.

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

// Background writes in progress, per path.
const pending = new Map<string, number>();

// Write a file without blocking the main thread: Gio writes to a temporary file, fsyncs, then
// atomically replaces the target file in a worker thread. Used by autosave so the fsync pause
// (can be tens of milliseconds on a slow disk) is not felt while the user keeps typing.
// done is called on the main thread; error = null on success.
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

// Wait for background writes to `path` (or to files inside the folder `path`) to finish. Called
// before writing, moving, or deleting a file, so the result of an older background write does not
// overwrite later changes. Rarely waits: a background write takes only
// a few milliseconds.
export function waitForWrites(path: string): void {
    const busy = () => [...pending.keys()].some(p => p === path || p.startsWith(`${path}/`));
    const context = GLib.MainContext.default();
    while (busy()) context.iteration(true);
}

export const fileExists = (path: string): boolean => GLib.file_test(path, GLib.FileTest.EXISTS);
