// The main window: composes the components, connects the callbacks between components,
// and handles documents (open, save, export).
//
//   ┌ HeaderBar ─────────────────────────────────────┐
//   │ Sidebar   │ TabBar (if ≥ 2 documents)          │
//   │ ┌Files┬Outline┬History┐ FindBar               │
//   │ FileTree / Outline / History │ MarkdownView    │
//   │           │ StatusBar                          │
//   └───────────┴────────────────────────────────────┘
//
// Each document has its own MarkdownView (undo, cursor, and scroll are preserved when switching
// tabs); the other components (outline, status, search, kanban board) follow the active document.

import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import { APP_ID, APP_NAME } from './config.js';
import { addBundledIcons, after, type Awaitable } from './gtkutil.js';
import { type AppSettings } from './settings.js';
import { readTextFile, writeTextFile, writeTextFileAsync, waitForWrites, fileExists } from './files.js';
import { markdownToHtml } from './markdown/html.js';
import { WELCOME } from './welcome.js';
import { MarkdownView, type Mode } from './editor/view.js';
import { Outline } from './ui/outline.js';
import { History } from './ui/history.js';
import { HistoryViewer } from './ui/historyviewer.js';
import { remapPath } from './fileops.js';
import { FileTree, isDirectory } from './ui/filetree.js';
import { Sidebar } from './ui/sidebar.js';
import { ChatPanel } from './ui/chat.js';
import { listMarkdownFiles, readProject } from './agent/project.js';
import { newNotePath, noteSection, resolveWikiLink, type WikiLink } from './markdown/wikilink.js';
import { projectPath } from './agent/path.js';
import { applyBatch } from './agent/batch.js';
import { changeFiles, cleanNewName, type Change } from './agent/changes.js';
import { agentGit, commitsBetween } from './git.js';
import { readActivity, recordActivity } from './activity.js';
import { FindBar } from './ui/findbar.js';
import { StatusBar } from './ui/statusbar.js';
import { TabBar } from './ui/tabbar.js';
import { HeaderBar } from './ui/headerbar.js';
import { applyTheme, systemPrefersDark, type Palette } from './ui/theme.js';
import { chooseFile, askSaveChanges, showError, harnessAskDialog, harnessTextDialog, promptDialog } from './ui/dialogs.js';
import { registerActions, TEXT_ACTIONS } from './actions.js';
import { ImageViewer } from './ui/imageviewer.js';
import { KanbanBoard } from './ui/kanban.js';
import { InboxView } from './ui/inbox.js';
import { HomeView, RESUME_CARDS, type HomeData, type HomeEntry } from './ui/home.js';
import { dueTasks, localDate, moveRecent, openInboxes, rememberRecent, splitRecent, type RecentFile, type Task } from './markdown/home.js';
import {
    activityLines, addNote, agentActivity, boardEvents, clock, commitActivity, harnessActivity, journalName, journalStats, mergeActivity, newJournal,
    type Activity, type ActivityKind,
} from './markdown/journal.js';
import { isInbox, newInbox, parseInbox, serializeInbox, type Inbox } from './markdown/inbox.js';
import { assignCard, cardMeta, countCards, isKanban, newBoard, parseBoard, serializeBoard, updateCard, type Board, type Card, type Position } from './markdown/kanban.js';
import { Orchestrator } from './orchestrator.js';
import { cardProject, checkProjectFolder, HARNESSES, isActive, PROJECT_NAME, type LinkedNote, type HarnessAsk, type HarnessReply, type Run } from './agent/harness.js';
import { LogViewer } from './ui/logviewer.js';
import type { MenuEntry } from './ui/menu.js';
import { _, fmt, ngettext } from './i18n.js';

const UNTITLED = _('Untitled');
const HOME = _('Home');
// The marker of the Home tab in the saved tab list (not a file path).
const HOME_TAB = 'nyerat:home';
// Actions that are meaningless on Home (there is no text to save or undo).
const DOCUMENT_ACTIONS = ['save', 'save-as', 'export-html', 'undo', 'redo', 'kanban-view'];
// Pause without keystrokes before autosave writes to disk.
const AUTOSAVE_DELAY_MS = 1000;

const errorMessage = (e: unknown): string => e instanceof Error ? e.message : String(e);

// The saved window size may be larger than the screen (for example after moving
// to a smaller monitor); limit it to the monitor size. GTK 4 no longer gives the general
// work area (without panels), so the size of the first monitor is used.
function fitToScreen(width: number, height: number): [number, number] {
    const monitor = Gdk.Display.get_default()?.get_monitors().get_item(0) as Gdk.Monitor | null;
    if (!monitor) return [width, height];
    const area = monitor.get_geometry();
    return [Math.min(width, area.width), Math.min(height, area.height)];
}
const MODE_LABELS: Record<Mode, string> = { source: _('Source'), focus: _('Focus'), typewriter: _('Typewriter') };

// View options that can be changed from the menu.
export type Option = 'sidebar' | 'chat' | 'dark' | 'autosave' | Mode;

// One open document (one tab).
interface Doc {
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

export class MainWindow {
    readonly app: Adw.Application;
    readonly settings: AppSettings;
    readonly outline: Outline;
    readonly history: History;
    readonly fileTree: FileTree;
    readonly sidebar: Sidebar;
    readonly findBar: FindBar;
    // The last notification text (for tests; the toast itself disappears on its own).
    lastToast = '';
    private readonly toasts = new Adw.ToastOverlay();
    readonly statusBar: StatusBar;
    readonly tabBar: TabBar;
    readonly board: KanbanBoard;
    readonly inbox: InboxView;
    readonly home: HomeView;
    readonly orchestrator: Orchestrator;
    // Harness dialogs can be replaced in tests with immediate answers; the real dialog answers through a Promise.
    harnessDialogs: {
        chooseFolder: (title: string) => Awaitable<string | null>;
        answer: (ask: HarnessAsk, agent: string) => Awaitable<HarnessReply | null>;
        text: (options: { title: string; label: string; context?: string }) => Awaitable<string | null>;
    } = {
        chooseFolder: title => chooseFile(this.win, { title, selectFolder: true }),
        answer: (ask, agent) => harnessAskDialog(this.win, ask, agent),
        text: options => harnessTextDialog(this.win, options),
    };
    // The quick capture dialog; replaced in tests with an immediate answer.
    journalDialogs: { capture: () => Awaitable<string | null> } = {
        capture: () => promptDialog(this.win, { title: _('Add to Journal'), label: _('Recorded in today\'s journal with the current time.'), accept: _('Add') }),
    };
    private closing = false;   // closing the window has been confirmed through a dialog
    private readonly runLogs = new Map<number, LogViewer>();
    private readonly loggedResults = new WeakSet<object>();   // harness results already recorded in the activity log
    readonly chat: ChatPanel;
    readonly chatSplit: Adw.OverlaySplitView;
    private readonly content: Gtk.Stack;
    readonly header: HeaderBar;
    readonly win: Adw.ApplicationWindow;

    private docs: Doc[] = [];
    private doc: Doc;                 // the active document
    private nextId = 1;
    private restoring = false;        // a tab from the last session is being reopened: do not record it as newly opened
    private palette: Palette | null = null;
    dark: boolean;
    private colorScheme: boolean | null = null;   // the last choice applied by setDark (null = follow the system)

