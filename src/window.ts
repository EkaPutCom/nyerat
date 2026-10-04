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

import Gtk from 'gi://Gtk?version=3.0';
import Gdk from 'gi://Gdk?version=3.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { APP_NAME } from './config.js';
import { saveSettings, type Settings } from './settings.js';
import { readTextFile, writeTextFile, writeTextFileAsync, fileExists } from './files.js';
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
import { readProject } from './agent/project.js';
import { FindBar } from './ui/findbar.js';
import { StatusBar } from './ui/statusbar.js';
import { TabBar } from './ui/tabbar.js';
import { createHeaderBar } from './ui/headerbar.js';
import { applyTheme, systemPrefersDark, type Palette } from './ui/theme.js';
import { chooseFile, askSaveChanges, showError } from './ui/dialogs.js';
import { registerActions } from './actions.js';
import { ImageViewer } from './ui/imageviewer.js';
import { KanbanBoard } from './ui/kanban.js';
import { countCards, isKanban, newBoard, parseBoard, serializeBoard, type Board } from './markdown/kanban.js';

const UNTITLED = 'Tanpa Judul';
// Jeda tanpa ketikan sebelum auto save menulis ke disk.
const AUTOSAVE_DELAY_MS = 1000;

const errorMessage = (e: unknown): string => e instanceof Error ? e.message : String(e);

