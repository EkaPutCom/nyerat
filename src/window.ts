// Jendela utama: menyusun komponen, menghubungkan callback antar-komponen,
// dan menangani dokumen (buka, simpan, ekspor).
//
//   ┌ HeaderBar ─────────────────────────────────────┐
//   │ Sidebar   │ TabBar (jika ≥ 2 dokumen)          │
//   │ ┌Berkas┬Outline┬Riwayat┐ FindBar              │
//   │ FileTree / Outline / History │ MarkdownView    │
//   │           │ StatusBar                          │
//   └───────────┴────────────────────────────────────┘
//
// Tiap dokumen punya MarkdownView sendiri (undo, kursor, dan gulir terjaga saat berpindah
// tab); komponen lain (outline, status, pencarian, papan kanban) mengikuti dokumen aktif.

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
import { agentGit } from './git.js';
import { FindBar } from './ui/findbar.js';
import { StatusBar } from './ui/statusbar.js';
import { TabBar } from './ui/tabbar.js';
import { HeaderBar } from './ui/headerbar.js';
import { applyTheme, systemPrefersDark, type Palette } from './ui/theme.js';
import { chooseFile, askSaveChanges, showError, harnessAskDialog, harnessTextDialog } from './ui/dialogs.js';
import { registerActions, TEXT_ACTIONS } from './actions.js';
import { ImageViewer } from './ui/imageviewer.js';
import { KanbanBoard } from './ui/kanban.js';
import { InboxView } from './ui/inbox.js';
import { isInbox, newInbox, parseInbox, serializeInbox, type Inbox } from './markdown/inbox.js';
import { assignCard, cardMeta, countCards, isKanban, newBoard, parseBoard, serializeBoard, updateCard, type Board, type Card, type Position } from './markdown/kanban.js';
import { Orchestrator } from './orchestrator.js';
import { cardProject, checkProjectFolder, HARNESSES, isActive, PROJECT_NAME, type LinkedNote, type HarnessAsk, type HarnessReply, type Run } from './agent/harness.js';
import { LogViewer } from './ui/logviewer.js';
import type { MenuEntry } from './ui/menu.js';
import { _, fmt } from './i18n.js';

const UNTITLED = _('Tanpa Judul');
// Jeda tanpa ketikan sebelum auto save menulis ke disk.
const AUTOSAVE_DELAY_MS = 1000;

const errorMessage = (e: unknown): string => e instanceof Error ? e.message : String(e);

// Ukuran jendela tersimpan bisa lebih besar dari layar (misalnya setelah pindah
// ke monitor yang lebih kecil); batasi ke ukuran monitor. GTK 4 tidak lagi memberi
// area kerja (tanpa panel) secara umum, jadi dipakai ukuran monitor pertama.
function fitToScreen(width: number, height: number): [number, number] {
    const monitor = Gdk.Display.get_default()?.get_monitors().get_item(0) as Gdk.Monitor | null;
    if (!monitor) return [width, height];
    const area = monitor.get_geometry();
    return [Math.min(width, area.width), Math.min(height, area.height)];
}
const MODE_LABELS: Record<Mode, string> = { source: _('Source'), focus: _('Fokus'), typewriter: _('Typewriter') };

// Pilihan tampilan yang bisa diubah dari menu.
export type Option = 'sidebar' | 'chat' | 'dark' | 'autosave' | Mode;

// Satu dokumen terbuka (satu tab).
interface Doc {
    id: number;
    editor: MarkdownView;
    file: string | null;          // path dokumen, null = belum pernah disimpan
    textOverride: boolean;        // pengguna memilih tampilan teks untuk papan kanban ini
    boardText: string;            // teks yang terakhir ditulis/dibaca papan; untuk mengenali perubahan dari luar (undo)
    reloadQueued: boolean;
    autosaveTimer: number;        // id timeout auto save, 0 = tidak ada
    lastChange: number;           // waktu (µs, monotonic) perubahan teks terakhir
    changes: number;              // jumlah perubahan teks; menandai isi yang ditulis auto save latar
}

export class MainWindow {
    readonly app: Adw.Application;
    readonly settings: AppSettings;
    readonly outline: Outline;
    readonly history: History;
    readonly fileTree: FileTree;
    readonly sidebar: Sidebar;
    readonly findBar: FindBar;
    // Teks pemberitahuan terakhir (untuk tes; toast sendiri hilang sendiri).
    lastToast = '';
    private readonly toasts = new Adw.ToastOverlay();
    readonly statusBar: StatusBar;
    readonly tabBar: TabBar;
    readonly board: KanbanBoard;
    readonly inbox: InboxView;
    readonly orchestrator: Orchestrator;
    // Dialog harness bisa diganti di tes dengan jawaban langsung; dialog asli menjawab lewat Promise.
    harnessDialogs: {
        chooseFolder: (title: string) => Awaitable<string | null>;
        answer: (ask: HarnessAsk, agent: string) => Awaitable<HarnessReply | null>;
        text: (options: { title: string; label: string; context?: string }) => Awaitable<string | null>;
    } = {
        chooseFolder: title => chooseFile(this.win, { title, selectFolder: true }),
        answer: (ask, agent) => harnessAskDialog(this.win, ask, agent),
        text: options => harnessTextDialog(this.win, options),
    };
    private closing = false;   // penutupan jendela sudah dikonfirmasi lewat dialog
    private readonly runLogs = new Map<number, LogViewer>();
    readonly chat: ChatPanel;
    readonly chatSplit: Adw.OverlaySplitView;
    private readonly content: Gtk.Stack;
    readonly header: HeaderBar;
    readonly win: Adw.ApplicationWindow;

    private docs: Doc[] = [];
    private doc: Doc;                 // dokumen aktif
    private nextId = 1;
    private palette: Palette | null = null;
    dark: boolean;
    private colorScheme: boolean | null = null;   // pilihan terakhir yang diterapkan setDark (null = ikuti sistem)

