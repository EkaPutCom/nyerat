// Tes GUI: File.

import GLib from 'gi://GLib';
import { section, test, eq, ok, tmp } from '../framework.js';
import { readTextFile } from '../../src/files.js';
import type { GuiContext } from './context.js';

export function fileTests(c: GuiContext): void {
    const { w, buf, text, setText, pump } = c;

    section('File');
    test('saving and reopening gives the same contents', () => {
        const path = GLib.build_filenamev([tmp, 'uji.md']);
        const content = '# Uji 🎉\n\nÄÖÜ — ✓\n';
        setText(content);
        w.file = path;
        ok(w.save(), 'save() failed');
        ok(!buf.get_modified(), 'the modified status was not reset');
        setText('');
        ok(w.load(path), 'load() failed');
        eq(text(), content);
    });

    test('autosave writes the file after a typing pause', () => {
        const path = GLib.build_filenamev([tmp, 'auto.md']);
        setText('');
        w.file = path;
        ok(w.save(), 'save() failed');
        w.setOption('autosave', true);
        buf.insert_at_cursor('# Hello', -1);
        pump();
        eq(readTextFile(path), '', 'not written before the pause');
        ok(buf.get_modified(), 'still marked as modified');
        for (let i = 0; i < 150 && buf.get_modified(); i++) { pump(); GLib.usleep(10000); }
        eq(readTextFile(path), '# Hello', 'file contents');
        ok(!buf.get_modified(), 'the modified status was reset');
    });

    test('background autosave: edits made while writing stay marked as modified', () => {
        const path = GLib.build_filenamev([tmp, 'auto.md']);
        let finished = false;
        ok(w.autosaveInBackground(undefined, () => { finished = true; }) === false, 'no changes, no writing');
        buf.insert_at_cursor(' A', -1);
        pump();
        ok(w.autosaveInBackground(undefined, () => { finished = true; }), 'the background write did not start');
        buf.insert_at_cursor('B', -1);   // typed before the write finished
        for (let i = 0; i < 500 && !finished; i++) { pump(); GLib.usleep(2000); }
        ok(finished, 'the background write did not finish');
        eq(readTextFile(path), '# Hello A', 'the written contents are the copy from when it started');
        ok(buf.get_modified(), 'B is not saved yet, but the modified status was reset');
    });

    test('saving right after a background autosave is not overwritten by the old contents', () => {
        const path = GLib.build_filenamev([tmp, 'auto.md']);
        ok(w.autosaveInBackground(), 'the background write did not start');
        buf.insert_at_cursor('C', -1);
        ok(w.save(), 'save() failed');   // waits for the background write, then writes the latest contents
        for (let i = 0; i < 20; i++) { pump(); GLib.usleep(2000); }
        eq(readTextFile(path), '# Hello ABC', 'file contents');
        ok(!buf.get_modified(), 'status modified');
        buf.delete(buf.get_iter_at_offset(7), buf.get_end_iter());
        ok(w.save(), 'save() failed');
    });

    test('autosave saves without asking when switching documents', () => {
        const path = GLib.build_filenamev([tmp, 'auto.md']);
        buf.insert_at_cursor('!', -1);
        pump();
        // Without autosave, closing a document opens a dialog and the test would hang. Switching tabs
        // is a safe point: the document that is left is saved immediately.
        w.newDocument();
        eq(readTextFile(path), '# Hello!', 'file contents');
        eq(w.file, null, 'new document');
        eq(w.documentCount, 2, 'the new document was opened in a new tab');
        ok(w.closeTab(), 'closeTab() failed');
        ok(w.editor === c.ed, 'the original editor is no longer active');
        w.file = null;
    });

    test('autosave does not touch a document without a file', () => {
        buf.insert_at_cursor('x', -1);
        pump();
        ok(!w.autosave(), 'autosave() reported saved');
        ok(buf.get_modified(), 'the modified status was reset');
        w.setOption('autosave', false);
        setText('');
    });
}
