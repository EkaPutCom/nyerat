// Riwayat percakapan di disk: satu berkas Markdown per percakapan di <folder naskah>/.nyerat/chats/.
// Format berkasnya ada di transcript.ts. Folder bertitik tidak dibaca sebagai naskah oleh asisten
// (project.ts) dan tidak tampil di pohon Berkas, jadi riwayat tidak tercampur dengan naskah.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { readTextFile, writeTextFile } from '../files.js';
import { trashEntry } from '../fileops.js';
import { chatFileName, parseChat, serializeChat, titleFrom, type SavedChat } from './transcript.js';

const MAX_LISTED = 200;

export interface ChatSummary {
    path: string;
    title: string;
    created: string;
    turns: number;
}

export const chatsDir = (root: string): string => GLib.build_filenamev([root, '.nyerat', 'chats']);

// Waktu lokal sekarang untuk dicatat di berkas, mis. 2026-10-04T14:20:00.
export const nowStamp = (): string => GLib.DateTime.new_now_local().format('%Y-%m-%dT%H:%M:%S') ?? '';

export { titleFrom };

// Simpan percakapan. path = berkas yang sudah ada (ditimpa); null = buat berkas baru. Mengembalikan path-nya.
export function saveChat(root: string, chat: SavedChat, path: string | null): string {
    const dir = chatsDir(root);
    GLib.mkdir_with_parents(dir, 0o755);
    // Riwayat berisi kutipan naskah: jangan ikut ter-commit tanpa disengaja. Hapus berkas ini untuk mengizinkannya.
    const ignore = GLib.build_filenamev([root, '.nyerat', '.gitignore']);
    if (!GLib.file_test(ignore, GLib.FileTest.EXISTS)) writeTextFile(ignore, '*\n');
    let target = path;
    if (!target) {
        const name = chatFileName(chat.created, chat.title);
        const base = name.replace(/\.md$/, '');
        target = GLib.build_filenamev([dir, name]);
        for (let n = 2; GLib.file_test(target, GLib.FileTest.EXISTS); n++) target = GLib.build_filenamev([dir, `${base}-${n}.md`]);
    }
    writeTextFile(target, serializeChat(chat));
    return target;
}

export function loadChat(path: string): SavedChat | null {
    try {
        return parseChat(readTextFile(path));
    } catch (e) {
        return null;
    }
}

// Percakapan di folder, terbaru dulu. Berkas yang bukan percakapan dilewati.
export function listChats(root: string): ChatSummary[] {
    const dir = chatsDir(root);
    const found: ChatSummary[] = [];
    let names: string[] = [];
    try {
        const enumerator = Gio.File.new_for_path(dir).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        for (let info = enumerator.next_file(null); info; info = enumerator.next_file(null)) names.push(info.get_name());
        enumerator.close(null);
    } catch (e) {
        return [];
    }
    for (const name of names) {
        if (!name.endsWith('.md')) continue;
        const path = GLib.build_filenamev([dir, name]);
        const chat = loadChat(path);
        if (chat) found.push({ path, title: chat.title, created: chat.created, turns: chat.turns.length });
    }
    // Stempel waktu ISO bisa dibandingkan sebagai teks; nama berkas menjadi penentu bila kosong atau sama.
    found.sort((a, b) => b.created.localeCompare(a.created) || b.path.localeCompare(a.path));
    return found.slice(0, MAX_LISTED);
}

export function deleteChat(path: string): void {
    trashEntry(path);
}