    // path: file atau folder yang dibuka saat jendela muncul.
    constructor(app: Adw.Application, settings: AppSettings, path: string | null = null) {
        this.app = app;
        this.settings = settings;
        this.dark = settings.dark ?? systemPrefersDark();

        // Komponen
        this.content = new Gtk.Stack({ vexpand: true, hexpand: true });
        this.tabBar = new TabBar();
        this.outline = new Outline();
        this.history = new History();
        this.fileTree = new FileTree();
        this.sidebar = new Sidebar(this.fileTree.widget, this.outline.widget, this.history.widget);
        this.statusBar = new StatusBar();
        this.board = new KanbanBoard();
        this.inbox = new InboxView();
        this.chat = new ChatPanel();
        this.header = new HeaderBar();

        this.doc = this.addDoc();
        this.doc.editor.modes.focus = settings.focus;
        this.doc.editor.modes.typewriter = settings.typewriter;
        this.findBar = new FindBar(this.doc.editor.buffer, this.doc.editor.view);

        // Komponen tidak saling kenal; jendela inilah yang menghubungkan mereka.
        this.board.onChange = board => this.writeBoard(board);
        this.orchestrator = new Orchestrator({
            workspace: () => this.fileTree.root,
            updateBoard: (file, edit) => this.updateBoardFile(file, edit),
            linkedNotes: (file, links) => this.linkedNotes(file, links),
            changed: (run, message) => {
                if (this.boardMode && this.file === run.board) this.board.queueRender();
                if (message) this.toast(message);
            },
        });
        this.inbox.onChange = inbox => this.writeInbox(inbox);
        this.inbox.onOpenNote = link => this.openNote(link);
        this.inbox.listNotes = () => {
            const root = this.noteRoot(this.doc);
            return root ? listMarkdownFiles(root) : [];
        };
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
                doc.file = moved;  // dokumen yang terbuka ikut pindah; isi buffer tidak berubah
                this.refreshTitle(doc);
            }
            this.syncHistory(true);
        };
        this.fileTree.onDeleted = path => {
            for (const doc of this.docs) {
                if (!doc.file || !remapPath(doc.file, path, path)) continue;
                // Dokumen yang terbuka ikut terbuang: isinya tetap di editor, ditandai belum disimpan.
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
        // Hanya simpan dokumen berkas yang ada perubahannya; tanpa berkas, jangan memunculkan dialog simpan.
        this.history.beforeCommit = () => this.saveOpenFiles();
        this.history.onCommitted = () => {
            this.toast(_('Berhasil di-commit'));
            this.syncHistory(true);
        };
        this.history.onOpenChanges = file => {
            const viewer = new HistoryViewer(this.win, file, null, this.dark);
            viewer.beforeCommit = () => this.saveOpenFiles();
            viewer.onCommitted = () => {
                this.toast(_('Berhasil di-commit'));
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
            git: request => this.fileTree.root ? agentGit(this.fileTree.root, request) : Promise.resolve({ ok: false, message: 'tidak ada folder kerja' }),
            window: () => this.win,
            files: fresh => {
                const files = this.fileTree.root ? readProject(this.fileTree.root, this.file, fresh) : [];
                // Tab lain yang belum disimpan: asisten membaca isi editor, bukan versi di disk.
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

        // Tata letak
        const [width, height] = fitToScreen(settings.width, settings.height);
        this.win = new Adw.ApplicationWindow({ application: app, default_width: width, default_height: height });
        addBundledIcons(this.win.get_display());
        this.win.set_icon_name(APP_ID);
        const column = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true });
        column.append(this.tabBar.widget);
        column.append(this.findBar);
        this.content.add_named(this.board.widget, 'board');
        this.content.add_named(this.inbox.widget, 'inbox');
        column.append(this.content);
        column.append(this.statusBar);
        // Panel Asisten di kanan, selebar tetap; sisanya untuk editor.
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
        // true = tahan penutupan. Bila ada dokumen yang perlu ditanyakan, jendela ditahan dulu lalu
        // ditutup lagi setelah semua dialog dijawab setuju.
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
        // Jendela dihancurkan (ditutup, atau destroy() di tes). GTK 4 tidak memancarkan "destroy"
        // untuk widget yang masih dipegang JavaScript, jadi timer komponen dihentikan di sini.
        this.win.connect('unrealize', () => this.dispose());
        // Commit baru biasanya dibuat di luar aplikasi; saat kembali ke jendela, muat ulang riwayat.
        this.win.connect('notify::is-active', () => {
            if (this.win.is_active) this.syncHistory(true);
        });

        registerActions(app, this);
        this.setDark(settings.dark);
        // Tema sistem berubah (Gaya Gelap GNOME) saat pengaturannya "ikuti sistem".
        Adw.StyleManager.get_default().connect('notify::dark', () => {
            if (this.settings.dark === null && Adw.StyleManager.get_default().dark !== this.dark) this.setDark(null);
        });
        // Aksen sistem berubah (libadwaita ≥ 1.6): warnai ulang tag teks; libadwaita lama tidak punya properti ini.
        if (GObject.Object.find_property.call(Adw.StyleManager, 'accent-color'))
            Adw.StyleManager.get_default().connect('notify::accent-color', () => this.setDark(this.colorScheme));
        settings.gsettings.connect('changed', (_gs, key) => this.onSettingChanged(key));
        // Visibilitas panel mengikuti GSettings dua arah; efek sampingnya dipasang pada perubahan widgetnya.
        this.bindPanel('sidebar', this.sidebar.widget);
        this.bindPanel('chat', this.chatSplit);
        this.sidebar.widget.connect('notify::show-sidebar', () => this.syncHistory());
        this.chatSplit.connect('notify::show-sidebar', () => {
            if (!this.chatSplit.show_sidebar) return;
            this.chat.updateContextSummary();
            this.chat.focusInput();
        });
        this.tabBar.setActive(this.doc.id);

        // Isi awal: folder dari argumen, atau folder terakhir; lalu file, atau tab terakhir
        // jika dibuka tanpa argumen (path di baris perintah berarti pengguna meminta isi tertentu).
        this.sidebar.setPage(settings.sidebarPage);
        if (path && isDirectory(path)) this.openFolder(path);
        else if (settings.folder && isDirectory(settings.folder)) this.openFolder(settings.folder, false);
        if (path && !isDirectory(path)) {
            this.load(path);
        } else if (!path && this.restoreTabs()) {
            // tab terakhir dipulihkan
        } else if (!settings.welcomed) {
            this.editor.setText(WELCOME);
            settings.welcomed = true;
        } else {
            this.editor.setText('');
        }
        this.syncMode();
        this.updateTitle();
        this.win.present();
        this.syncHistory();
        this.editor.view.grab_focus();
    }

    // Pemberitahuan singkat yang hilang sendiri (Adw.Toast).
    toast(message: string): void {
        this.lastToast = message;
        this.toasts.add_toast(new Adw.Toast({ title: message, timeout: 3 }));
    }

    // ---------- Dokumen aktif ----------

    get editor(): MarkdownView {
        return this.doc.editor;
    }

    // Path dokumen aktif, null = belum pernah disimpan.
    get file(): string | null {
        return this.doc.file;
    }

    set file(path: string | null) {
        this.doc.file = path;
    }

    // Jumlah dokumen yang terbuka (tab).
    get documentCount(): number {
        return this.docs.length;
    }

    // Buat dokumen kosong beserta editornya, tanpa mengaktifkannya.
    private addDoc(): Doc {
        const editor = new MarkdownView();
        const doc: Doc = { id: this.nextId++, editor, file: null, textOverride: false, boardText: '', reloadQueued: false, autosaveTimer: 0, lastChange: 0, changes: 0 };
        // Callback editor hanya berlaku saat dokumennya aktif; yang di latar tidak menyentuh outline dan status bar.
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
        // Teks berubah selagi papan tampil dan bukan dari papan sendiri (undo/redo): baca ulang.
        editor.buffer.connect('changed', () => {
            doc.changes++;
            this.queueBoardReload(doc);
            this.queueAutosave(doc);
        });

        // Dokumen baru mewarisi mode dan tema dokumen yang sedang aktif.
        if (this.docs.length) {
            for (const mode of Object.keys(MODE_LABELS) as Mode[]) if (this.doc.editor.modes[mode]) editor.setMode(mode, true);
        }
        if (this.palette) editor.setPalette(this.palette);
        this.docs.push(doc);
        this.content.add_named(editor.widget, `doc-${doc.id}`);
        this.tabBar.add(doc.id, UNTITLED);
        return doc;
    }

    // Jadikan doc dokumen aktif: semua komponen bersama mengikutinya.
    private activate(doc: Doc): void {
        if (doc === this.doc) return;
        const previous = this.doc;
        this.doc = doc;
        this.autosave(previous);   // meninggalkan tab = titik aman untuk menyimpan
        this.findBar.setTarget(doc.editor.buffer, doc.editor.view);
        this.tabBar.setActive(doc.id);
        this.outline.update(doc.editor.headings);
        this.syncMode();
        this.updateTitle();
        this.fileTree.reveal(doc.file);
        this.syncHistory();
        if (this.chatSplit.show_sidebar) this.chat.updateContextSummary();
    }

    // Nama tab/judul untuk dokumen.
    private nameOf(doc: Doc): string {
        return doc.file ? GLib.path_get_basename(doc.file) : UNTITLED;
    }

    // Dokumen tanpa file dan tanpa perubahan tidak ada isinya yang perlu dipertahankan,
    // jadi boleh dipakai ulang untuk file yang dibuka berikutnya.
    private isPristine(doc: Doc): boolean {
        return !doc.file && !doc.editor.buffer.get_modified();
    }

    // Tab sesudah/sebelum yang aktif (berputar).
    switchTab(step: number): void {
        const ids = this.tabBar.ids();
        const at = ids.indexOf(this.doc.id);
        const doc = this.docs.find(d => d.id === ids[(at + step + ids.length) % ids.length]);
        if (doc) this.activate(doc);
    }

    // Tutup tab (bertanya jika ada perubahan). Menutup satu-satunya tab mengosongkan dokumennya.
    closeTab(doc: Doc = this.doc): Awaitable<boolean> {
        return after(this.confirmDiscard(doc), yes => yes && this.docs.includes(doc) && this.removeTab(doc));
    }

    private removeTab(doc: Doc): boolean {
        if (this.docs.length === 1) {
            this.resetDocument(doc);
            return true;
        }
        const index = this.docs.indexOf(doc);
        this.cancelAutosave(doc);
        this.docs.splice(index, 1);
        this.tabBar.remove(doc.id);
        // Pindah dulu, baru hancurkan: pencarian dan komponen lain masih menunjuk ke editor ini.
        if (doc === this.doc) this.activate(this.docs[Math.min(index, this.docs.length - 1)]);
        doc.editor.destroy();
        this.content.remove(doc.editor.widget);
        return true;
    }

    // ---------- Pemulihan tab ----------

    // Catat tab berfile (urut seperti baris tab) beserta kursornya untuk pembukaan berikutnya.
    // Dokumen tanpa file tidak dicatat: isinya tidak ada di disk untuk dibaca lagi.
    private rememberTabs(): void {
        const docs = this.tabBar.ids()
            .map(id => this.docs.find(d => d.id === id))
            .filter((d): d is Doc => !!d?.file);
        this.settings.tabs = docs.map(d => ({ file: d.file!, cursor: d.editor.cursorOffset }));
        this.settings.activeTab = docs.indexOf(this.doc);
    }

    // Buka lagi tab dari pengaturan. File yang sudah hilang dilewati (tidak dibuat ulang).
    // true = ada tab yang dipulihkan.
    private restoreTabs(): boolean {
        const saved = Array.isArray(this.settings.tabs) ? this.settings.tabs : [];
        const opened: [Doc, number][] = [];
        let active: Doc | null = null;
        let missing = 0;
        for (const [i, tab] of saved.entries()) {
            if (typeof tab?.file !== 'string' || !fileExists(tab.file) || isDirectory(tab.file)) {
                missing++;
                continue;
            }
            if (!this.openInTab(tab.file)) continue;
            opened.push([this.doc, Number(tab.cursor) || 0]);
            if (i === this.settings.activeTab) active = this.doc;
        }
        if (!opened.length) return false;
        for (const [doc, cursor] of opened) doc.editor.restoreCursor(cursor);
        this.activate(active ?? opened[opened.length - 1][0]);
        if (missing) this.toast(fmt(_('{missing} berkas dari sesi terakhir tidak ditemukan'), { missing }));
        return true;
    }

    // ---------- Pengaturan tampilan ----------

    // gsettings.bind(key, split, 'show-sidebar') ditambah perilaku saat jendela menyempit. Tanpa pin,
    // OverlaySplitView menyembunyikan panel saat melipat dan selalu membukanya lagi saat melebar, sehingga panel
    // yang sengaja ditutup ikut terbuka. Dengan pin, hal itu diatur di sini: melipat menutup panel (pengaturan
    // ikut false supaya tombol header tetap sesuai), melebar memulihkan pengaturan sebelum melipat.
    private readonly widePanels = new Map<'sidebar' | 'chat', boolean>();   // pengaturan panel sebelum melipat

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

    // Tata letak adaptif (HIG): di jendela sempit panel samping tidak lagi memakan lebar editor, tetapi
    // melayang di atasnya (OverlaySplitView collapsed) dan tertutup saat konten diklik. Panel Asisten
    // (360) melipat lebih dulu daripada sidebar (240). Ukuran minimum jendela wajib ada untuk breakpoint.
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

    // dark null = ikuti tema sistem.
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

    // ---------- Asisten ----------

    // Terapkan perubahan usulan agent yang sudah disetujui pengguna. Mengembalikan pesan galat atau null.
    // Berkas yang terbuka diubah lewat editornya (satu langkah undo); yang lain ditulis ke disk. Dalam kedua
    // kasus isi harus masih sama dengan yang dilihat agent, supaya suntingan pengguna tidak tertimpa.
    // Hapus membuang ke Tempat Sampah; dokumen yang terbuka tetap di editor seperti saat dihapus dari pohon.
    private applyChangeBatch(changes: Change[]): string | null {
        const root = this.fileTree.root;
        if (!root) return 'tidak ada folder kerja';
        // Pertahanan berlapis: planChange() sudah menolak nama seperti ini, tetapi penulisan ke disk tidak boleh bergantung padanya.
        if (changes.some(c => changeFiles(c).some(f => cleanNewName(f) !== f))) return 'path di luar folder kerja atau tidak valid';
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
        return error;
    }

    private applyChange(change: Change): string | null {
        const root = this.fileTree.root;
        if (!root) return 'tidak ada folder kerja yang terbuka';
        const error = this.applyChangeBatch([change]);
        if (!error && change.kind === 'create') this.openInTab(projectPath(root, change.file));
        return error;
    }

    // Nama berkas relatif terhadap folder proyek (sama dengan nama di agent/project.ts); null jika di luar folder atau belum disimpan.
    private projectName(path: string | null): string | null {
        const root = this.fileTree.root;
        return path && root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path ? GLib.path_get_basename(path) : null;
    }

    // ---------- Tautan [[catatan]] ----------

    // Folder tempat [[catatan]] dicari: folder kerja bila dokumen ada di dalamnya (atau belum disimpan),
    // kalau tidak folder dokumen itu sendiri.
    private noteRoot(doc: Doc): string | null {
        const root = this.fileTree.root;
        if (root && (!doc.file || doc.file.startsWith(`${root}/`))) return root;
        return doc.file ? GLib.path_get_dirname(doc.file) : null;
    }

    // Ctrl+klik [[catatan]]: buka berkasnya di tab. Catatan yang belum ada dibuka sebagai dokumen kosong
    // di samping dokumen asal dan baru tertulis ke disk saat disimpan, jadi klik yang keliru tidak meninggalkan berkas.
    openNote(link: WikiLink, doc = this.doc): void {
        if (!link.target) {
            if (link.heading) this.jumpToHeading(doc, link.heading);
            return;
        }
        const root = this.noteRoot(doc);
        if (!root) {
            this.toast(_('Buka folder atau simpan dokumen dulu untuk mengikuti tautan [[catatan]]'));
            return;
        }
        const from = doc.file?.startsWith(`${root}/`) ? doc.file.slice(root.length + 1) : null;
        const found = resolveWikiLink(link.target, listMarkdownFiles(root), from);
        const rel = found ?? newNotePath(link.target, from);
        if (!rel) {
            this.toast(fmt(_('Nama catatan tidak valid: {target}'), { target: link.target }));
            return;
        }
        const path = GLib.build_filenamev([root, ...rel.split('/')]);
        if (!found) GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
        if (!this.openInTab(path)) return;
        if (!found) this.toast(fmt(_('Catatan baru: {rel} (tersimpan setelah diisi)'), { rel }));
        else if (link.heading) this.jumpToHeading(this.doc, link.heading);
    }

    // Catatan yang ditautkan kartu di papan `boardFile`, untuk konteks prompt harness. Dicari dengan aturan yang sama
    // seperti Ctrl+klik; dokumen yang sedang terbuka dibaca dari editornya supaya suntingan yang belum tersimpan ikut.
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
        else this.toast(fmt(_('Bagian tidak ditemukan: {heading}'), { heading }));
    }

    // ---------- Papan kanban ----------

    get boardMode(): boolean {
        return this.content.visible_child_name === 'board';
    }

    get inboxMode(): boolean {
        return this.content.visible_child_name === 'inbox';
    }

    // Dokumen kanban tampil sebagai papan dan dokumen inbox sebagai inbox, kecuali pengguna memilih tampilan teks.
    private syncMode(): void {
        const text = this.editor.getText();
        const structured = !this.doc.textOverride;
        this.setView(structured && isKanban(text) ? 'board' : structured && isInbox(text) ? 'inbox' : 'text');
    }

    setBoardMode(on: boolean): void {
        this.setView(on ? 'board' : 'text');
    }

    private setView(view: 'board' | 'inbox' | 'text'): void {
        if (view === 'board') {
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
        if (action instanceof Gio.SimpleAction) action.set_state(GLib.Variant.new_boolean(view !== 'text'));
        this.syncActionsEnabled();
    }

    // Aksi penyunting teks mati selama papan kanban tampil (teksnya tersembunyi).
    syncActionsEnabled(): void {
        const board = this.boardMode || this.inboxMode;
        for (const name of TEXT_ACTIONS) {
            const action = this.app.lookup_action(name);
            if (action instanceof Gio.SimpleAction) action.set_enabled(!board);
        }
    }

    // Menu/pintasan "Tampilan Papan": berganti antara papan/inbox dan teks untuk dokumen kanban atau inbox.
    toggleBoardView(on: boolean): void {
        const text = this.editor.getText();
        if (on && !isKanban(text) && !isInbox(text)) {
            this.toast(_('Dokumen ini bukan papan kanban atau inbox (butuh "kanban: true" atau "inbox: true" di frontmatter)'));
            this.setBoardMode(false);
            return;
        }
        this.doc.textOverride = !on;
        this.syncMode();
    }

    // Dokumen baru berisi papan kanban kosong.
    newBoardDocument(): void {
        this.resetDocument(this.blankDocument(), serializeBoard(newBoard()));
    }

    // Dokumen baru berisi inbox kosong.
    newInboxDocument(): void {
        this.resetDocument(this.blankDocument(), serializeInbox(newInbox()));
        this.inbox.focusCapture();
    }

    // ---------- Riwayat git ----------

    // Riwayat hanya dimuat saat tabnya terlihat, supaya git tidak dipanggil percuma.
    // force = baca ulang walau file yang sama.
    syncHistory(force = false): void {
        if (!this.sidebar.visible || this.sidebar.page !== 'history') return;
        this.history.setFile(this.file, force, this.fileTree.root);
    }

    private showBoardCounts(board: Board): void {
        this.statusBar.setBoardCounts(board.columns.length, countCards(board));
    }

    // Perubahan dari inbox → teks dokumen (satu langkah undo).
    private writeInbox(inbox: Inbox): void {
        const text = serializeInbox(inbox);
        this.doc.boardText = text;
        this.editor.replaceText(text);
        this.statusBar.setInboxCounts(inbox.items.length);
    }

    // Perubahan dari papan → teks dokumen (satu langkah undo).
    private writeBoard(board: Board): void {
        const text = serializeBoard(board);
        this.doc.boardText = text;   // mengenali perubahan ini sebagai milik papan sendiri
        this.editor.replaceText(text);
        this.showBoardCounts(board);
    }

    // ---------- Harness eksternal ----------

    // Entri menu kartu untuk menugaskan, menghentikan, dan memantau harness.
    private harnessMenu(card: Card, at: Position): MenuEntry[] {
        const file = this.file;
        const run = file ? this.orchestrator.queue.find(file, card.text) : null;
        const active = run && isActive(run.status) ? run : null;
        const agent = cardMeta(card.text).agent;
        const entries: MenuEntry[] = Object.values(HARNESSES).map(spec => ({
            label: fmt(_('Kerjakan dengan {label}'), { label: spec.label }),
            enabled: !!file && !active && card.done !== true,
            run: () => this.runHarness(at, spec.name),
        }));
        if (active?.status === 'waiting') entries.push({ label: fmt(_('Jawab {agent}…'), { agent: active.agent }), run: () => this.answerHarness(active) });
        if (active?.status === 'working') entries.push({ label: fmt(_('Beri Arahan {agent}…'), { agent: active.agent }), run: () => this.steerHarness(active) });
        if (run && !active && run.result?.sessionId) entries.push({ label: fmt(_('Balas {agent}…'), { agent: run.agent }), run: () => this.replyHarness(run) });
        if (active) entries.push({ label: active.status === 'queued' ? _('Batalkan Antrean') : fmt(_('Hentikan {agent}'), { agent: active.agent }), run: () => this.orchestrator.stop(active) });
        if (run) entries.push({ label: fmt(_('Lihat Log {agent}'), { agent: run.agent }), run: () => this.showRunLog(run) });
        if (agent && !active) entries.push({ label: _('Lepas Penugasan'), run: () => this.board.commit(updateCard(this.board.getBoard(), at, { text: assignCard(card.text, null) })) });
        const project = cardProject(this.board.getBoard(), card);
        if (project && this.settings.projects[project]) entries.push({ label: _('Ganti Folder Proyek…'), run: () => this.chooseProjectFolder(project) });
        return entries;
    }

    // Jalankan harness untuk kartu di papan aktif. Folder proyek ditanyakan sekali lalu diingat di pengaturan.
    runHarness(at: Position, agent: string): void {
        const file = this.file;
        if (!file) { this.toast(_('Simpan papan dulu sebelum menugaskan kartu')); return; }
        const card = this.board.getBoard().columns[at.column]?.cards[at.index];
        if (!card) return;
        const project = cardProject(this.board.getBoard(), card);
        if (project && this.settings.projects[project]) {
            this.startHarness(file, at, agent, project);
            return;
        }
        void after(this.chooseProjectFolder(project), folder => {
            if (!folder) return;
            // Dialog folder bisa lama terbuka: kartu yang ditugaskan harus masih ada di papan yang sama.
            if (this.file !== file || this.board.getBoard().columns[at.column]?.cards[at.index]?.text !== card.text) {
                this.toast(_('Papan berubah selama memilih folder; tugaskan ulang kartunya'));
                return;
            }
            if (!project) {
                // Belum ada nama proyek: pakai nama foldernya dan catat di kartu supaya giliran berikutnya tidak bertanya lagi.
                const tagged = `${card.text} #proyek/${folder.name}`;
                this.board.commit(updateCard(this.board.getBoard(), at, { text: tagged }));
            }
            this.startHarness(file, at, agent, project ?? folder.name);
        });
    }

    private startHarness(file: string, at: Position, agent: string, project: string): void {
        const error = this.orchestrator.start(file, this.board.getBoard(), at, agent, project, this.settings.projects[project], GLib.path_get_basename(file));
        if (error) this.toast(fmt(_('Tidak bisa menjalankan {agent}: {error}'), { agent, error }));
    }

    // Pilih folder untuk proyek `name` (atau proyek baru bila null) dan simpan pemetaannya.
    private chooseProjectFolder(name: string | null): Awaitable<{ name: string; path: string } | null> {
        return after(this.harnessDialogs.chooseFolder(name ? fmt(_('Folder proyek “{name}”'), { name }) : _('Pilih folder proyek')), path => this.mapProjectFolder(name, path));
    }

    private mapProjectFolder(name: string | null, path: string | null): { name: string; path: string } | null {
        if (!path) return null;
        const project = name ?? GLib.path_get_basename(path).replace(/\s+/g, '-');
        const problem = !PROJECT_NAME.test(project) ? fmt(_('nama folder "{name}" tidak bisa dipakai sebagai nama proyek'), { name: project }) : checkProjectFolder(path, this.fileTree.root);
        if (problem) { this.toast(fmt(_('Folder proyek ditolak: {problem}'), { problem })); return null; }
        this.settings.projects = { ...this.settings.projects, [project]: path };
        return { name: project, path };
    }

    answerHarness(run: Run): void {
        if (!run.ask) return;
        void after(this.harnessDialogs.answer(run.ask, run.agent), reply => {
            if (!reply) return;   // Nanti: harness tetap menunggu
            const error = this.orchestrator.answer(run, reply);
            if (error) this.toast(fmt(_('Jawaban tidak terkirim: {error}'), { error }));
        });
    }

    private steerHarness(run: Run): void {
        void after(this.harnessDialogs.text({ title: fmt(_('Arahan untuk {agent}'), { agent: run.agent }), label: fmt(_('{agent} menerimanya sebelum langkah berikutnya, tanpa menghentikan pekerjaan.'), { agent: run.agent }) }), text => {
            if (!text) return;
            const error = this.orchestrator.steer(run, text);
            this.toast(error ? fmt(_('Arahan tidak terkirim: {error}'), { error }) : fmt(_('Arahan dikirim ke {agent}'), { agent: run.agent }));
        });
    }

    private replyHarness(run: Run): void {
        void after(this.harnessDialogs.text({ title: fmt(_('Balas {agent}'), { agent: run.agent }), label: fmt(_('Sesi {agent} dilanjutkan dengan balasan ini; kartu kembali dikerjakan.'), { agent: run.agent }), context: run.result?.summary || undefined }), text => {
            if (!text) return;
            const error = this.orchestrator.resume(run, text);
            if (error) this.toast(fmt(_('Tidak bisa membalas {agent}: {error}'), { agent: run.agent, error }));
        });
    }

    showRunLog(run: Run): LogViewer {
        const open = this.runLogs.get(run.id);
        if (open?.window.get_realized()) { open.show(); return open; }
        const viewer = new LogViewer(this.win, run.trace, fmt(_('Log {agent} — {title}'), { agent: run.agent, title: run.title }));
        this.runLogs.set(run.id, viewer);
        viewer.show();
        return viewer;
    }

    // Ubah papan di `file` untuk orkestrator: lewat editornya bila terbuka (satu langkah undo), selain itu langsung di disk.
    private updateBoardFile(file: string, edit: (board: Board) => Board): string | null {
        const doc = this.docs.find(d => d.file === file);
        try {
            if (!doc) waitForWrites(file);
            const text = doc ? doc.editor.getText() : readTextFile(file);
            if (!isKanban(text)) return 'berkas papan bukan papan kanban lagi';
            const board = parseBoard(text);
            const next = edit(board);
            if (next === board) return null;
            if (doc === this.doc && this.boardMode) {
                this.board.setBoard(next);
                this.writeBoard(next);
            } else if (doc) doc.editor.replaceText(serializeBoard(next));
            else writeTextFile(file, serializeBoard(next));
            return null;
        } catch (e) {
            return errorMessage(e);
        }
    }

    private queueBoardReload(doc: Doc): void {
        if (doc !== this.doc || !(this.boardMode || this.inboxMode) || doc.reloadQueued) return;
        doc.reloadQueued = true;
        // Ditunda: undo mengubah teks dalam beberapa langkah, dan yang dibaca harus hasil akhirnya.
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
                doc.textOverride = true;   // bukan papan/inbox lagi (misalnya frontmatter terhapus)
                this.setView('text');
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // Ubah pilihan tampilan. Semua kecuali mode source adalah kunci GSettings: menuliskannya cukup,
    // karena sidebar dan asisten terikat ke kuncinya (Gio.Settings.bind) dan sisanya diterapkan
    // onSettingChanged. Aksi toggle di menu (Gio.Settings.create_action) memakai jalur yang sama.
    setOption(key: Option, value: boolean): void {
        if (key === 'source') for (const doc of this.docs) doc.editor.setMode('source', value);
        else if (key === 'dark') {
            this.setDark(value);
            this.settings.dark = value;
        } else this.settings[key] = value;
    }

    // Perubahan GSettings (menu, dialog preferensi, atau proses lain) yang perlu diterapkan ke komponen.
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

    // Dipanggil di setiap perubahan teks, jadi dibuat murah: hanya mencatat waktu. Timer tidak
    // dibuat ulang per ketukan; saat berbunyi, ia menunda diri lagi jika masih ada ketikan baru.
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

    // Auto save dari timer: file ditulis di thread pekerja (lihat writeTextFileAsync), jadi
    // thread utama hanya menyalin teks. Penulisan sinkron berikutnya ke file yang sama
    // menunggu yang ini selesai. true = penulisan dimulai.
    autosaveInBackground(doc: Doc = this.doc, done: () => void = () => {}): boolean {
        this.cancelAutosave(doc);
        const path = doc.file;
        if (!doc.editor.buffer.get_modified() || !this.settings.autosave || !path) return false;
        const changes = doc.changes;
        writeTextFileAsync(path, doc.editor.getText(), error => {
            if (error) {
                this.toast(fmt(_('Auto save gagal: {error}'), { error: errorMessage(error) }));
            } else if (this.docs.includes(doc) && doc.file === path && doc.changes === changes) {
                // Teks tidak berubah selama ditulis: isi di disk sama dengan buffer.
                doc.editor.buffer.set_modified(false);
            }
            done();
        });
        return true;
    }

    // Simpan diam-diam tanpa dialog atau toast. true = tidak ada perubahan yang tertinggal.
    autosave(doc: Doc = this.doc): boolean {
        this.cancelAutosave(doc);
        if (!doc.editor.buffer.get_modified()) return true;
        if (!this.settings.autosave || !doc.file) return false;
        try {
            writeTextFile(doc.file, doc.editor.getText());
        } catch (e) {
            // Bukan dialog: auto save terus mencoba, dan dialog berulang mengganggu mengetik.
            this.toast(fmt(_('Auto save gagal: {error}'), { error: errorMessage(e) }));
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

    // ---------- Dokumen ----------

    get documentName(): string {
        return this.nameOf(this.doc);
    }

    // Nama file usulan dari heading pertama.
    suggestName(): string {
        const h = this.editor.headings[0];
        return h?.text ? h.text.replace(/[\/\\:*?"<>|]/g, '').slice(0, 60) : UNTITLED;
    }

    updateTitle(): void {
        this.refreshTitle(this.doc);
    }

    // Judul tab untuk doc, dan judul jendela jika doc sedang aktif.
    private refreshTitle(doc: Doc): void {
        if (!this.docs.includes(doc)) return;
        const mark = doc.editor.buffer.get_modified() ? '• ' : '';
        const name = this.nameOf(doc);
        this.tabBar.setTitle(doc.id, `${mark}${name}`, doc.file);
        if (doc !== this.doc) return;
        this.header.setTitle(`${mark}${name}`, doc.file ? GLib.path_get_dirname(doc.file).replace(GLib.get_home_dir(), '~') : APP_NAME);
        this.win.set_title(`${mark}${name} — ${APP_NAME}`);
    }

    // Jika ada perubahan, tanya dulu. true = boleh lanjut membuang dokumen ini.
    // Tanpa perubahan yang perlu ditanyakan, jawabannya langsung (tanpa Promise).
    confirmDiscard(doc: Doc = this.doc): Awaitable<boolean> {
        if (this.autosave(doc)) return true;
        this.activate(doc);   // pengguna perlu melihat dokumen mana yang ditanyakan
        return askSaveChanges(this.win, this.nameOf(doc)).then(answer => {
            if (answer !== 'save') return answer === 'discard';
            this.activate(doc);
            return this.save();
        });
    }

    // Tanyakan dokumen satu per satu; berhenti pada jawaban Batal pertama.
    private confirmDiscardAll(docs: Doc[]): Awaitable<boolean> {
        for (let i = 0; i < docs.length; i++) {
            const answer = this.confirmDiscard(docs[i]);
            if (answer === false) return false;
            if (answer !== true) return answer.then(yes => yes && this.confirmDiscardAll(docs.slice(i + 1)));
        }
        return true;
    }

    // Simpan semua dokumen berfile yang berubah (sebelum commit git). Dokumen tanpa file tidak disentuh.
    private saveOpenFiles(): boolean {
        for (const doc of this.docs) {
            if (!doc.file || !doc.editor.buffer.get_modified()) continue;
            if (!this.write(doc.file, doc.editor.getText())) return false;
            doc.editor.buffer.set_modified(false);
            this.cancelAutosave(doc);
        }
        return true;
    }

    // Dokumen yang boleh ditimpa: yang aktif jika tak ada isinya yang perlu dipertahankan, kalau tidak tab baru.
    private blankDocument(): Doc {
        const doc = this.isPristine(this.doc) ? this.doc : this.addDoc();
        this.activate(doc);
        return doc;
    }

    // Kosongkan doc (atau isi dengan text) sebagai dokumen baru tanpa file.
    private resetDocument(doc: Doc, text = ''): void {
        this.activate(doc);
        doc.file = null;
        doc.editor.setText(text);
        doc.textOverride = false;
        this.syncMode();
        this.updateTitle();
        this.fileTree.reveal(null);
        this.syncHistory();
    }

    // Ctrl+N: dokumen kosong di tab baru.
    newDocument(): void {
        this.resetDocument(this.blankDocument());
    }

    // Isi dokumen aktif dengan file absolute yang sudah dibaca (text).
    private show(absolute: string, text: string): void {
        // this.file diisi sebelum setText(): path gambar relatif dihitung dari foldernya.
        this.file = absolute;
        this.editor.setText(text);
        this.doc.textOverride = false;
        this.syncMode();
        this.updateTitle();
        this.fileTree.reveal(absolute);
        this.syncHistory();
    }

    private read(absolute: string): string | null {
        try {
            return fileExists(absolute) ? readTextFile(absolute) : '';  // file baru jika belum ada
        } catch (e) {
            void showError(this.win, fmt(_('Gagal membuka file:\n{error}'), { error: errorMessage(e) }));
            return null;
        }
    }

    // Buka file di dokumen aktif, menggantikan isinya. Jika path ternyata folder (misalnya dipilih
    // lewat dialog Buka File, atau diberikan dari baris perintah), folder itu dibuka di tab Berkas.
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

    // Buka file di tab: pindah ke tabnya jika sudah terbuka, pakai dokumen kosong yang aktif jika ada,
    // kalau tidak buka tab baru.
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

    // Buka file yang dipilih di pohon berkas.
    openFile(path: string): void {
        if (path === this.file) return;
        if (!this.openInTab(path)) this.fileTree.reveal(this.file);  // kembalikan sorotan ke file yang masih terbuka
    }

    async chooseFolder(): Promise<void> {
        const path = await chooseFile(this.win, { title: _('Buka Folder'), selectFolder: true, folder: this.fileTree.root });
        if (path) this.openFolder(path);
    }

    // Tampilkan folder di tab Berkas dan ingat untuk dibuka lagi lain kali.
    // show = false saat memulihkan folder terakhir, supaya sidebar yang sengaja
    // ditutup tidak tiba-tiba muncul.
    openFolder(path: string, show = true): void {
        const absolute = Gio.File.new_for_path(path).get_path() ?? path;
        this.fileTree.setRoot(absolute);
        this.fileTree.reveal(this.file);
        this.syncHistory();
        this.settings.folder = absolute;
        if (!show) return;
        this.sidebar.setPage('files');
        this.settings.sidebar = true;
    }

    async open(): Promise<void> {
        const path = await chooseFile(this.win, { title: _('Buka Markdown'), filters: ['markdown', 'all'] });
        if (path) this.openInTab(path);
    }

    private write(path: string, text: string): boolean {
        try {
            writeTextFile(path, text);
            return true;
        } catch (e) {
            void showError(this.win, fmt(_('Gagal menyimpan:\n{error}'), { error: errorMessage(e) }));
            return false;
        }
    }

    // Dokumen berfile disimpan seketika (hasil boolean); dokumen baru menunggu dialog Simpan Sebagai.
    save(): Awaitable<boolean> {
        if (!this.file) return this.saveAs();
        if (!this.write(this.file, this.editor.getText())) return false;
        this.editor.buffer.set_modified(false);
        this.cancelAutosave(this.doc);
        this.toast(_('Tersimpan'));
        return true;
    }

    async saveAs(): Promise<boolean> {
        const doc = this.doc;
        let path = await chooseFile(this.win, {
            title: _('Simpan Markdown'), save: true, filters: ['markdown', 'all'],
            name: this.file ? this.documentName : `${this.suggestName()}.md`,
            // Dokumen baru disimpan di folder yang sedang dibuka.
            folder: this.file ? null : this.fileTree.root,
        });
        if (!path || !this.docs.includes(doc)) return false;
        if (!/\.[^/]+$/.test(GLib.path_get_basename(path))) path += '.md';
        this.activate(doc);
        this.file = path;
        this.updateTitle();
        if (!this.save()) return false;
        // Tampilkan file baru di pohon tanpa menunggu pemantau disk.
        this.fileTree.refresh(GLib.path_get_dirname(path));
        this.fileTree.reveal(path);
        this.syncHistory();
        return true;
    }

    async exportHtml(): Promise<void> {
        const base = this.file ? this.documentName.replace(/\.[^.]+$/, '') : this.suggestName();
        const text = this.editor.getText(), title = this.editor.headings[0]?.text || base;
        const path = await chooseFile(this.win, {
            title: _('Ekspor HTML'), save: true, filters: ['html', 'all'], name: `${base}.html`,
            folder: this.file ? GLib.path_get_dirname(this.file) : null,
        });
        if (!path) return;
        const html = markdownToHtml(text, title);
        if (this.write(path, html)) this.toast(fmt(_('Diekspor ke {name}'), { name: GLib.path_get_basename(path) }));
    }

    // Sisipkan ![nama](path). Path dibuat relatif terhadap file jika memungkinkan.
    async insertImage(): Promise<void> {
        const doc = this.doc;
        let path = await chooseFile(this.win, { title: _('Pilih Gambar'), filters: ['image'] });
        if (!path || doc !== this.doc) return;
        if (this.file) {
            const dir = Gio.File.new_for_path(GLib.path_get_dirname(this.file));
            path = dir.get_relative_path(Gio.File.new_for_path(path)) ?? path;
        }
        const alt = GLib.path_get_basename(path).replace(/\.[^.]+$/, '');
        this.editor.buffer.insert_at_cursor(`![${alt}](${encodeURI(path)})`, -1);
    }

    // true = jendela boleh ditutup. Tiap dokumen yang berubah ditanyakan satu per satu.
    onClose(): Awaitable<boolean> {
        return after(this.confirmDiscardAll([...this.docs]), yes => yes && this.rememberWindow());
    }

    private rememberWindow(): true {
        // Ditutup selagi sempit: simpan pengaturan panel untuk tata letak lebar, bukan keadaan terlipat.
        for (const [key, value] of this.widePanels) this.settings.gsettings.set_boolean(key, value);
        // Setelah konfirmasi: dokumen baru yang disimpan lewat dialog sudah punya file.
        this.rememberTabs();
        // Di GTK 4 ukuran default mengikuti ukuran jendela saat ini.
        const [width, height] = this.win.get_default_size();
        Object.assign(this.settings, { width, height });
        return true;
    }

    // Hentikan timer dan idle semua komponen setelah jendela dihancurkan.
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
