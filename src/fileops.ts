// On-disk file operations for the folder tree: create a file, create a folder, move.
// All throw an Error with a message ready to show to the user.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { waitForWrites } from './files.js';

const MARKDOWN_EXTENSION = /\.(md|markdown|mdown|mkd)$/i;

const join = (dir: string, name: string): string => GLib.build_filenamev([dir, name]);
const exists = (path: string): boolean => GLib.file_test(path, GLib.FileTest.EXISTS);

// Return the clean name, or throw if it must not be used.
function cleanName(raw: string): string {
    const name = raw.trim();
    if (!name) throw new Error('Name cannot be empty.');
    if (name.includes('/')) throw new Error('Name cannot contain “/”.');
    if (name === '.' || name === '..') throw new Error('Invalid name.');
    // Dot files are not shown in the tree, so the result would seem to vanish.
    if (name.startsWith('.')) throw new Error('Name cannot start with a dot (it would be hidden from the tree).');
    return name;
}

// Create a file (empty, or containing `content`); .md is appended if the extension is not a Markdown one, so it shows in the tree.
export function createFile(dir: string, rawName: string, content = ''): string {
    let name = cleanName(rawName);
    if (!MARKDOWN_EXTENSION.test(name)) name += '.md';
    const path = join(dir, name);
    if (exists(path)) throw new Error(`“${name}” already exists in this folder.`);
    try {
        const stream = Gio.File.new_for_path(path).create(Gio.FileCreateFlags.NONE, null);
        if (content) stream.write_all(new TextEncoder().encode(content), null);
        stream.close(null);
    } catch (e) {
        throw new Error(`Failed to create file: ${(e as Error).message}`);
    }
    return path;
}

export function createFolder(dir: string, rawName: string): string {
    const name = cleanName(rawName);
    const path = join(dir, name);
    if (exists(path)) throw new Error(`“${name}” already exists in this folder.`);
    try {
        Gio.File.new_for_path(path).make_directory(null);
    } catch (e) {
        throw new Error(`Failed to create folder: ${(e as Error).message}`);
    }
    return path;
}

// Move a file/folder into destDir. Returns the new path, or null if
// nothing changed (it is already in that folder).
export function moveEntry(source: string, destDir: string): string | null {
    const name = GLib.path_get_basename(source);
    if (GLib.path_get_dirname(source) === destDir) return null;
    if (destDir === source || destDir.startsWith(`${source}/`)) {
        throw new Error('A folder cannot be moved into itself.');
    }
    const target = join(destDir, name);
    if (exists(target)) throw new Error(`“${name}” already exists in the destination folder.`);
    try {
        waitForWrites(source);
        Gio.File.new_for_path(source).move(Gio.File.new_for_path(target), Gio.FileCopyFlags.NONE, null, null);
    } catch (e) {
        throw new Error(`Failed to move: ${(e as Error).message}`);
    }
    return target;
}

// Path after source is moved to target: the path itself or what is inside it (if source is a folder).
export function remapPath(path: string, source: string, target: string): string | null {
    if (path === source) return target;
    if (path.startsWith(`${source}/`)) return target + path.slice(source.length);
    return null;
}

// Rename a file/folder in place. Returns the new path, or null if the name did not change.
// Files keep a Markdown extension so they do not disappear from the tree.
export function renameEntry(path: string, rawName: string): string | null {
    let name = cleanName(rawName);
    const isDir = GLib.file_test(path, GLib.FileTest.IS_DIR);
    if (!isDir && !MARKDOWN_EXTENSION.test(name)) name += '.md';
    if (name === GLib.path_get_basename(path)) return null;
    const target = join(GLib.path_get_dirname(path), name);
    if (exists(target)) throw new Error(`“${name}” already exists in this folder.`);
    try {
        waitForWrites(path);
        Gio.File.new_for_path(path).move(Gio.File.new_for_path(target), Gio.FileCopyFlags.NONE, null, null);
    } catch (e) {
        throw new Error(`Failed to rename: ${(e as Error).message}`);
    }
    return target;
}

// Move to the Trash (recoverable), not a permanent delete.
export function trashEntry(path: string): void {
    try {
        waitForWrites(path);
        Gio.File.new_for_path(path).trash(null);
    } catch (e) {
        throw new Error(`Failed to delete: ${(e as Error).message}`);
    }
}
