// Background write tests: ordering per path, coalescing, and an explicit flush.

import GLib from 'gi://GLib';
import { flushWrites, readTextFile, writeTextFile, writeTextFileAsync } from '../../src/files.js';
import { section, test, eq, ok, tmp } from '../framework.js';

// Runs the default main loop until cond() holds (or fails after timeoutMs).
function pumpUntil(cond: () => boolean, timeoutMs = 5000): void {
    const end = GLib.get_monotonic_time() + timeoutMs * 1000;
    const context = GLib.MainContext.default();
    while (!cond()) {
        if (GLib.get_monotonic_time() > end) throw new Error('timed out');
        if (!context.iteration(false)) GLib.usleep(1000);
    }
}

export function fileWriteTests(): void {
    section('Background writes');
    const base = GLib.build_filenamev([tmp, 'writes']);
    GLib.mkdir_with_parents(base, 0o755);
    const at = (name: string) => GLib.build_filenamev([base, name]);

    test('overlapping background writes to one file end with the newest text', () => {
        const path = at('burst.md');
        const calls: string[] = [];
        for (let i = 1; i <= 20; i++) writeTextFileAsync(path, `v${i}`, e => calls.push(e ? `error ${i}` : `${i}`));
        eq(calls, [], 'done is never called during writeTextFileAsync');
        pumpUntil(() => calls.length === 20);
        eq(readTextFile(path), 'v20', 'file contents');
        eq(calls, Array.from({ length: 20 }, (_, i) => `${i + 1}`), 'callbacks in request order');
    });

    test('flushWrites finishes waiting writes without running other main-loop callbacks', () => {
        const path = at('flush.md');
        let idleRan = false, doneCount = 0;
        GLib.idle_add(GLib.PRIORITY_HIGH, () => { idleRan = true; return GLib.SOURCE_REMOVE; });
        writeTextFileAsync(path, 'old', () => doneCount++);
        writeTextFileAsync(path, 'new', () => doneCount++);
        flushWrites(base);   // a folder flushes the files inside it
        ok(!idleRan, 'flushWrites ran an unrelated callback');
        eq(doneCount, 0, 'done callbacks wait for the main loop');
        eq(readTextFile(path), 'new', 'file contents after the flush');
        pumpUntil(() => idleRan && doneCount === 2);
    });

    test('a synchronous write after background writes is the one that stays', () => {
        const path = at('sync.md');
        let done = 0;
        writeTextFileAsync(path, 'background 1', () => done++);
        writeTextFileAsync(path, 'background 2', () => done++);
        writeTextFile(path, 'saved');
        pumpUntil(() => done === 2);
        eq(readTextFile(path), 'saved', 'file contents');
    });

    test('a failed background write reports its error to every waiting caller', () => {
        const path = at('missing/dir/file.md');
        const errors: unknown[] = [];
        writeTextFileAsync(path, 'a', e => errors.push(e));
        writeTextFileAsync(path, 'b', e => errors.push(e));
        pumpUntil(() => errors.length === 2);
        ok(errors.every(e => e), 'an error was not reported');
    });
}