    // path: the file or folder to open when the window appears.
    constructor(app: Adw.Application, settings: AppSettings, path: string | null = null) {
        this.app = app;
        this.settings = settings;
        this.dark = settings.dark ?? systemPrefersDark();

        // Components
        this.content = new Gtk.Stack({ vexpand: true, hexpand: true });
        this.tabBar = new TabBar();
        this.outline = new Outline();
        this.history = new History();
        this.fileTree = new FileTree();
        this.sidebar = new Sidebar(this.fileTree.widget, this.outline.widget, this.history.widget);
        this.statusBar = new StatusBar();
        this.board = new KanbanBoard();
        this.inbox = new InboxView();
        this.home = new HomeView();
        this.chat = new ChatPanel();
        this.header = new HeaderBar();

        this.doc = this.addDoc();
        this.doc.editor.modes.focus = settings.focus;
        this.doc.editor.modes.typewriter = settings.typewriter;
        this.findBar = new FindBar(this.doc.editor.buffer, this.doc.editor.view);

        // The components do not know each other; the window is what connects them.
        this.board.onChange = board => this.writeBoard(board);
        this.orchestrator = new Orchestrator({
            workspace: () => this.fileTree.root,
            updateBoard: (file, edit) => this.updateBoardFile(file, edit),
            linkedNotes: (file, links) => this.linkedNotes(file, links),
            changed: (run, message) => {
                if (run.result && (run.status === 'done' || run.status === 'failed') && !this.loggedResults.has(run.result)) {
                    this.loggedResults.add(run.result);
                    this.record('harness', harnessActivity(HARNESSES[run.agent]?.label ?? run.agent, run.title, run.project, run.status === 'done'));
                }
                if (this.boardMode && this.file === run.board) this.board.queueRender();
                this.refreshHome();
                if (message) this.toast(message);
            },
        });
        this.inbox.onChange = inbox => this.writeInbox(inbox);
        this.inbox.onOpenNote = link => this.openNote(link);
        this.inbox.listNotes = () => {
            const root = this.noteRoot(this.doc);
            return root ? listMarkdownFiles(root) : [];
        };
        this.home.onOpenFile = path => this.openInTab(path);
        this.home.onOpenTask = task => this.openWorkspaceFile(task.file);
        this.home.onToggleTask = (task, done) => this.toggleTask(task, done);
        this.home.onOpenInbox = file => this.openWorkspaceFile(file);
        this.home.onOpenRun = id => this.openRun(id);
        this.home.onOpenFolder = () => void this.chooseFolder();
        this.home.onNewDocument = () => this.newDocument();
        this.home.onOpenJournal = () => this.openJournal();
        this.home.onCaptureJournal = () => this.captureJournal();
        this.board.onOpenNote = link => this.openNote(link);
        this.board.listNotes = () => {
            const root = this.noteRoot(this.doc);
            return root ? listMarkdownFiles(root) : [];
        };
        this.board.harness = {
            status: card => (this.file && this.orchestrator.queue.find(this.file, card.text)?.status) || null,
            menu: (card, at) => this.harnessMenu(card, at),
        };
        this.outline.onJump = line => this.editor.jumpToLine(line);
        this.tabBar.onSelect = id => {
            const doc = this.docs.find(d => d.id === id);
            if (doc) this.activate(doc);
        };
        this.tabBar.onClose = id => {
            const doc = this.docs.find(d => d.id === id);
            if (doc) this.closeTab(doc);
        };
        this.fileTree.onOpenFile = file => this.openFile(file);
        this.fileTree.onMoved = (from, to) => {
            for (const doc of this.docs) {
                const moved = doc.file ? remapPath(doc.file, from, to) : null;
                if (!moved) continue;
                doc.file = moved;  // the open document moves along; the buffer contents do not change
                this.refreshTitle(doc);
            }
            this.settings.recentFiles = moveRecent(this.settings.recentFiles, from, to);
            this.syncHistory(true);
        };
        this.fileTree.onDeleted = path => {
            for (const doc of this.docs) {
                if (!doc.file || !remapPath(doc.file, path, path)) continue;
                // The open document is discarded too: its contents stay in the editor, marked as unsaved.
                doc.file = null;
                doc.editor.buffer.set_modified(true);
                this.refreshTitle(doc);
            }
            this.fileTree.reveal(this.file);
            this.syncHistory(true);
        };
        this.history.onOpen = commit => {
            if (this.file) new HistoryViewer(this.win, this.file, commit, this.dark).show();
        };
        // Only save file documents that have changes; without a file, do not bring up a save dialog.
        this.history.beforeCommit = () => this.saveOpenFiles();
        this.history.onCommitted = () => {
            this.toast(_('Committed successfully'));
            this.syncHistory(true);
        };
        this.history.onOpenChanges = file => {
            const viewer = new HistoryViewer(this.win, file, null, this.dark);
            viewer.beforeCommit = () => this.saveOpenFiles();
            viewer.onCommitted = () => {
                this.toast(_('Committed successfully'));
                this.syncHistory(true);
            };
            viewer.show();
        };
        this.chat.setModel(settings.chatModel);
        this.chat.setThinking(settings.chatThinking);
        this.chat.onModelChanged = model => {
            this.settings.chatModel = model;
        };
        this.chat.setSaveChats(settings.chatSave);
        this.chat.onSaveChanged = save => {
            this.settings.chatSave = save;
        };
        this.chat.onThinkingChanged = thinking => {
            this.settings.chatThinking = thinking;
        };
        this.chat.host = {
            active: () => {
                const buf = this.editor.buffer;
                return { name: this.projectName(this.file) ?? this.documentName, text: this.editor.getText(), cursorLine: buf.get_iter_at_mark(buf.get_insert()).get_line() };
            },
            selection: () => {
                const buf = this.editor.buffer;
                const bounds = buf.get_selection_bounds();
                return bounds[0] ? buf.get_text(bounds[1], bounds[2], false) : '';
            },
            root: () => this.fileTree.root,
            applyChange: change => this.applyChange(change),
            applyBatch: changes => this.applyChangeBatch(changes),
            git: request => this.fileTree.root ? agentGit(this.fileTree.root, request) : Promise.resolve({ ok: false, message: 'no work folder' }),
            window: () => this.win,
            files: fresh => {
                const files = this.fileTree.root ? readProject(this.fileTree.root, this.file, fresh) : [];
                // Other unsaved tabs: the assistant reads the editor contents, not the version on disk.
                for (const doc of this.docs) {
                    if (doc === this.doc || !doc.file || !doc.editor.buffer.get_modified()) continue;
                    const name = this.projectName(doc.file);
                    const entry = files.find(f => f.name === name);
                    if (entry) entry.text = doc.editor.getText();
                }
                return files;
            },
        };
        this.sidebar.onPageChanged = page => {
            this.settings.sidebarPage = page;
            this.syncHistory();
        };

        // Layout
        const [width, height] = fitToScreen(settings.width, settings.height);
        this.win = new Adw.ApplicationWindow({ application: app, default_width: width, default_height: height });
        addBundledIcons(this.win.get_display());
        this.win.set_icon_name(APP_ID);
        const column = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true });
        column.append(this.tabBar.widget);
        column.append(this.findBar);
        this.content.add_named(this.board.widget, 'board');
        this.content.add_named(this.inbox.widget, 'inbox');
        this.content.add_named(this.home.widget, 'home');
        column.append(this.content);
        column.append(this.statusBar);
        // The Assistant panel on the right, a fixed width; the rest for the editor.
        this.chatSplit = new Adw.OverlaySplitView({
            sidebar_position: Gtk.PackType.END, sidebar: this.chat.widget, content: column,
            min_sidebar_width: 360, max_sidebar_width: 360, enable_show_gesture: false, enable_hide_gesture: false,
        });
        this.sidebar.setContent(this.chatSplit);
        const main = this.sidebar.widget;
        this.toasts.set_child(main);
        const toolbar = new Adw.ToolbarView({ content: this.toasts });
        toolbar.add_top_bar(this.header);
        this.win.set_content(toolbar);
        this.addBreakpoints();
        // true = hold the closing. If there are documents that need to be asked about, the window is held first and
        // closed again after all dialogs are answered with consent.
        this.win.connect('close-request', () => {
            if (this.closing) return false;
            const allowed = this.onClose();
            if (typeof allowed === 'boolean') return !allowed;
            void allowed.then(yes => {
                if (!yes) return;
                this.closing = true;
                this.win.close();
            });
            return true;
        });
        // The window is destroyed (closed, or destroy() in tests). GTK 4 does not emit "destroy"
        // for widgets still held by JavaScript, so the components' timers are stopped here.
        this.win.connect('unrealize', () => this.dispose());
        // New commits are usually made outside the app; when returning to the window, reload the history.
        this.win.connect('notify::is-active', () => {
            if (!this.win.is_active) return;
            this.syncHistory(true);
            this.refreshHome();   // files may change outside the app (git pull, agent, another editor)
        });

        registerActions(app, this);
        this.setDark(settings.dark);
        // The system theme changed (GNOME Dark Style) while its setting is "follow system".
        Adw.StyleManager.get_default().connect('notify::dark', () => {
            if (this.settings.dark === null && Adw.StyleManager.get_default().dark !== this.dark) this.setDark(null);
        });
        // The system accent changed (libadwaita ≥ 1.6): recolor the text tags; older libadwaita has no such property.
        if (GObject.Object.find_property.call(Adw.StyleManager, 'accent-color'))
            Adw.StyleManager.get_default().connect('notify::accent-color', () => this.setDark(this.colorScheme));
        settings.gsettings.connect('changed', (_gs, key) => this.onSettingChanged(key));
        // Panel visibility follows GSettings in both directions; side effects are installed on widget changes.
        this.bindPanel('sidebar', this.sidebar.widget);
        this.bindPanel('chat', this.chatSplit);
        this.sidebar.widget.connect('notify::show-sidebar', () => this.syncHistory());
        this.chatSplit.connect('notify::show-sidebar', () => {
            if (!this.chatSplit.show_sidebar) return;
            this.chat.updateContextSummary();
            this.chat.focusInput();
        });
        this.tabBar.setActive(this.doc.id);

