// Jendela utama: menyusun komponen, menghubungkan callback antar-komponen,
// dan menangani dokumen (buka, simpan, ekspor).
//
//   ┌ HeaderBar ─────────────────────────────────────┐
//   │ Sidebar   │ FindBar                            │
//   │ ┌Berkas┬Outline┐ MarkdownView                  │
//   │ FileTree  │                                    │
//   │ / Outline │ StatusBar                          │
//   └───────────┴────────────────────────────────────┘

import Gtk from 'gi://Gtk?version=3.0';
import Gdk from 'gi://Gdk?version=3.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { APP_NAME } from './config.js';
import { saveSettings, type Settings } from './settings.js';
import { readTextFile, writeTextFile, fileExists } from './files.js';
import { markdownToHtml } from './markdown/html.js';
import { WELCOME } from './welcome.js';
import { MarkdownView, type Mode } from './editor/view.js';
import { Outline } from './ui/outline.js';
import { FileTree, isDirectory } from './ui/filetree.js';
import { Sidebar } from './ui/sidebar.js';
import { FindBar } from './ui/findbar.js';
import { StatusBar } from './ui/statusbar.js';
import { createHeaderBar } from './ui/headerbar.js';
import { applyTheme, systemPrefersDark } from './ui/theme.js';
import { chooseFile, askSaveChanges, showError } from './ui/dialogs.js';
import { registerActions } from './actions.js';

const UNTITLED = 'Tanpa Judul';

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
export type Option = 'sidebar' | 'dark' | Mode;

export class MainWindow {
    readonly app: Gtk.Application;
    readonly settings: Settings;
    readonly editor: MarkdownView;
    readonly outline: Outline;
    readonly fileTree: FileTree;
    readonly sidebar: Sidebar;
    readonly findBar: FindBar;
    readonly statusBar: StatusBar;
    readonly header: Gtk.HeaderBar;
    readonly win: Gtk.ApplicationWindow;

    file: string | null = null;   // path dokumen, null = belum pernah disimpan
    dark: boolean;

    // path: file atau folder yang dibuka saat jendela muncul.
    constructor(app: Gtk.Application, settings: Settings, path: string | null = null) {
        this.app = app;
        this.settings = settings;
        this.dark = settings.dark ?? systemPrefersDark();

        // Komponen
        this.editor = new MarkdownView();
        this.outline = new Outline();
        this.fileTree = new FileTree();
        this.sidebar = new Sidebar(this.fileTree.widget, this.outline.widget);
        this.findBar = new FindBar(this.editor.buffer, this.editor.view);
        this.statusBar = new StatusBar();
        this.header = createHeaderBar();

        this.editor.modes.focus = settings.focus;
        this.editor.modes.typewriter = settings.typewriter;

        // Komponen tidak saling kenal; jendela inilah yang menghubungkan mereka.
        this.editor.onHighlighted = ({ text, headings }) => {
            this.outline.update(headings);
            this.statusBar.setCounts(text);
        };
        this.editor.onCursorMoved = (line, column) => {
            this.statusBar.setCursor(line, column);
            this.statusBar.setModes((Object.keys(MODE_LABELS) as Mode[]).filter(m => this.editor.modes[m]).map(m => MODE_LABELS[m]));
        };
        this.editor.onMessage = msg => this.statusBar.toast(msg);
        this.editor.getBaseDir = () => this.file ? GLib.path_get_dirname(this.file) : GLib.get_home_dir();
        this.outline.onJump = line => this.editor.jumpToLine(line);
        this.fileTree.onOpenFile = file => this.openFile(file);
        this.sidebar.onPageChanged = page => {
            this.settings.sidebarPage = page;
            saveSettings(this.settings);
        };
        this.editor.buffer.connect('modified-changed', () => this.updateTitle());

        // Tata letak
        const [width, height] = fitToScreen(settings.width, settings.height);
        this.win = new Gtk.ApplicationWindow({ application: app, default_width: width, default_height: height });
        this.win.set_icon_name('accessories-text-editor');
        this.win.set_titlebar(this.header);
        const column = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        column.pack_start(this.findBar.widget, false, false, 0);
        column.pack_start(this.editor.widget, true, true, 0);
        column.pack_start(this.statusBar.widget, false, false, 0);
        const main = new Gtk.Box();
        main.pack_start(this.sidebar.widget, false, false, 0);
        main.pack_start(column, true, true, 0);
        this.win.add(main);
        this.win.connect('delete-event', () => !this.onClose());

        registerActions(app, this);
        this.setDark(this.dark);

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
        this.updateTitle();
        this.win.show_all();
        this.sidebar.setVisible(settings.sidebar);
        this.editor.view.grab_focus();
    }

