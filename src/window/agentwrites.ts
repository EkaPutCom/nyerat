// Applying the Assistant's change proposals once the user has approved them. Open files are changed through their
// editor (one undo step); others are written to disk. In both cases the contents must still equal what the agent saw,
// so the user's edits are not overwritten. Delete moves to the Trash; an open document stays in the editor as when it
// is deleted from the tree.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { readTextFile, writeTextFile, waitForWrites, fileExists } from '../files.js';
import { projectPath } from '../agent/path.js';
import { applyBatch } from '../agent/batch.js';
import { changeFiles, cleanNewName, type Change } from '../agent/changes.js';
import { agentActivity, type ActivityKind } from '../markdown/journal.js';
import { docFor, errorMessage, type Doc, type DocumentHost } from './doc.js';

export interface AgentWriteHost extends DocumentHost {
    refreshTitle(doc: Doc): void;
    refreshTree(): void;
    filesMoved(): void;          // a delete or move happened: re-reveal the active file and reload its history
    record(kind: ActivityKind, text: string): void;
}

// Returns an error message or null.
export function applyChangeBatch(host: AgentWriteHost, changes: Change[]): string | null {
    const root = host.root();
    if (!root) return 'no work folder';
    // Defense in depth: planChange() already rejects names like this, but writing to disk must not depend on it.
    if (changes.some(c => changeFiles(c).some(f => cleanNewName(f) !== f))) return 'path is outside the work folder or invalid';
    const pathOf = (file: string) => projectPath(root, file);
    try { for (const c of changes) for (const f of changeFiles(c)) waitForWrites(pathOf(f)); } catch (e) { return errorMessage(e); }
    const openDoc = (path: string) => docFor(host, path);
    const writeText = (path: string, text: string) => {
        const open = openDoc(path);
        if (open) open.editor.replaceText(text);
        else { GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755); writeTextFile(path, text); }
    };
    const relocate = (from: string, to: string) => {
        GLib.mkdir_with_parents(GLib.path_get_dirname(to), 0o755);
        Gio.File.new_for_path(from).move(Gio.File.new_for_path(to), Gio.FileCopyFlags.NONE, null, null);
        const open = openDoc(from);
        if (open) { open.file = to; host.refreshTitle(open); }
    };
    const detached = new Map<Change, Doc>();
    const error = applyBatch(changes, {
        read: file => {
            const path = pathOf(file), open = openDoc(path);
            return open ? open.editor.getText() : fileExists(path) ? readTextFile(path) : null;
        },
        write: c => {
            const path = pathOf(c.file);
            if (c.kind === 'delete') {
                Gio.File.new_for_path(path).trash(null);
                const open = openDoc(path);
                if (open) { open.file = null; open.editor.buffer.set_modified(true); host.refreshTitle(open); detached.set(c, open); }
            } else if (c.kind === 'move') relocate(path, pathOf(c.to!));
            else writeText(path, c.after);
        },
        rollback: c => {
            const path = pathOf(c.file);
            if (c.kind === 'create') { if (fileExists(path)) Gio.File.new_for_path(path).delete(null); }
            else if (c.kind === 'delete') {
                writeTextFile(path, c.before);
                const doc = detached.get(c);
                if (doc) { doc.file = path; doc.editor.buffer.set_modified(false); host.refreshTitle(doc); }
            } else if (c.kind === 'move') relocate(pathOf(c.to!), path);
            else writeText(path, c.before);
        },
    });
    host.refreshTree();
    if (changes.some(c => c.kind === 'delete' || c.kind === 'move')) host.filesMoved();
    const summary = error ? null : agentActivity(changes);
    if (summary) host.record('agent', summary);
    return error;
}

// A single change; a newly created file is opened in a tab.
export function applyChange(host: AgentWriteHost, change: Change): string | null {
    const root = host.root();
    if (!root) return 'no work folder is open';
    const error = applyChangeBatch(host, [change]);
    if (!error && change.kind === 'create') host.openInTab(projectPath(root, change.file));
    return error;
}
