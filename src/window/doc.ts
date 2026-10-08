// What the main window shares with its feature controllers (window/*.ts): the open document record and the
// narrow host each controller is given. A controller never sees MainWindow itself; the window builds its host
// from closures, so the dependency stays one way (window.ts → window/*).

import type Adw from 'gi://Adw?version=1';
import type { MarkdownView } from '../editor/view.js';

// One open document (one tab).
export interface Doc {
    id: number;
    editor: MarkdownView;
    file: string | null;          // document path, null = never saved
    home: boolean;                // Home tab: its editor is unused, the tab contents are a HomeView
    textOverride: boolean;        // the user chose the text view for this kanban board
    boardText: string;            // the text the board last wrote/read; to recognize outside changes (undo)
    reloadQueued: boolean;
    autosaveTimer: number;        // autosave timeout id, 0 = none
    lastChange: number;           // time (µs, monotonic) of the last text change
    changes: number;              // number of text changes; marks the contents written by a background autosave
}

// The part of the window every controller needs: the open documents and the work folder.
export interface DocumentHost {
    readonly win: Adw.ApplicationWindow;
    root(): string | null;                      // the work folder shown in the Files tab
    active(): Doc;
    docs(): readonly Doc[];
    openInTab(path: string): boolean;
    toast(message: string): void;
}

export const errorMessage = (e: unknown): string => e instanceof Error ? e.message : String(e);

// The open document for an absolute path, if any.
export const docFor = (host: DocumentHost, path: string): Doc | undefined => host.docs().find(d => d.file === path);