// Ukuran jendela tersimpan bisa lebih besar dari layar (misalnya setelah pindah
// ke monitor yang lebih kecil); batasi ke area kerja monitor.
function fitToScreen(width: number, height: number): [number, number] {
    const display = Gdk.Display.get_default();
    const monitor = display?.get_primary_monitor() ?? display?.get_monitor(0);
    if (!monitor) return [width, height];
    const area = monitor.get_workarea();
    return [Math.min(width, area.width), Math.min(height, area.height)];
}
const MODE_LABELS: Record<Mode, string> = { source: 'Source', focus: 'Fokus', typewriter: 'Typewriter' };

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
    readonly app: Gtk.Application;
    readonly settings: Settings;
    readonly outline: Outline;
    readonly history: History;
    readonly fileTree: FileTree;
    readonly sidebar: Sidebar;
    readonly findBar: FindBar;
    readonly statusBar: StatusBar;
    readonly tabBar: TabBar;
    readonly board: KanbanBoard;
    readonly chat: ChatPanel;
    readonly chatRevealer: Gtk.Revealer;
    private readonly content: Gtk.Stack;
    readonly header: Gtk.HeaderBar;
    readonly win: Gtk.ApplicationWindow;

    private docs: Doc[] = [];
    private doc: Doc;                 // dokumen aktif
    private nextId = 1;
    private palette: Palette | null = null;
    dark: boolean;

    // path: file atau folder yang dibuka saat jendela muncul.
    constructor(app: Gtk.Application, settings: Settings, path: string | null = null) {
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
        this.chat = new ChatPanel();
        this.header = createHeaderBar();

        this.doc = this.addDoc();
        this.doc.editor.modes.focus = settings.focus;
        this.doc.editor.modes.typewriter = settings.typewriter;
        this.findBar = new FindBar(this.doc.editor.buffer, this.doc.editor.view);

        // Komponen tidak saling kenal; jendela inilah yang menghubungkan mereka.
        this.board.onChange = board => this.writeBoard(board);
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
            this.statusBar.toast('Berhasil di-commit');
            this.syncHistory(true);
        };
        this.history.onOpenChanges = file => {
            const viewer = new HistoryViewer(this.win, file, null, this.dark);
            viewer.beforeCommit = () => this.saveOpenFiles();
            viewer.onCommitted = () => {
                this.statusBar.toast('Berhasil di-commit');
                this.syncHistory(true);
            };
            viewer.show();
        };
        this.chat.setModel(settings.chatModel);
        this.chat.setThinking(settings.chatThinking);
        this.chat.onModelChanged = model => {
            this.settings.chatModel = model;
            saveSettings(this.settings);
        };
        this.chat.setSaveChats(settings.chatSave);
        this.chat.onSaveChanged = save => {
            this.settings.chatSave = save;
            saveSettings(this.settings);
        };
        this.chat.onThinkingChanged = thinking => {
            this.settings.chatThinking = thinking;
            saveSettings(this.settings);
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
            files: () => {
                const files = this.fileTree.root ? readProject(this.fileTree.root, this.file) : [];
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
            saveSettings(this.settings);
            this.syncHistory();
        };

        // Tata letak
        const [width, height] = fitToScreen(settings.width, settings.height);
        this.win = new Gtk.ApplicationWindow({ application: app, default_width: width, default_height: height });
        this.win.set_icon_name('accessories-text-editor');
        this.win.set_titlebar(this.header);
        const column = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        column.pack_start(this.tabBar.widget, false, false, 0);
        column.pack_start(this.findBar.widget, false, false, 0);
        this.content.add_named(this.board.widget, 'board');
        // Anak yang belum ditampilkan tidak bisa dipilih lewat visible_child_name, dan syncMode()
        // dijalankan sebelum show_all() jendela.
        this.board.widget.show_all();
        column.pack_start(this.content, true, true, 0);
        column.pack_start(this.statusBar.widget, false, false, 0);
        const main = new Gtk.Box();
        main.pack_start(this.sidebar.widget, false, false, 0);
        main.pack_start(column, true, true, 0);
        const chatWrap = new Gtk.Box();
        chatWrap.pack_start(new Gtk.Separator({ orientation: Gtk.Orientation.VERTICAL }), false, false, 0);
        chatWrap.pack_start(this.chat.widget, false, false, 0);
        this.chatRevealer = new Gtk.Revealer({ transition_type: Gtk.RevealerTransitionType.SLIDE_LEFT, transition_duration: 150 });
        this.chatRevealer.add(chatWrap);
        main.pack_start(this.chatRevealer, false, false, 0);
        this.win.add(main);
        this.win.connect('delete-event', () => !this.onClose());
        // Commit baru biasanya dibuat di luar aplikasi; saat kembali ke jendela, muat ulang riwayat.
        this.win.connect('notify::is-active', () => {
            if (this.win.is_active) this.syncHistory(true);
        });

        registerActions(app, this);
        this.setDark(this.dark);
        this.tabBar.setActive(this.doc.id);

        // Isi awal: folder dari argumen, atau folder terakhir; lalu file.
        this.sidebar.setPage(settings.sidebarPage);
        if (path && isDirectory(path)) this.openFolder(path);
        else if (settings.folder && isDirectory(settings.folder)) this.openFolder(settings.folder, false);
        if (path && !isDirectory(path)) {
            this.load(path);
        } else if (!settings.welcomed) {
            this.editor.setText(WELCOME);
            settings.welcomed = true;
        } else {
            this.editor.setText('');
        }
        this.syncMode();
        this.updateTitle();
        this.win.show_all();
        this.sidebar.setVisible(settings.sidebar);
        this.setChatVisible(settings.chat);
        this.syncHistory();
        this.editor.view.grab_focus();
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
            if (!this.boardMode) this.statusBar.setDocumentCounts(words, characters);
        };
        editor.onCursorMoved = (line, column) => {
            if (doc !== this.doc) return;
            this.statusBar.setCursor(line, column);
            this.statusBar.setModes((Object.keys(MODE_LABELS) as Mode[]).filter(m => editor.modes[m]).map(m => MODE_LABELS[m]));
        };
        editor.onMessage = msg => this.statusBar.toast(msg);
        editor.onViewImage = (pixbuf, title) => new ImageViewer(this.win, pixbuf, title).show();
        editor.getBaseDir = () => doc.file ? GLib.path_get_dirname(doc.file) : GLib.get_home_dir();
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
        editor.widget.show_all();   // visible_child_name hanya bisa memilih anak yang sudah ditampilkan
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
        if (this.chatRevealer.get_reveal_child()) this.chat.updateContextSummary();
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
    closeTab(doc: Doc = this.doc): boolean {
        if (!this.confirmDiscard(doc)) return false;
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
        doc.editor.widget.destroy();   // sekaligus melepasnya dari stack
        return true;
    }

    // ---------- Pengaturan tampilan ----------

    setDark(dark: boolean): void {
        this.dark = dark;
        const palette = applyTheme(dark);
        this.palette = palette;
        for (const doc of this.docs) doc.editor.setPalette(palette);
        this.board.setPalette(palette);
        this.chat.setPalette(palette);
    }

    // ---------- Asisten ----------

    setChatVisible(visible: boolean): void {
        this.chatRevealer.set_reveal_child(visible);
        if (!visible) return;
        this.chat.updateContextSummary();
        this.chat.focusInput();
    }

    // Nama berkas relatif terhadap folder proyek (sama dengan nama di agent/project.ts); null jika di luar folder atau belum disimpan.
    private projectName(path: string | null): string | null {
        const root = this.fileTree.root;
        return path && root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path ? GLib.path_get_basename(path) : null;
    }

    // ---------- Papan kanban ----------

    get boardMode(): boolean {
        return this.content.visible_child_name === 'board';
    }

    // Dokumen kanban tampil sebagai papan, kecuali pengguna memilih tampilan teks.
    private syncMode(): void {
        this.setBoardMode(isKanban(this.editor.getText()) && !this.doc.textOverride);
    }

    setBoardMode(on: boolean): void {
        if (on) {
            this.board.setBoard(parseBoard(this.editor.getText()));
            this.doc.boardText = this.editor.getText();
            this.findBar.close();
            this.content.visible_child_name = 'board';
            this.showBoardCounts(this.board.getBoard());
        } else {
            this.content.visible_child_name = `doc-${this.doc.id}`;
            this.statusBar.setCounts(this.editor.getText());
            this.editor.updateCursor(true);
            this.editor.view.grab_focus();
        }
        const action = this.app.lookup_action('kanban-view');
        if (action instanceof Gio.SimpleAction) action.set_state(GLib.Variant.new_boolean(on));
    }

    // Menu/pintasan "Tampilan Papan": berganti antara papan dan teks untuk dokumen kanban.
    toggleBoardView(on: boolean): void {
        if (on && !isKanban(this.editor.getText())) {
            this.statusBar.toast('Dokumen ini bukan papan kanban (butuh "kanban: true" di frontmatter)');
            this.setBoardMode(false);
            return;
        }
        this.doc.textOverride = !on;
        this.setBoardMode(on);
    }

    // Dokumen baru berisi papan kanban kosong.
    newBoardDocument(): void {
        this.resetDocument(this.blankDocument(), serializeBoard(newBoard()));
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

    // Perubahan dari papan → teks dokumen (satu langkah undo).
    private writeBoard(board: Board): void {
        const text = serializeBoard(board);
        this.doc.boardText = text;   // mengenali perubahan ini sebagai milik papan sendiri
        this.editor.replaceText(text);
        this.showBoardCounts(board);
    }

    private queueBoardReload(doc: Doc): void {
        if (doc !== this.doc || !this.boardMode || doc.reloadQueued) return;
        doc.reloadQueued = true;
        // Ditunda: undo mengubah teks dalam beberapa langkah, dan yang dibaca harus hasil akhirnya.
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            doc.reloadQueued = false;
            if (doc !== this.doc || !this.docs.includes(doc)) return GLib.SOURCE_REMOVE;
            const text = doc.editor.getText();
            if (!this.boardMode || text === doc.boardText) return GLib.SOURCE_REMOVE;
            if (isKanban(text)) {
                this.board.setBoard(parseBoard(text));
                doc.boardText = text;
                this.showBoardCounts(this.board.getBoard());
            } else {
                doc.textOverride = true;   // bukan papan lagi (misalnya frontmatter terhapus)
                this.setBoardMode(false);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // Ubah pilihan tampilan lalu terapkan. Semua kecuali mode source disimpan ke pengaturan.
    setOption(key: Option, value: boolean): void {
        if (key === 'sidebar') {
            this.sidebar.setVisible(value);
            this.syncHistory();
        }
        else if (key === 'chat') this.setChatVisible(value);
        else if (key === 'dark') this.setDark(value);
        else if (key !== 'autosave') for (const doc of this.docs) doc.editor.setMode(key, value);
        if (key !== 'source') {
            this.settings[key] = value;
            saveSettings(this.settings);
        }
        if (key === 'autosave' && value) for (const doc of this.docs) this.queueAutosave(doc);
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
                this.statusBar.toast(`Auto save gagal: ${errorMessage(error)}`);
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
            this.statusBar.toast(`Auto save gagal: ${errorMessage(e)}`);
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
        this.header.set_title(`${mark}${name}`);
        this.header.set_subtitle(doc.file ? GLib.path_get_dirname(doc.file).replace(GLib.get_home_dir(), '~') : APP_NAME);
        this.win.set_title(`${mark}${name} — ${APP_NAME}`);
    }

    // Jika ada perubahan, tanya dulu. true = boleh lanjut membuang dokumen ini.
    confirmDiscard(doc: Doc = this.doc): boolean {
        if (this.autosave(doc)) return true;
        this.activate(doc);   // pengguna perlu melihat dokumen mana yang ditanyakan
        const answer = askSaveChanges(this.win, this.nameOf(doc));
        if (answer === 'save') return this.save();
        return answer === 'discard';
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
            showError(this.win, `Gagal membuka file:\n${errorMessage(e)}`);
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

    chooseFolder(): void {
        const path = chooseFile(this.win, { title: 'Buka Folder', selectFolder: true, folder: this.fileTree.root });
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
        saveSettings(this.settings);
        if (!show) return;
        this.sidebar.setPage('files');
        if (!this.sidebar.visible) this.app.lookup_action('sidebar')?.change_state(GLib.Variant.new_boolean(true));
    }

    open(): void {
        const path = chooseFile(this.win, { title: 'Buka Markdown', filters: ['markdown', 'all'] });
        if (path) this.openInTab(path);
    }

    private write(path: string, text: string): boolean {
        try {
            writeTextFile(path, text);
            return true;
        } catch (e) {
            showError(this.win, `Gagal menyimpan:\n${errorMessage(e)}`);
            return false;
        }
    }

    save(): boolean {
        if (!this.file) return this.saveAs();
        if (!this.write(this.file, this.editor.getText())) return false;
        this.editor.buffer.set_modified(false);
        this.cancelAutosave(this.doc);
        this.statusBar.toast('Tersimpan');
        return true;
    }

    saveAs(): boolean {
        let path = chooseFile(this.win, {
            title: 'Simpan Markdown', save: true, filters: ['markdown', 'all'],
            name: this.file ? this.documentName : `${this.suggestName()}.md`,
            // Dokumen baru disimpan di folder yang sedang dibuka.
            folder: this.file ? null : this.fileTree.root,
        });
        if (!path) return false;
        if (!/\.[^/]+$/.test(GLib.path_get_basename(path))) path += '.md';
        this.file = path;
        this.updateTitle();
        if (!this.save()) return false;
        // Tampilkan file baru di pohon tanpa menunggu pemantau disk.
        this.fileTree.refresh(GLib.path_get_dirname(path));
        this.fileTree.reveal(path);
        this.syncHistory();
        return true;
    }

    exportHtml(): void {
        const base = this.file ? this.documentName.replace(/\.[^.]+$/, '') : this.suggestName();
        const path = chooseFile(this.win, {
            title: 'Ekspor HTML', save: true, filters: ['html', 'all'], name: `${base}.html`,
            folder: this.file ? GLib.path_get_dirname(this.file) : null,
        });
        if (!path) return;
        const html = markdownToHtml(this.editor.getText(), this.editor.headings[0]?.text || base);
        if (this.write(path, html)) this.statusBar.toast(`Diekspor ke ${GLib.path_get_basename(path)}`);
    }

    // Sisipkan ![nama](path). Path dibuat relatif terhadap file jika memungkinkan.
    insertImage(): void {
        let path = chooseFile(this.win, { title: 'Pilih Gambar', filters: ['image'] });
        if (!path) return;
        if (this.file) {
            const dir = Gio.File.new_for_path(GLib.path_get_dirname(this.file));
            path = dir.get_relative_path(Gio.File.new_for_path(path)) ?? path;
        }
        const alt = GLib.path_get_basename(path).replace(/\.[^.]+$/, '');
        this.editor.buffer.insert_at_cursor(`![${alt}](${encodeURI(path)})`, -1);
    }

    // true = jendela boleh ditutup. Tiap dokumen yang berubah ditanyakan satu per satu.
    onClose(): boolean {
        for (const doc of [...this.docs]) if (!this.confirmDiscard(doc)) return false;
        const [width, height] = this.win.get_size();
        Object.assign(this.settings, { width, height });
        saveSettings(this.settings);
        return true;
    }
}
