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
    flushWrites(path);
    GLib.file_set_contents(path, enc.encode(text));
    notifyDiskChange(path);
}

// Changes the app itself makes on disk (writes here, file operations in fileops.ts). Listeners (the
// workspace snapshot) hear of them right away, before a file monitor would report them.
const diskListeners = new Set<(path: string) => void>();

export function onDiskChange(listener: (path: string) => void): () => void {
    diskListeners.add(listener);
    return () => diskListeners.delete(listener);
}

export function notifyDiskChange(...paths: string[]): void {
    for (const listener of diskListeners) for (const path of paths) listener(path);
}

type Done = (error: unknown) => void;

// Background writes per path: at most one runs at a time, and at most one waits behind it. A newer
// write replaces the waiting one (its text is newer), so an older version can never finish last.
// The callbacks of a replaced write are called when the write that replaced it finishes.
interface Queue {
    running: Done[];
    next: { text: string; done: Done[] } | null;
}
const queues = new Map<string, Queue>();

// Background writes report back on their own main context, not the default one. Waiting for them
// (flushWrites) then runs only their completions, never other application callbacks such as
// timers or input. The default main loop drives this context with a short timer while writes run.
const ioContext = new GLib.MainContext();
// Finished writes whose callbacks have not been called yet. Called only from the default main loop.
const finished: { done: Done[]; error: unknown }[] = [];
let pumpTimer = 0;

function pumpIo(wait: boolean): void {
    ioContext.push_thread_default();
    try {
        if (wait) ioContext.iteration(true);
        while (ioContext.iteration(false)) { /* run all ready completions */ }
    } finally {
        ioContext.pop_thread_default();
    }
}

function ensurePump(): void {
    if (pumpTimer) return;
    pumpTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4, () => {
        pumpIo(false);
        for (const { done, error } of finished.splice(0)) for (const d of done) d(error);
        if (queues.size || finished.length) return GLib.SOURCE_CONTINUE;
        pumpTimer = 0;
        return GLib.SOURCE_REMOVE;
    });
}

function start(path: string, text: string, queue: Queue): void {
    const complete = (error: unknown) => {
        if (!error) notifyDiskChange(path);
        finished.push({ done: queue.running, error });
        const next = queue.next;
        queue.next = null;
        if (next) {
            queue.running = next.done;
            start(path, next.text, queue);
        } else {
            queues.delete(path);
        }
    };
    ioContext.push_thread_default();
    try {
        Gio.File.new_for_path(path).replace_contents_bytes_async(new GLib.Bytes(enc.encode(text)), null, false,
            Gio.FileCreateFlags.NONE, null, (file, result) => {
                try {
                    file!.replace_contents_finish(result);
                    complete(null);
                } catch (e) {
                    complete(e);
                }
            });
    } catch (e) {
        complete(e);
    } finally {
        ioContext.pop_thread_default();
    }
}

// Write a file without blocking the main thread: Gio writes to a temporary file, fsyncs, then
// atomically replaces the target file in a worker thread. Used by autosave so the fsync pause
// (can be tens of milliseconds on a slow disk) is not felt while the user keeps typing.
// Writes to the same path finish in the order they were requested; a write that has not started
// yet is replaced by a newer one. done is called later from the default main loop, never during
// this call or during flushWrites; error = null on success.
export function writeTextFileAsync(path: string, text: string, done: Done): void {
    const queue = queues.get(path);
    if (queue) {
        queue.next = { text, done: [...queue.next?.done ?? [], done] };
    } else {
        const fresh: Queue = { running: [done], next: null };
        queues.set(path, fresh);
        start(path, text, fresh);
    }
    ensurePump();
}

// Finish the background writes to `path` (or to files inside the folder `path`), including any
// waiting ones. Called before writing, moving, or deleting a file, so the result of an older
// background write does not overwrite later changes. Only write completions run while it waits;
// their done callbacks follow later from the main loop. Rarely waits: a background write takes
// only a few milliseconds.
export function flushWrites(path: string): void {
    const busy = () => [...queues.keys()].some(p => p === path || p.startsWith(`${path}/`));
    while (busy()) pumpIo(true);
}

export const fileExists = (path: string): boolean => GLib.file_test(path, GLib.FileTest.EXISTS);