        // Initial contents: the folder from the argument, or the last folder; then the file, or the last tabs
        // if opened without an argument (a path on the command line means the user asked for specific contents).
        this.sidebar.setPage(settings.sidebarPage);
        if (path && isDirectory(path)) this.openFolder(path);
        else if (settings.folder && isDirectory(settings.folder)) this.openFolder(settings.folder, false);
        if (path && !isDirectory(path)) {
            this.load(path);
        } else if (!path && this.restoreTabs()) {
            // the last tabs are restored
        } else if (!settings.welcomed) {
            this.editor.setText(WELCOME);
            settings.welcomed = true;
        } else if (settings.home) {
            this.openHome();
        } else {
            this.editor.setText('');
        }
        this.syncMode();
        this.updateTitle();
        this.win.present();
        this.syncHistory();
        this.editor.view.grab_focus();
    }

    // A short notification that disappears on its own (Adw.Toast).
    toast(message: string): void {
        this.lastToast = message;
        this.toasts.add_toast(new Adw.Toast({ title: message, timeout: 3 }));
    }

    // ---------- Active document ----------

    get editor(): MarkdownView {
        return this.doc.editor;
    }

    // The active document's path, null = never saved.
    get file(): string | null {
        return this.doc.file;
    }

    set file(path: string | null) {
        this.doc.file = path;
    }

    // The number of open documents (tabs).
    get documentCount(): number {
        return this.docs.length;
    }

    // Create an empty document together with its editor, without activating it.
    private addDoc(): Doc {
        const editor = new MarkdownView();
        const doc: Doc = { id: this.nextId++, editor, file: null, home: false, textOverride: false, boardText: '', reloadQueued: false, autosaveTimer: 0, lastChange: 0, changes: 0 };
        // Editor callbacks only apply while their document is active; background ones do not touch the outline and status bar.
        editor.onHighlighted = ({ headings, words, characters }) => {
            if (doc !== this.doc) return;
            this.outline.update(headings);
            if (!this.boardMode && !this.inboxMode) this.statusBar.setDocumentCounts(words, characters);
        };
        editor.onCursorMoved = (line, column) => {
            if (doc !== this.doc) return;
            this.statusBar.setCursor(line, column);
            this.statusBar.setModes((Object.keys(MODE_LABELS) as Mode[]).filter(m => editor.modes[m]).map(m => MODE_LABELS[m]));
        };
        editor.onMessage = msg => this.toast(msg);
        editor.onViewImage = (pixbuf, title) => new ImageViewer(this.win, pixbuf, title).show();
        editor.getBaseDir = () => doc.file ? GLib.path_get_dirname(doc.file) : GLib.get_home_dir();
        editor.onOpenNote = link => this.openNote(link, doc);
        editor.onOpenDocument = path => this.openInTab(path);
        editor.listNotes = () => {
            const root = this.noteRoot(doc);
            return root ? listMarkdownFiles(root) : [];
        };
        editor.buffer.connect('modified-changed', () => this.refreshTitle(doc));
        // Text changed while the board is shown and not by the board itself (undo/redo): re-read.
        editor.buffer.connect('changed', () => {
            doc.changes++;
            this.queueBoardReload(doc);
            this.queueAutosave(doc);
        });

        // A new document inherits the mode and theme of the currently active document.
        if (this.docs.length) {
            for (const mode of Object.keys(MODE_LABELS) as Mode[]) if (this.doc.editor.modes[mode]) editor.setMode(mode, true);
        }
        if (this.palette) editor.setPalette(this.palette);
        this.docs.push(doc);
        this.content.add_named(editor.widget, `doc-${doc.id}`);
        this.tabBar.add(doc.id, UNTITLED);
        return doc;
    }

    // Make doc the active document: all components follow it.
    private activate(doc: Doc): void {
        if (doc === this.doc) return;
        const previous = this.doc;
        this.doc = doc;
        this.autosave(previous);   // leaving a tab = a safe point to save
        this.findBar.setTarget(doc.editor.buffer, doc.editor.view);
        this.tabBar.setActive(doc.id);
        if (doc.file) this.rememberRecent(doc.file);
        this.outline.update(doc.editor.headings);
        this.syncMode();
        this.updateTitle();
        this.fileTree.reveal(doc.file);
        this.syncHistory();
        if (this.chatSplit.show_sidebar) this.chat.updateContextSummary();
    }

    // Tab name/title for a document.
    private nameOf(doc: Doc): string {
        if (doc.home) return HOME;
        return doc.file ? GLib.path_get_basename(doc.file) : UNTITLED;
    }

    // A document without a file and without changes has no contents that need to be kept,
    // so it may be reused for the next file that is opened.
    private isPristine(doc: Doc): boolean {
        return !doc.home && !doc.file && !doc.editor.buffer.get_modified();
    }

    // The tab after/before the active one (wraps around).
    switchTab(step: number): void {
        const ids = this.tabBar.ids();
        const at = ids.indexOf(this.doc.id);
        const doc = this.docs.find(d => d.id === ids[(at + step + ids.length) % ids.length]);
        if (doc) this.activate(doc);
    }

    // Close a tab (asks if there are changes). Closing the only tab empties its document.
    closeTab(doc: Doc = this.doc): Awaitable<boolean> {
        return after(this.confirmDiscard(doc), yes => yes && this.docs.includes(doc) && this.removeTab(doc));
    }

    private removeTab(doc: Doc): boolean {
        if (this.docs.length === 1) {
            if (doc.home && this.settings.home) return true;
            this.resetDocument(doc);
            if (this.settings.home) this.makeHome(doc);
            return true;
        }
        const index = this.docs.indexOf(doc);
        this.cancelAutosave(doc);
        this.docs.splice(index, 1);
        this.tabBar.remove(doc.id);
        // Move first, then destroy: the search and other components still point at this editor.
        if (doc === this.doc) this.activate(this.docs[Math.min(index, this.docs.length - 1)]);
        doc.editor.destroy();
        this.content.remove(doc.editor.widget);
        return true;
    }

    // ---------- Tab restoration ----------

    // Record file tabs (ordered like the tab row) together with their cursors for the next launch.
    // Documents without a file are not recorded: their contents are not on disk to be read again.
    private rememberTabs(): void {
        const docs = this.tabBar.ids()
            .map(id => this.docs.find(d => d.id === id))
            .filter((d): d is Doc => !!d && (!!d.file || d.home));
        this.settings.tabs = docs.map(d => ({ file: d.home ? HOME_TAB : d.file!, cursor: d.home ? 0 : d.editor.cursorOffset }));
        this.settings.activeTab = docs.indexOf(this.doc);
    }

    // Reopen tabs from the settings. Files that have gone missing are skipped (not recreated).
    // true = some tabs were restored.
    private restoreTabs(): boolean {
        const saved = Array.isArray(this.settings.tabs) ? this.settings.tabs : [];
        const opened: [Doc, number][] = [];
        let active: Doc | null = null;
        let missing = 0;
        this.restoring = true;
        for (const [i, tab] of saved.entries()) {
            if (tab?.file === HOME_TAB) {
                this.openHome();
                opened.push([this.doc, 0]);
                if (i === this.settings.activeTab) active = this.doc;
                continue;
            }
            if (typeof tab?.file !== 'string' || !fileExists(tab.file) || isDirectory(tab.file)) {
                missing++;
                continue;
            }
            if (!this.openInTab(tab.file)) continue;
            opened.push([this.doc, Number(tab.cursor) || 0]);
            if (i === this.settings.activeTab) active = this.doc;
        }
        this.restoring = false;
        if (!opened.length) return false;
        for (const [doc, cursor] of opened) doc.editor.restoreCursor(cursor);
        this.activate(active ?? opened[opened.length - 1][0]);
        if (missing) this.toast(fmt(ngettext('{missing} file from the last session was not found', '{missing} files from the last session were not found', missing), { missing }));
        return true;
    }

    // ---------- View settings ----------

    // gsettings.bind(key, split, 'show-sidebar') plus the behavior when the window narrows. Without a pin,
    // OverlaySplitView hides the panel when collapsing and always opens it again when widening, so a panel
    // that was closed on purpose opens as well. With a pin, this is handled here: collapsing closes the panel (the setting
    // becomes false too so the header button stays consistent), widening restores the setting from before collapsing.
    private readonly widePanels = new Map<'sidebar' | 'chat', boolean>();   // the panel settings before collapsing

    private bindPanel(key: 'sidebar' | 'chat', split: Adw.OverlaySplitView): void {
        const gs = this.settings.gsettings;
        split.pin_sidebar = true;
        gs.bind(key, split, 'show-sidebar', Gio.SettingsBindFlags.DEFAULT);
        split.connect('notify::collapsed', () => {
            if (split.collapsed) {
                this.widePanels.set(key, gs.get_boolean(key));
                gs.set_boolean(key, false);
            } else if (this.widePanels.has(key)) {
                gs.set_boolean(key, this.widePanels.get(key)!);
                this.widePanels.delete(key);
            }
        });
    }

    // Adaptive layout (HIG): in a narrow window the side panels no longer take up editor width, but
    // float above it (OverlaySplitView collapsed) and close when the content is clicked. The Assistant panel
    // (360) collapses before the sidebar (240). A minimum window size is required for the breakpoints.
    private addBreakpoints(): void {
        this.win.set_size_request(360, 294);
        const narrow = new Adw.Breakpoint({ condition: Adw.BreakpointCondition.parse('max-width: 900sp') });
        narrow.add_setter(this.chatSplit, 'collapsed', true);
        this.win.add_breakpoint(narrow);
        const phone = new Adw.Breakpoint({ condition: Adw.BreakpointCondition.parse('max-width: 600sp') });
        phone.add_setter(this.chatSplit, 'collapsed', true);
        phone.add_setter(this.sidebar.widget, 'collapsed', true);
        this.win.add_breakpoint(phone);
    }

    // dark null = follow the system theme.
    setDark(dark: boolean | null): void {
        const palette = applyTheme(dark);
        this.colorScheme = dark;
        this.dark = palette.dark;
        this.palette = palette;
        for (const doc of this.docs) doc.editor.setPalette(palette);
        this.board.setPalette(palette);
        this.inbox.setPalette(palette);
        this.chat.setPalette(palette);
    }

    // ---------- Assistant ----------

    // Apply a change proposal from the agent that the user has approved. Returns an error message or null.
    // Open files are changed through their editor (one undo step); others are written to disk. In both
    // cases the contents must still equal what the agent saw, so the user's edits are not overwritten.
    // Delete moves to the Trash; an open document stays in the editor as when it is deleted from the tree.
    private applyChangeBatch(changes: Change[]): string | null {
        const root = this.fileTree.root;
        if (!root) return 'no work folder';
        // Defense in depth: planChange() already rejects names like this, but writing to disk must not depend on it.
        if (changes.some(c => changeFiles(c).some(f => cleanNewName(f) !== f))) return 'path is outside the work folder or invalid';
        const pathOf = (file: string) => projectPath(root, file);
        try { for (const c of changes) for (const f of changeFiles(c)) waitForWrites(pathOf(f)); } catch (e) { return errorMessage(e); }
        const openDoc = (path: string) => this.docs.find(d => d.file === path);
        const writeText = (path: string, text: string) => {
            const open = openDoc(path);
            if (open) open.editor.replaceText(text);
            else { GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755); writeTextFile(path, text); }
        };
        const relocate = (from: string, to: string) => {
            GLib.mkdir_with_parents(GLib.path_get_dirname(to), 0o755);
            Gio.File.new_for_path(from).move(Gio.File.new_for_path(to), Gio.FileCopyFlags.NONE, null, null);
            const open = openDoc(from);
            if (open) { open.file = to; this.refreshTitle(open); }
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
                    if (open) { open.file = null; open.editor.buffer.set_modified(true); this.refreshTitle(open); detached.set(c, open); }
                } else if (c.kind === 'move') relocate(path, pathOf(c.to!));
                else writeText(path, c.after);
            },
            rollback: c => {
                const path = pathOf(c.file);
                if (c.kind === 'create') { if (fileExists(path)) Gio.File.new_for_path(path).delete(null); }
                else if (c.kind === 'delete') {
                    writeTextFile(path, c.before);
                    const doc = detached.get(c);
                    if (doc) { doc.file = path; doc.editor.buffer.set_modified(false); this.refreshTitle(doc); }
                } else if (c.kind === 'move') relocate(pathOf(c.to!), path);
                else writeText(path, c.before);
            },
        });
        this.fileTree.refresh(root);
        if (changes.some(c => c.kind === 'delete' || c.kind === 'move')) { this.fileTree.reveal(this.file); this.syncHistory(true); }
        const summary = error ? null : agentActivity(changes);
        if (summary) this.record('agent', summary);
        return error;
    }

    private applyChange(change: Change): string | null {
        const root = this.fileTree.root;
        if (!root) return 'no work folder is open';
        const error = this.applyChangeBatch([change]);
        if (!error && change.kind === 'create') this.openInTab(projectPath(root, change.file));
        return error;
    }

    // File name relative to the project folder (the same as the name in agent/project.ts); null if outside the folder or not saved.
    private projectName(path: string | null): string | null {
        const root = this.fileTree.root;
        return path && root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path ? GLib.path_get_basename(path) : null;
    }

    // ---------- [[note]] links ----------

    // The folder where [[notes]] are looked up: the work folder if the document is inside it (or not saved yet),
    // otherwise the document's own folder.
    private noteRoot(doc: Doc): string | null {
        const root = this.fileTree.root;
        if (root && (!doc.file || doc.file.startsWith(`${root}/`))) return root;
        return doc.file ? GLib.path_get_dirname(doc.file) : null;
    }

    // Ctrl+click [[note]]: open its file in a tab. A note that does not exist yet is opened as an empty document
    // next to the source document and only written to disk when saved, so a mistaken click leaves no file behind.
    openNote(link: WikiLink, doc = this.doc): void {
        if (!link.target) {
            if (link.heading) this.jumpToHeading(doc, link.heading);
            return;
        }
        const root = this.noteRoot(doc);
        if (!root) {
            this.toast(_('Open a folder or save the document first to follow [[note]] links'));
            return;
        }
        const from = doc.file?.startsWith(`${root}/`) ? doc.file.slice(root.length + 1) : null;
        const found = resolveWikiLink(link.target, listMarkdownFiles(root), from);
        const rel = found ?? newNotePath(link.target, from);
        if (!rel) {
            this.toast(fmt(_('Invalid note name: {target}'), { target: link.target }));
            return;
        }
        const path = GLib.build_filenamev([root, ...rel.split('/')]);
        if (!found) GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
        if (!this.openInTab(path)) return;
        if (!found) this.toast(fmt(_('New note: {rel} (saved once filled in)'), { rel }));
        else if (link.heading) this.jumpToHeading(this.doc, link.heading);
    }

    // Notes linked by the cards on the board `boardFile`, for the harness prompt context. Looked up with the same rules
    // as Ctrl+click; the document that is currently open is read from its editor so unsaved edits are included.
    private linkedNotes(boardFile: string, links: WikiLink[]): LinkedNote[] {
        const root = this.fileTree.root && boardFile.startsWith(`${this.fileTree.root}/`) ? this.fileTree.root : GLib.path_get_dirname(boardFile);
        const from = boardFile.slice(root.length + 1);
        const files = listMarkdownFiles(root);
        return links.map(link => {
            const file = resolveWikiLink(link.target, files, from);
            if (!file) return { link, file: null, text: null };
            const path = GLib.build_filenamev([root, ...file.split('/')]);
            let text: string;
            try {
                text = this.docs.find(d => d.file === path)?.editor.getText() ?? readTextFile(path);
            } catch {
                return { link, file: null, text: null };
            }
            return { link, file, text: link.heading ? noteSection(text, link.heading) : text };
        });
    }

    private jumpToHeading(doc: Doc, heading: string): void {
        const want = heading.trim().toLowerCase();
        const found = doc.editor.headings.find(h => h.text.trim().toLowerCase() === want);
        if (found) doc.editor.jumpToLine(found.line);
        else this.toast(fmt(_('Section not found: {heading}'), { heading }));
    }

    // ---------- Kanban board ----------

    get boardMode(): boolean {
        return this.content.visible_child_name === 'board';
    }

    get inboxMode(): boolean {
        return this.content.visible_child_name === 'inbox';
    }

    get homeMode(): boolean {
        return this.content.visible_child_name === 'home';
    }

    // A kanban document is shown as a board and an inbox document as an inbox, unless the user chose the text view.
    private syncMode(): void {
        if (this.doc.home) {
            this.setView('home');
            return;
        }
        const text = this.editor.getText();
        const structured = !this.doc.textOverride;
        this.setView(structured && isKanban(text) ? 'board' : structured && isInbox(text) ? 'inbox' : 'text');
    }

    setBoardMode(on: boolean): void {
        this.setView(on ? 'board' : 'text');
    }

    private setView(view: 'board' | 'inbox' | 'home' | 'text'): void {
        this.statusBar.set_visible(view !== 'home');
        if (view === 'home') {
            this.findBar.close();
            this.content.visible_child_name = 'home';
            this.home.render(this.homeData());
        } else if (view === 'board') {
            this.board.setBoard(parseBoard(this.editor.getText()));
            this.doc.boardText = this.editor.getText();
            this.findBar.close();
            this.content.visible_child_name = 'board';
            this.showBoardCounts(this.board.getBoard());
        } else if (view === 'inbox') {
            this.inbox.setInbox(parseInbox(this.editor.getText()));
            this.doc.boardText = this.editor.getText();
            this.findBar.close();
            this.content.visible_child_name = 'inbox';
            this.statusBar.setInboxCounts(this.inbox.getInbox().items.length);
        } else {
            this.content.visible_child_name = `doc-${this.doc.id}`;
            this.statusBar.setCounts(this.editor.getText());
            this.editor.updateCursor(true);
            this.editor.view.grab_focus();
        }
        const action = this.app.lookup_action('kanban-view');
        if (action instanceof Gio.SimpleAction) action.set_state(GLib.Variant.new_boolean(view === 'board' || view === 'inbox'));
        this.syncActionsEnabled();
    }

    // Text editor actions are disabled while the kanban board is shown (its text is hidden).
    syncActionsEnabled(): void {
        const home = this.homeMode;
        const board = this.boardMode || this.inboxMode || home;
        for (const name of TEXT_ACTIONS) {
            const action = this.app.lookup_action(name);
            if (action instanceof Gio.SimpleAction) action.set_enabled(!board);
        }
        for (const name of DOCUMENT_ACTIONS) {
            const action = this.app.lookup_action(name);
            if (action instanceof Gio.SimpleAction) action.set_enabled(!home);
        }
    }

    // The "Board View" menu/shortcut: toggles between board/inbox and text for a kanban or inbox document.
    toggleBoardView(on: boolean): void {
        const text = this.editor.getText();
        if (on && !isKanban(text) && !isInbox(text)) {
            this.toast(_('This document is not a kanban board or inbox (it needs "kanban: true" or "inbox: true" in the frontmatter)'));
            this.setBoardMode(false);
            return;
        }
        this.doc.textOverride = !on;
        this.syncMode();
    }

    // A new document containing an empty kanban board.
    newBoardDocument(): void {
        this.resetDocument(this.blankDocument(), serializeBoard(newBoard()));
    }

    // A new document containing an empty inbox.
    newInboxDocument(): void {
        this.resetDocument(this.blankDocument(), serializeInbox(newInbox()));
        this.inbox.focusCapture();
    }

    // ---------- Home ----------

    // Alt+Home: switch to the Home tab, or open it if there is none (using the active empty tab if there is one).
    openHome(): void {
        const open = this.docs.find(d => d.home);
        if (open) {
            if (open === this.doc) this.refreshHome();
            else this.activate(open);
            return;
        }
        this.makeHome(this.isPristine(this.doc) ? this.doc : this.addDoc());
    }

    private makeHome(doc: Doc): void {
        doc.home = true;
        doc.file = null;
        doc.textOverride = false;
        this.tabBar.setIcon(doc.id, 'user-home-symbolic');
        this.activate(doc);
        this.syncMode();
        this.updateTitle();
        this.fileTree.reveal(null);
    }

    // Redraw Home if it is shown; the data is recomputed from the files every time.
    refreshHome(): void {
        if (this.doc.home && this.homeMode) this.home.render(this.homeData());
    }

    private rememberRecent(path: string): void {
        if (this.restoring) return;
        this.settings.recentFiles = rememberRecent(this.settings.recentFiles, path, Math.floor(Date.now() / 1000));
    }

    homeData(now = new Date()): HomeData {
        const root = this.fileTree.root;
        const recent = this.settings.recentFiles.filter(r => fileExists(r.path) && !isDirectory(r.path));
        const { resume, others } = splitRecent(recent, RESUME_CARDS);
        // Boards and inboxes are read through the readProject cache (by modification time); unsaved tabs are read from their editor.
        const files = root ? readProject(root, null) : [];
        for (const doc of this.docs) {
            if (!doc.file || !doc.editor.buffer.get_modified()) continue;
            const entry = files.find(f => f.name === this.projectName(doc.file));
            if (entry) entry.text = doc.editor.getText();
        }
        const realName = GLib.get_real_name();
        return {
            now,
            name: realName && realName !== 'Unknown' ? realName.split(/\s+/)[0] : null,
            workspace: root,
            resume: resume.map(r => this.homeEntry(r, true)),
            recent: others.map(r => this.homeEntry(r, false)),
            tasks: dueTasks(files, localDate(now), cardProject),
            runs: this.orchestrator.queue.runs.filter(r => isActive(r.status)).map(r => ({ id: r.id, agent: r.agent, title: r.title, status: r.status })),
            inboxes: openInboxes(files),
            journal: root ? this.journalSummary(root, localDate(now)) : null,
        };
    }

    private journalSummary(root: string, date: string): HomeData['journal'] {
        const path = this.journalPath(date)!;
        const doc = this.docs.find(d => d.file === path);
        let text: string | null = null;
        try {
            text = doc ? doc.editor.getText() : fileExists(path) ? readTextFile(path) : null;
        } catch (e) {
            // unreadable: shown as not written yet
        }
        return { exists: text !== null, notes: text ? journalStats(text).notes : 0, activity: readActivity(root, date).length };
    }

    // Card: folder name above the file name. List: file name above its folder (relative to the work folder if inside it).
    private homeEntry(r: RecentFile, card: boolean): HomeEntry {
        const root = this.fileTree.root;
        const dir = GLib.path_get_dirname(r.path), file = GLib.path_get_basename(r.path);
        if (card) return { path: r.path, title: GLib.path_get_basename(dir), subtitle: file, time: r.time };
        const folder = root && dir === root ? GLib.path_get_basename(root)
            : root && dir.startsWith(`${root}/`) ? dir.slice(root.length + 1)
            : dir.replace(GLib.get_home_dir(), '~');
        return { path: r.path, title: file, subtitle: folder, time: r.time };
    }

    private openWorkspaceFile(name: string): void {
        const root = this.fileTree.root;
        if (root) this.openInTab(GLib.build_filenamev([root, ...name.split('/')]));
    }

    // A check from Home: written to its board (through the editor if open). A card that has changed is not touched.
    private toggleTask(task: Task, done: boolean): boolean {
        const root = this.fileTree.root;
        if (!root) return false;
        let changed = false;
        const error = this.updateBoardFile(GLib.build_filenamev([root, ...task.file.split('/')]), board => {
            const card = board.columns[task.at.column]?.cards[task.at.index];
            if (card?.text !== task.card) { changed = true; return board; }
            return updateCard(board, task.at, { done: done ? true : task.box ? false : null });
        });
        if (error || changed) {
            this.toast(error ? fmt(_('Cannot change the card: {error}'), { error }) : _('The card has changed; open the board to check'));
            // Deferred: the checked row is still running its handler.
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { this.refreshHome(); return GLib.SOURCE_REMOVE; });
            return false;
        }
        return true;
    }

    // An agent that is waiting for an answer is asked right away; one that is working shows its log; a queued one opens its board.
    private openRun(id: number): void {
        const run = this.orchestrator.queue.runs.find(r => r.id === id);
        if (!run) return;
        if (run.status === 'waiting') this.answerHarness(run);
        else if (run.status === 'working') this.showRunLog(run);
        else this.openInTab(run.board);
    }

    // ---------- Journal ----------

    private journalPath(date: string): string | null {
        const root = this.fileTree.root;
        return root ? GLib.build_filenamev([root, ...journalName(date).split('/')]) : null;
    }

    // Journal title, e.g. "Thursday, October 8, 2026", by the system locale like the date on Home.
    private journalTitle(date: string): string {
        const [y, m, d] = date.split('-').map(Number);
        return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    }

    // Record work activity to the work folder's daily log; without a work folder there is no journal, so it is skipped.
    private record(kind: ActivityKind, text: string, time = Math.floor(Date.now() / 1000)): void {
        const root = this.fileTree.root;
        if (root) recordActivity(root, { time, kind, text });
    }

    // Board changes (in the work folder) → card activity.
    private recordBoard(file: string | null, before: Board, after: Board): void {
        const root = this.fileTree.root;
        if (!root || !file?.startsWith(`${root}/`)) return;
        for (const text of boardEvents(before, after, file.slice(root.length + 1))) this.record('card', text);
    }

    // Ctrl+Alt+J: open today's journal (created from the template if missing), then fill in the Activity section.
    // Returns the Promise of filling in the activity (for tests), or null if the journal cannot be opened.
    openJournal(now = new Date()): Promise<void> | null {
        const date = localDate(now);
        const path = this.journalPath(date);
        if (!path) {
            this.toast(_('Open a work folder first to write a journal'));
            return null;
        }
        if (!this.docs.some(d => d.file === path) && !fileExists(path)) {
            GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
            if (!this.write(path, newJournal(this.journalTitle(date)))) return null;
            this.fileTree.refresh(this.fileTree.root!);
        }
        if (!this.openInTab(path)) return null;
        return this.fillJournalActivity(this.doc, date);
    }

    // Merge that day's activity (log + git commits) into the Activity section of the journal open in `doc`.
    // Only lines that are not there yet are added, as a single undo step.
    private async fillJournalActivity(doc: Doc, date: string): Promise<void> {
        const root = this.fileTree.root, path = doc.file;
        if (!root || !path) return;
        const [y, m, d] = date.split('-').map(Number);
        const since = Math.floor(new Date(y, m - 1, d).getTime() / 1000), until = Math.floor(new Date(y, m - 1, d + 1).getTime() / 1000);
        const commits = await commitsBetween(root, since, until);
        // git runs in the background: the tab may already have been closed or switched to another file.
        if (!this.docs.includes(doc) || doc.file !== path) return;
        const events: Activity[] = [...readActivity(root, date), ...commits.map(c => ({ time: c.time, kind: 'commit' as const, text: commitActivity(c.short, c.subject) }))];
        const text = doc.editor.getText();
        const next = mergeActivity(text, activityLines(events));
        if (next !== text) doc.editor.replaceText(next);
    }

    // Ctrl+Shift+J: record one line in today's journal without leaving the document being worked on.
    captureJournal(): void {
        if (!this.fileTree.root) {
            this.toast(_('Open a work folder first to write a journal'));
            return;
        }
        void after(this.journalDialogs.capture(), note => { if (note) this.addJournalNote(note); });
    }

    // An open journal is changed through its editor (one undo step); one that is not open is written directly to disk.
    addJournalNote(note: string, now = new Date()): boolean {
        const date = localDate(now);
        const path = this.journalPath(date);
        if (!path) return false;
        const doc = this.docs.find(d => d.file === path);
        try {
            if (doc) doc.editor.replaceText(addNote(doc.editor.getText(), clock(now), note));
            else {
                waitForWrites(path);
                const text = fileExists(path) ? readTextFile(path) : newJournal(this.journalTitle(date));
                GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
                writeTextFile(path, addNote(text, clock(now), note));
                this.fileTree.refresh(this.fileTree.root!);
            }
        } catch (e) {
            this.toast(fmt(_('Failed to write the journal: {error}'), { error: errorMessage(e) }));
            return false;
        }
        this.toast(_('Recorded in today\'s journal'));
        this.refreshHome();
        return true;
    }

    // Close the day: open the journal, then ask the Assistant to propose a summary. The proposal is still reviewed in the
    // review window like any other agent change; nothing is written without approval.
    // Returns the Promise of the question to the Assistant (for tests), or null if it did not run.
    summarizeJournal(): Promise<void> | null {
        if (this.chat.busy) {
            this.toast(_('The Assistant is working; wait until it finishes'));
            return null;
        }
        const filling = this.openJournal();
        if (!filling) return null;
        const name = this.projectName(this.file);
        this.settings.chat = true;
        return filling.then(() => this.chat.ask(
            `Close the day: read the journal ${name} (the active document), then propose a short summary under the heading "## Summary" with insert_text: ` +
            'what was finished, what got in the way, and what continues tomorrow. Use only the contents of the journal and the files it links; do not change other sections.'));
    }

    // ---------- Git history ----------

    // History is only loaded while its tab is visible, so git is not called needlessly.
    // force = re-read even for the same file.
    syncHistory(force = false): void {
        if (!this.sidebar.visible || this.sidebar.page !== 'history') return;
        this.history.setFile(this.file, force, this.fileTree.root);
    }

    private showBoardCounts(board: Board): void {
        this.statusBar.setBoardCounts(board.columns.length, countCards(board));
    }

    // Changes from the inbox → document text (one undo step).
    private writeInbox(inbox: Inbox): void {
        const text = serializeInbox(inbox);
        this.doc.boardText = text;
        this.editor.replaceText(text);
        this.statusBar.setInboxCounts(inbox.items.length);
    }

    // Changes from the board → document text (one undo step).
    private writeBoard(board: Board): void {
        if (this.doc.boardText) this.recordBoard(this.file, parseBoard(this.doc.boardText), board);
        const text = serializeBoard(board);
        this.doc.boardText = text;   // recognize this change as the board's own
        this.editor.replaceText(text);
        this.showBoardCounts(board);
    }

    // ---------- External harnesses ----------

    // Card menu entries to assign, stop, and monitor harnesses.
    private harnessMenu(card: Card, at: Position): MenuEntry[] {
        const file = this.file;
        const run = file ? this.orchestrator.queue.find(file, card.text) : null;
        const active = run && isActive(run.status) ? run : null;
        const agent = cardMeta(card.text).agent;
        const entries: MenuEntry[] = Object.values(HARNESSES).map(spec => ({
            label: fmt(_('Work on it with {label}'), { label: spec.label }),
            enabled: !!file && !active && card.done !== true,
            run: () => this.runHarness(at, spec.name),
        }));
        if (active?.status === 'waiting') entries.push({ label: fmt(_('Answer {agent}…'), { agent: active.agent }), run: () => this.answerHarness(active) });
        if (active?.status === 'working') entries.push({ label: fmt(_('Steer {agent}…'), { agent: active.agent }), run: () => this.steerHarness(active) });
        if (run && !active && run.result?.sessionId) entries.push({ label: fmt(_('Reply to {agent}…'), { agent: run.agent }), run: () => this.replyHarness(run) });
        if (active) entries.push({ label: active.status === 'queued' ? _('Cancel Queue') : fmt(_('Stop {agent}'), { agent: active.agent }), run: () => this.orchestrator.stop(active) });
        if (run) entries.push({ label: fmt(_('View {agent} Log'), { agent: run.agent }), run: () => this.showRunLog(run) });
        if (agent && !active) entries.push({ label: _('Remove Assignment'), run: () => this.board.commit(updateCard(this.board.getBoard(), at, { text: assignCard(card.text, null) })) });
        const project = cardProject(this.board.getBoard(), card);
        if (project && this.settings.projects[project]) entries.push({ label: _('Change Project Folder…'), run: () => this.chooseProjectFolder(project) });
        return entries;
    }

    // Run a harness for a card on the active board. The project folder is asked once and then remembered in the settings.
    runHarness(at: Position, agent: string): void {
        const file = this.file;
        if (!file) { this.toast(_('Save the board first before assigning cards')); return; }
        const card = this.board.getBoard().columns[at.column]?.cards[at.index];
        if (!card) return;
        const project = cardProject(this.board.getBoard(), card);
        if (project && this.settings.projects[project]) {
            this.startHarness(file, at, agent, project);
            return;
        }
        void after(this.chooseProjectFolder(project), folder => {
            if (!folder) return;
            // The folder dialog can stay open for a long time: the assigned card must still be on the same board.
            if (this.file !== file || this.board.getBoard().columns[at.column]?.cards[at.index]?.text !== card.text) {
                this.toast(_('The board changed while choosing a folder; assign the card again'));
                return;
            }
            if (!project) {
                // No project name yet: use the folder name and note it on the card so the next turn does not ask again.
                const tagged = `${card.text} #project/${folder.name}`;
                this.board.commit(updateCard(this.board.getBoard(), at, { text: tagged }));
            }
            this.startHarness(file, at, agent, project ?? folder.name);
        });
    }

    private startHarness(file: string, at: Position, agent: string, project: string): void {
        const error = this.orchestrator.start(file, this.board.getBoard(), at, agent, project, this.settings.projects[project], GLib.path_get_basename(file));
        if (error) this.toast(fmt(_('Cannot run {agent}: {error}'), { agent, error }));
    }

    // Choose a folder for project `name` (or a new project if null) and save the mapping.
    private chooseProjectFolder(name: string | null): Awaitable<{ name: string; path: string } | null> {
        return after(this.harnessDialogs.chooseFolder(name ? fmt(_('Project folder “{name}”'), { name }) : _('Choose a project folder')), path => this.mapProjectFolder(name, path));
    }

    private mapProjectFolder(name: string | null, path: string | null): { name: string; path: string } | null {
        if (!path) return null;
        const project = name ?? GLib.path_get_basename(path).replace(/\s+/g, '-');
        const problem = !PROJECT_NAME.test(project) ? fmt(_('the folder name "{name}" cannot be used as a project name'), { name: project }) : checkProjectFolder(path, this.fileTree.root);
        if (problem) { this.toast(fmt(_('Project folder rejected: {problem}'), { problem })); return null; }
        this.settings.projects = { ...this.settings.projects, [project]: path };
        return { name: project, path };
    }

    answerHarness(run: Run): void {
        if (!run.ask) return;
        void after(this.harnessDialogs.answer(run.ask, run.agent), reply => {
            if (!reply) return;   // Later: the harness keeps waiting
            const error = this.orchestrator.answer(run, reply);
            if (error) this.toast(fmt(_('The answer was not sent: {error}'), { error }));
        });
    }

    private steerHarness(run: Run): void {
        void after(this.harnessDialogs.text({ title: fmt(_('Steering for {agent}'), { agent: run.agent }), label: fmt(_('{agent} receives it before its next step, without stopping the work.'), { agent: run.agent }) }), text => {
            if (!text) return;
            const error = this.orchestrator.steer(run, text);
            this.toast(error ? fmt(_('The steering was not sent: {error}'), { error }) : fmt(_('Steering sent to {agent}'), { agent: run.agent }));
        });
    }

    private replyHarness(run: Run): void {
        void after(this.harnessDialogs.text({ title: fmt(_('Reply to {agent}'), { agent: run.agent }), label: fmt(_('The {agent} session continues with this reply; the card goes back to being worked on.'), { agent: run.agent }), context: run.result?.summary || undefined }), text => {
            if (!text) return;
            const error = this.orchestrator.resume(run, text);
            if (error) this.toast(fmt(_('Cannot reply to {agent}: {error}'), { agent: run.agent, error }));
        });
    }

    showRunLog(run: Run): LogViewer {
        const open = this.runLogs.get(run.id);
        if (open?.window.get_realized()) { open.show(); return open; }
        const viewer = new LogViewer(this.win, run.trace, fmt(_('{agent} Log — {title}'), { agent: run.agent, title: run.title }));
        this.runLogs.set(run.id, viewer);
        viewer.show();
        return viewer;
    }

    // Change the board in `file` for the orchestrator: through its editor if open (one undo step), otherwise directly on disk.
    private updateBoardFile(file: string, edit: (board: Board) => Board): string | null {
        const doc = this.docs.find(d => d.file === file);
        try {
            if (!doc) waitForWrites(file);
            const text = doc ? doc.editor.getText() : readTextFile(file);
            if (!isKanban(text)) return 'the board file is no longer a kanban board';
            const board = parseBoard(text);
            const next = edit(board);
            if (next === board) return null;
            if (doc === this.doc && this.boardMode) {
                this.board.setBoard(next);
                this.writeBoard(next);   // records its own activity
                return null;
            }
            if (doc) doc.editor.replaceText(serializeBoard(next));
            else writeTextFile(file, serializeBoard(next));
            this.recordBoard(file, board, next);
            return null;
        } catch (e) {
            return errorMessage(e);
        }
    }

    private queueBoardReload(doc: Doc): void {
        if (doc !== this.doc || !(this.boardMode || this.inboxMode) || doc.reloadQueued) return;
        doc.reloadQueued = true;
        // Deferred: undo changes the text in several steps, and what is read must be the final result.
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            doc.reloadQueued = false;
            if (doc !== this.doc || !this.docs.includes(doc)) return GLib.SOURCE_REMOVE;
            const text = doc.editor.getText();
            if (!(this.boardMode || this.inboxMode) || text === doc.boardText) return GLib.SOURCE_REMOVE;
            if (this.boardMode ? isKanban(text) : isInbox(text)) {
                doc.boardText = text;
                if (this.boardMode) {
                    this.board.setBoard(parseBoard(text));
                    this.showBoardCounts(this.board.getBoard());
                } else {
                    this.inbox.setInbox(parseInbox(text));
                    this.statusBar.setInboxCounts(this.inbox.getInbox().items.length);
                }
            } else {
                doc.textOverride = true;   // no longer a board/inbox (for example the frontmatter was removed)
                this.setView('text');
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // Change a view option. All but source mode are GSettings keys: writing them is enough,
    // because the sidebar and assistant are bound to their keys (Gio.Settings.bind) and the rest is applied by
    // onSettingChanged. The toggle actions in the menu (Gio.Settings.create_action) use the same path.
    setOption(key: Option, value: boolean): void {
        if (key === 'source') for (const doc of this.docs) doc.editor.setMode('source', value);
        else if (key === 'dark') {
            this.setDark(value);
            this.settings.dark = value;
        } else this.settings[key] = value;
    }

    // GSettings changes (menu, preferences dialog, or another process) that need to be applied to the components.
    private onSettingChanged(key: string): void {
        const s = this.settings;
        if (key === 'color-scheme') {
            if (s.dark !== this.colorScheme) this.setDark(s.dark);
            const dark = this.app.lookup_action('dark');
            if (dark instanceof Gio.SimpleAction) dark.set_state(GLib.Variant.new_boolean(this.dark));
        } else if (key === 'focus' || key === 'typewriter') for (const doc of this.docs) doc.editor.setMode(key, s[key]);
        else if (key === 'autosave') { if (s.autosave) for (const doc of this.docs) this.queueAutosave(doc); }
        else if (key === 'chat-model') this.chat.setModel(s.chatModel);
        else if (key === 'chat-thinking') this.chat.setThinking(s.chatThinking);
        else if (key === 'chat-save') this.chat.setSaveChats(s.chatSave);
    }

    // ---------- Auto save ----------

    // Called on every text change, so it is kept cheap: it only records the time. The timer is not
    // recreated per keystroke; when it fires, it postpones itself again if there are newer keystrokes.
    private queueAutosave(doc: Doc): void {
        if (!this.settings.autosave || !doc.file) return;
        doc.lastChange = GLib.get_monotonic_time();
        if (doc.autosaveTimer) return;
        doc.autosaveTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, AUTOSAVE_DELAY_MS, () => this.autosaveTick(doc));
    }

    private autosaveTick(doc: Doc): boolean {
        const waited = (GLib.get_monotonic_time() - doc.lastChange) / 1000;
        if (waited < AUTOSAVE_DELAY_MS) {
            doc.autosaveTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.ceil(AUTOSAVE_DELAY_MS - waited), () => this.autosaveTick(doc));
            return GLib.SOURCE_REMOVE;
        }
        doc.autosaveTimer = 0;
        this.autosaveInBackground(doc);
        return GLib.SOURCE_REMOVE;
    }

    // Autosave from the timer: the file is written in a worker thread (see writeTextFileAsync), so
    // the main thread only copies the text. A later synchronous write to the same file
    // waits for this one to finish. true = the write started.
    autosaveInBackground(doc: Doc = this.doc, done: () => void = () => {}): boolean {
        this.cancelAutosave(doc);
        const path = doc.file;
        if (!doc.editor.buffer.get_modified() || !this.settings.autosave || !path) return false;
        const changes = doc.changes;
        writeTextFileAsync(path, doc.editor.getText(), error => {
            if (error) {
                this.toast(fmt(_('Autosave failed: {error}'), { error: errorMessage(error) }));
            } else if (this.docs.includes(doc) && doc.file === path && doc.changes === changes) {
                // The text did not change while being written: the contents on disk equal the buffer.
                doc.editor.buffer.set_modified(false);
            }
            done();
        });
        return true;
    }

    // Save quietly without a dialog or toast. true = no changes left behind.
    autosave(doc: Doc = this.doc): boolean {
        this.cancelAutosave(doc);
        if (!doc.editor.buffer.get_modified()) return true;
        if (!this.settings.autosave || !doc.file) return false;
        try {
            writeTextFile(doc.file, doc.editor.getText());
        } catch (e) {
            // Not a dialog: autosave keeps trying, and repeated dialogs get in the way of typing.
            this.toast(fmt(_('Autosave failed: {error}'), { error: errorMessage(e) }));
            return false;
        }
        doc.editor.buffer.set_modified(false);
        return true;
    }

    private cancelAutosave(doc: Doc): void {
        if (!doc.autosaveTimer) return;
        GLib.source_remove(doc.autosaveTimer);
        doc.autosaveTimer = 0;
    }

    // ---------- Documents ----------

    get documentName(): string {
        return this.nameOf(this.doc);
    }

    // Suggested file name from the first heading.
    suggestName(): string {
        const h = this.editor.headings[0];
        return h?.text ? h.text.replace(/[\/\\:*?"<>|]/g, '').slice(0, 60) : UNTITLED;
    }

    updateTitle(): void {
        this.refreshTitle(this.doc);
    }

    // Tab title for doc, and the window title if doc is active.
    private refreshTitle(doc: Doc): void {
        if (!this.docs.includes(doc)) return;
        const mark = doc.editor.buffer.get_modified() ? '• ' : '';
        const name = this.nameOf(doc);
        this.tabBar.setTitle(doc.id, `${mark}${name}`, doc.file);
        if (doc !== this.doc) return;
        if (doc.home) {
            this.header.setTitle(name, this.fileTree.root ? GLib.path_get_basename(this.fileTree.root) : APP_NAME);
            this.win.set_title(`${name} — ${APP_NAME}`);
            return;
        }
        this.header.setTitle(`${mark}${name}`, doc.file ? GLib.path_get_dirname(doc.file).replace(GLib.get_home_dir(), '~') : APP_NAME);
        this.win.set_title(`${mark}${name} — ${APP_NAME}`);
    }

    // If there are changes, ask first. true = it is fine to go on and discard this document.
    // Without changes that need asking about, the answer is immediate (without a Promise).
    confirmDiscard(doc: Doc = this.doc): Awaitable<boolean> {
        if (this.autosave(doc)) return true;
        this.activate(doc);   // the user needs to see which document is being asked about
        return askSaveChanges(this.win, this.nameOf(doc)).then(answer => {
            if (answer !== 'save') return answer === 'discard';
            this.activate(doc);
            return this.save();
        });
    }

    // Ask about documents one by one; stop at the first Cancel answer.
    private confirmDiscardAll(docs: Doc[]): Awaitable<boolean> {
        for (let i = 0; i < docs.length; i++) {
            const answer = this.confirmDiscard(docs[i]);
            if (answer === false) return false;
            if (answer !== true) return answer.then(yes => yes && this.confirmDiscardAll(docs.slice(i + 1)));
        }
        return true;
    }

    // Save all changed file documents (before a git commit). Documents without a file are not touched.
    private saveOpenFiles(): boolean {
        for (const doc of this.docs) {
            if (!doc.file || !doc.editor.buffer.get_modified()) continue;
            if (!this.write(doc.file, doc.editor.getText())) return false;
            doc.editor.buffer.set_modified(false);
            this.cancelAutosave(doc);
        }
        return true;
    }

    // The document that may be overwritten: the active one if it has no contents that need to be kept, otherwise a new tab.
    private blankDocument(): Doc {
        const doc = this.isPristine(this.doc) ? this.doc : this.addDoc();
        this.activate(doc);
        return doc;
    }

    // Empty doc (or fill it with text) as a new document without a file.
    private resetDocument(doc: Doc, text = ''): void {
        this.activate(doc);
        doc.file = null;
        doc.home = false;
        this.tabBar.setIcon(doc.id, null);
        doc.editor.setText(text);
        doc.textOverride = false;
        this.syncMode();
        this.updateTitle();
        this.fileTree.reveal(null);
        this.syncHistory();
    }

    // Ctrl+N: an empty document in a new tab.
    newDocument(): void {
        this.resetDocument(this.blankDocument());
    }

    // Fill the active document with the absolute file that has been read (text).
    private show(absolute: string, text: string): void {
        // this.file is set before setText(): relative image paths are resolved from its folder.
        this.file = absolute;
        this.rememberRecent(absolute);
        this.editor.setText(text);
        this.doc.textOverride = false;
        this.syncMode();
        this.updateTitle();
        this.fileTree.reveal(absolute);
        this.syncHistory();
    }

    private read(absolute: string): string | null {
        try {
            return fileExists(absolute) ? readTextFile(absolute) : '';  // a new file if it does not exist yet
        } catch (e) {
            void showError(this.win, fmt(_('Failed to open the file:\n{error}'), { error: errorMessage(e) }));
            return null;
        }
    }

    // Open a file in the active document, replacing its contents. If the path turns out to be a folder (for example chosen
    // through the Open File dialog, or given on the command line), that folder is opened in the Files tab.
    load(path: string): boolean {
        const absolute = Gio.File.new_for_path(path).get_path() ?? path;
        if (isDirectory(absolute)) {
            this.openFolder(absolute);
            return true;
        }
        const text = this.read(absolute);
        if (text === null) return false;
        this.show(absolute, text);
        return true;
    }

    // Open a file in a tab: switch to its tab if already open, use the active empty document if there is one,
    // otherwise open a new tab.
    openInTab(path: string): boolean {
        const absolute = Gio.File.new_for_path(path).get_path() ?? path;
        if (isDirectory(absolute)) {
            this.openFolder(absolute);
            return true;
        }
        const open = this.docs.find(d => d.file === absolute);
        if (open) {
            this.activate(open);
            return true;
        }
        const text = this.read(absolute);
        if (text === null) return false;
        this.activate(this.isPristine(this.doc) ? this.doc : this.addDoc());
        this.show(absolute, text);
        return true;
    }

    // Open the file chosen in the file tree.
    openFile(path: string): void {
        if (path === this.file) return;
        if (!this.openInTab(path)) this.fileTree.reveal(this.file);  // restore the highlight to the file that is still open
    }

    async chooseFolder(): Promise<void> {
        const path = await chooseFile(this.win, { title: _('Open Folder'), selectFolder: true, folder: this.fileTree.root });
        if (path) this.openFolder(path);
    }

    // Show a folder in the Files tab and remember it to open again next time.
    // show = false when restoring the last folder, so a sidebar that was deliberately
    // closed does not suddenly appear.
    openFolder(path: string, show = true): void {
        const absolute = Gio.File.new_for_path(path).get_path() ?? path;
        this.fileTree.setRoot(absolute);
        this.fileTree.reveal(this.file);
        this.syncHistory();
        this.settings.folder = absolute;
        if (this.doc.home) this.updateTitle();
        this.refreshHome();
        if (!show) return;
        this.sidebar.setPage('files');
        this.settings.sidebar = true;
    }

    async open(): Promise<void> {
        const path = await chooseFile(this.win, { title: _('Open Markdown'), filters: ['markdown', 'all'] });
        if (path) this.openInTab(path);
    }

    private write(path: string, text: string): boolean {
        try {
            writeTextFile(path, text);
            return true;
        } catch (e) {
            void showError(this.win, fmt(_('Failed to save:\n{error}'), { error: errorMessage(e) }));
            return false;
        }
    }

    // A file document is saved instantly (a boolean result); a new document waits for the Save As dialog.
    save(): Awaitable<boolean> {
        if (this.doc.home) return true;
        if (!this.file) return this.saveAs();
        if (!this.write(this.file, this.editor.getText())) return false;
        this.editor.buffer.set_modified(false);
        this.cancelAutosave(this.doc);
        this.toast(_('Saved'));
        return true;
    }

    async saveAs(): Promise<boolean> {
        const doc = this.doc;
        if (doc.home) return false;
        let path = await chooseFile(this.win, {
            title: _('Save Markdown'), save: true, filters: ['markdown', 'all'],
            name: this.file ? this.documentName : `${this.suggestName()}.md`,
            // A new document is saved in the folder that is currently open.
            folder: this.file ? null : this.fileTree.root,
        });
        if (!path || !this.docs.includes(doc)) return false;
        if (!/\.[^/]+$/.test(GLib.path_get_basename(path))) path += '.md';
        this.activate(doc);
        this.file = path;
        this.updateTitle();
        if (!this.save()) return false;
        // Show the new file in the tree without waiting for the disk monitor.
        this.fileTree.refresh(GLib.path_get_dirname(path));
        this.fileTree.reveal(path);
        this.syncHistory();
        return true;
    }

    async exportHtml(): Promise<void> {
        if (this.doc.home) return;
        const base = this.file ? this.documentName.replace(/\.[^.]+$/, '') : this.suggestName();
        const text = this.editor.getText(), title = this.editor.headings[0]?.text || base;
        const path = await chooseFile(this.win, {
            title: _('Export HTML'), save: true, filters: ['html', 'all'], name: `${base}.html`,
            folder: this.file ? GLib.path_get_dirname(this.file) : null,
        });
        if (!path) return;
        const html = markdownToHtml(text, title);
        if (this.write(path, html)) this.toast(fmt(_('Exported to {name}'), { name: GLib.path_get_basename(path) }));
    }

    // Insert ![name](path). The path is made relative to the file if possible.
    async insertImage(): Promise<void> {
        const doc = this.doc;
        let path = await chooseFile(this.win, { title: _('Choose Image'), filters: ['image'] });
        if (!path || doc !== this.doc) return;
        if (this.file) {
            const dir = Gio.File.new_for_path(GLib.path_get_dirname(this.file));
            path = dir.get_relative_path(Gio.File.new_for_path(path)) ?? path;
        }
        const alt = GLib.path_get_basename(path).replace(/\.[^.]+$/, '');
        this.editor.buffer.insert_at_cursor(`![${alt}](${encodeURI(path)})`, -1);
    }

    // true = the window may be closed. Every changed document is asked about one by one.
    onClose(): Awaitable<boolean> {
        return after(this.confirmDiscardAll([...this.docs]), yes => yes && this.rememberWindow());
    }

    private rememberWindow(): true {
        // Closed while narrow: save the panel settings for the wide layout, not the collapsed state.
        for (const [key, value] of this.widePanels) this.settings.gsettings.set_boolean(key, value);
        // After confirmation: a new document saved through a dialog already has a file.
        this.rememberTabs();
        // In GTK 4 the default size follows the current window size.
        const [width, height] = this.win.get_default_size();
        Object.assign(this.settings, { width, height });
        return true;
    }

    // Stop the timers and idles of all components after the window is destroyed.
    private dispose(): void {
        for (const doc of this.docs) {
            this.cancelAutosave(doc);
            doc.editor.destroy();
        }
        this.orchestrator.dispose();
        this.chat.destroy();
        this.history.destroy();
        this.fileTree.destroy();
    }
}