    // ---------- Pengaturan tampilan ----------

    setDark(dark: boolean): void {
        this.dark = dark;
        this.editor.setPalette(applyTheme(dark));
    }

    // Ubah pilihan tampilan lalu terapkan. Semua kecuali mode source disimpan ke pengaturan.
    setOption(key: Option, value: boolean): void {
        if (key === 'sidebar') this.sidebar.setVisible(value);
        else if (key === 'dark') this.setDark(value);
        else this.editor.setMode(key, value);
        if (key !== 'source') {
            this.settings[key] = value;
            saveSettings(this.settings);
        }
    }

    // ---------- Dokumen ----------

    get documentName(): string {
        return this.file ? GLib.path_get_basename(this.file) : UNTITLED;
    }

    // Nama file usulan dari heading pertama.
    suggestName(): string {
        const h = this.editor.headings[0];
        return h?.text ? h.text.replace(/[\/\\:*?"<>|]/g, '').slice(0, 60) : UNTITLED;
    }

    updateTitle(): void {
        const mark = this.editor.buffer.get_modified() ? '• ' : '';
        this.header.set_title(`${mark}${this.documentName}`);
        this.header.set_subtitle(this.file ? GLib.path_get_dirname(this.file).replace(GLib.get_home_dir(), '~') : APP_NAME);
        this.win.set_title(`${mark}${this.documentName} — ${APP_NAME}`);
    }

    // Jika ada perubahan, tanya dulu. true = boleh lanjut membuang dokumen ini.
    confirmDiscard(): boolean {
        if (!this.editor.buffer.get_modified()) return true;
        const answer = askSaveChanges(this.win, this.documentName);
        if (answer === 'save') return this.save();
        return answer === 'discard';
    }

    newDocument(): void {
        if (!this.confirmDiscard()) return;
        this.file = null;
        this.editor.setText('');
        this.updateTitle();
        this.fileTree.reveal(null);
    }

    // Buka file di editor. Jika path ternyata folder (misalnya dipilih lewat dialog
    // Buka File, atau diberikan dari baris perintah), folder itu dibuka di tab Berkas.
    load(path: string): boolean {
        const absolute = Gio.File.new_for_path(path).get_path() ?? path;
        if (isDirectory(absolute)) {
            this.openFolder(absolute);
            return true;
        }
        try {
            const text = fileExists(absolute) ? readTextFile(absolute) : '';  // file baru jika belum ada
            // this.file diisi sebelum setText(): path gambar relatif dihitung dari foldernya.
            this.file = absolute;
            this.editor.setText(text);
            this.updateTitle();
            this.fileTree.reveal(absolute);
            return true;
        } catch (e) {
            showError(this.win, `Gagal membuka file:\n${errorMessage(e)}`);
            return false;
        }
    }

    // Buka file yang dipilih di pohon berkas.
    openFile(path: string): void {
        if (path === this.file) return;
        if (!this.confirmDiscard()) {
            this.fileTree.reveal(this.file);  // kembalikan sorotan ke file yang masih terbuka
            return;
        }
        this.load(path);
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
        this.settings.folder = absolute;
        saveSettings(this.settings);
        if (!show) return;
        this.sidebar.setPage('files');
        if (!this.sidebar.visible) this.app.lookup_action('sidebar')?.change_state(GLib.Variant.new_boolean(true));
    }

    open(): void {
        if (!this.confirmDiscard()) return;
        const path = chooseFile(this.win, { title: 'Buka Markdown', filters: ['markdown', 'all'] });
        if (path) this.load(path);
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

    // true = jendela boleh ditutup.
    onClose(): boolean {
        if (!this.confirmDiscard()) return false;
        const [width, height] = this.win.get_size();
        Object.assign(this.settings, { width, height });
        saveSettings(this.settings);
        return true;
    }
}
