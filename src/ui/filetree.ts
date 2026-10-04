// Panel berkas: pohon folder berisi subfolder dan file Markdown.
//
// - Isi subfolder baru dibaca saat folder itu dibuka (lazy), supaya folder besar
//   tetap cepat dibuka. Sampai saat itu, subfolder berisi satu baris kosong
//   sebagai pengganti agar tanda ▸ tetap tampil.
// - Setiap folder yang sudah dibaca dipantau dengan Gio.FileMonitor. Jika ada
//   file yang ditambah atau dihapus di disk, hanya baris yang berubah yang
//   disisipkan/dihapus, jadi subfolder yang sedang terbuka tidak ikut tertutup.
// - File dan folder tersembunyi (diawali titik) serta node_modules tidak ditampilkan.

import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import { createFile, createFolder, moveEntry, renameEntry, trashEntry } from '../fileops.js';
import { confirmDialog, promptDialog, showError } from './dialogs.js';
import { onClick, pack } from '../gtkutil.js';
import { popupMenu, separator, type MenuEntry } from './menu.js';

export const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd'];
const SKIPPED_FOLDERS = new Set(['node_modules']);
const EXPAND_DELAY = 600;   // ms; folder tertutup dibuka otomatis bila ditahan saat drag
const NO_ACTION = 0 as Gdk.DragAction;
const REFRESH_DELAY = 150;  // ms; perubahan beruntun di disk digabung jadi satu refresh

// Kolom di Gtk.TreeStore.
const enum Col { Name, Path, IsDir, Icon, Loaded }

export interface FolderEntry {
    name: string;
    path: string;
    isDir: boolean;
}

export const isMarkdownFile = (name: string): boolean =>
    MARKDOWN_EXTENSIONS.some(ext => name.toLowerCase().endsWith(ext));

export const isDirectory = (path: string): boolean => GLib.file_test(path, GLib.FileTest.IS_DIR);

// Subfolder dulu, lalu file; masing-masing urut abjad tanpa membedakan huruf besar,
// dengan angka diurutkan secara alami ("bab 2" sebelum "bab 10").
function compareEntries(a: FolderEntry, b: FolderEntry): number {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

// Isi satu folder yang ditampilkan di pohon, sudah terurut.
export function listFolder(path: string): FolderEntry[] {
    const entries: FolderEntry[] = [];
    let enumerator: Gio.FileEnumerator;
    try {
        enumerator = Gio.File.new_for_path(path).enumerate_children(
            'standard::name,standard::type,standard::is-hidden', Gio.FileQueryInfoFlags.NONE, null);
    } catch {
        return entries;  // folder terhapus atau tidak bisa dibaca
    }
    let info: Gio.FileInfo | null;
    while ((info = enumerator.next_file(null))) {
        const name = info.get_name();
        if (name.startsWith('.') || info.get_is_hidden() || SKIPPED_FOLDERS.has(name)) continue;
        const isDir = info.get_file_type() === Gio.FileType.DIRECTORY;
        if (!isDir && !isMarkdownFile(name)) continue;
        entries.push({ name, path: GLib.build_filenamev([path, name]), isDir });
    }
    enumerator.close(null);
    return entries.sort(compareEntries);
}

export class FileTree {
    readonly store: Gtk.TreeStore;
    readonly view: Gtk.TreeView;
    readonly widget: Gtk.Box;
    root: string | null = null;

    onOpenFile: (path: string) => void = () => {};  // file diklik
    onMoved: (from: string, to: string) => void = () => {};  // file/folder dipindah atau diganti namanya
    onDeleted: (path: string) => void = () => {};            // file/folder dibuang ke sampah

    // Dapat diganti di tes: dialog yang menahan program tidak bisa dipakai di sana.
    dialogs = {
        prompt: (title: string, label: string, value?: string): string | null => promptDialog(this.parentWindow(), { title, label, value }),
        confirm: (message: string, detail: string): boolean => confirmDialog(this.parentWindow(), message, detail),
        error: (message: string): void => showError(this.parentWindow(), message),
    };

    private readonly title: Gtk.Label;
    private readonly pages: Gtk.Stack;
    private monitors = new Map<string, Gio.FileMonitor>();  // path folder → pemantau
    private pendingRefresh = new Map<string, number>();     // path folder → id timeout
    private dragSource: string | null = null;               // path yang sedang di-drag
    private expandTimer = 0;
    private revealed: string | null = null;                 // file yang terakhir disorot reveal()

    constructor() {
        this.store = new Gtk.TreeStore();
        this.store.set_column_types([
            GObject.TYPE_STRING, GObject.TYPE_STRING, GObject.TYPE_BOOLEAN, GObject.TYPE_STRING, GObject.TYPE_BOOLEAN,
        ]);

        this.view = new Gtk.TreeView({
            model: this.store, headers_visible: false, activate_on_single_click: true,
            enable_search: true, search_column: Col.Name,
        });
        const column = new Gtk.TreeViewColumn();
        const icon = new Gtk.CellRendererPixbuf({ xpad: 4 });
        column.pack_start(icon, false);
        column.add_attribute(icon, 'icon-name', Col.Icon);
        const text = new Gtk.CellRendererText({ ellipsize: Pango.EllipsizeMode.END });
        column.pack_start(text, true);
        column.add_attribute(text, 'text', Col.Name);
        this.view.append_column(column);
        onClick(this.view, (_n, x, y) => this.showContextMenu(x, y), 3);
        this.setupDrag();
        this.view.connect('row-activated', (_view, path) => this.activate(path));
        this.view.connect('test-expand-row', (_view, iter) => {
            this.loadChildren(iter);
            return false;  // false = boleh dibuka
        });

        const scroll = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true });
        scroll.set_child(this.view);

        // Tampilan saat belum ada folder yang dibuka.
        const empty = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, valign: Gtk.Align.CENTER, margin_top: 16, margin_bottom: 16, margin_start: 16, margin_end: 16 });
        const hint = new Gtk.Label({ label: 'Belum ada folder yang dibuka', wrap: true, justify: Gtk.Justification.CENTER });
        hint.add_css_class('dim-label');
        const button = new Gtk.Button({ label: 'Buka Folder…', action_name: 'app.open-folder', halign: Gtk.Align.CENTER });
        empty.append(hint);
        empty.append(button);

        this.pages = new Gtk.Stack({ vexpand: true });
        this.pages.add_named(empty, 'empty');
        this.pages.add_named(scroll, 'tree');

        this.title = new Gtk.Label({ label: 'BERKAS', xalign: 0, margin_start: 16, margin_top: 4, margin_bottom: 8,
            ellipsize: Pango.EllipsizeMode.END });
        this.title.add_css_class('side-title');

        // Judul = folder root; lepas item di sini memindahkannya ke luar semua subfolder.
        const titleBox = new Gtk.Box();
        this.title.set_hexpand(true);
        titleBox.append(this.title);
        this.setupTitleDrop(titleBox);

        // hexpand false: judul mengembang di dalam kotaknya, dan GTK 4 meneruskannya ke atas sampai sidebar.
        this.widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: false });
        this.widget.append(titleBox);
        pack(this.widget, this.pages, true);
    }

    // Jendela ditutup: hentikan pemantau disk dan timer.
    destroy(): void {
        this.cancelExpand();
        this.setRoot(null);
    }

    // Ganti folder yang ditampilkan; null = tidak ada folder.
    setRoot(path: string | null): void {
        for (const monitor of this.monitors.values()) monitor.cancel();
        this.monitors.clear();
        for (const id of this.pendingRefresh.values()) GLib.source_remove(id);
        this.pendingRefresh.clear();
        this.store.clear();
        this.root = path;

        if (!path) {
            this.title.label = 'BERKAS';
            this.title.tooltip_text = null;
            this.pages.visible_child_name = 'empty';
            return;
        }
        this.title.label = GLib.path_get_basename(path).toUpperCase();
        this.title.tooltip_text = path;
        for (const entry of listFolder(path)) this.addRow(null, entry, null);
        this.watch(path);
        this.pages.visible_child_name = 'tree';
    }

    // Sorot file di pohon, membuka folder-folder induknya bila perlu.
    // false jika file tidak berada di dalam folder yang dibuka.
    reveal(filePath: string | null): boolean {
        this.revealed = filePath;
        this.view.get_selection().unselect_all();
        const iter = filePath ? this.findRow(filePath, true) : null;
        if (!iter) return false;
        const path = this.store.get_path(iter);
        if (!path) return false;
        this.view.get_selection().select_iter(iter);
        this.view.scroll_to_cell(path, null, false, 0, 0);
        return true;
    }

    // Baca ulang satu folder dari disk dan samakan barisnya.
    refresh(dirPath: string): void {
        const parent = dirPath === this.root ? null : this.findRow(dirPath, false);
        if (dirPath !== this.root && (!parent || !this.get(parent, Col.Loaded))) return;
        const entries = listFolder(dirPath);
        const wanted = new Set(entries.map(e => e.path));

        // 1. Hapus baris yang sudah tidak ada di disk.
        for (const path of this.childPaths(parent)) {
            if (wanted.has(path)) continue;
            const iter = this.findChild(parent, path);
            if (iter) this.store.remove(iter);
            this.unwatchTree(path);
        }

        // 2. Sisipkan baris baru di posisi urutnya. Daftar anak sekarang adalah
        //    subset terurut dari entries, jadi cukup berjalan bersamaan.
        let [ok, iter] = this.store.iter_children(parent);
        for (const entry of entries) {
            if (ok && this.get(iter, Col.Path) === entry.path) {
                ok = this.store.iter_next(iter);
            } else {
                this.addRow(parent, entry, ok ? iter : null);
            }
        }
    }

    // ---------- Buat file/folder ----------

    private parentWindow(): Gtk.Window | null {
        const top = this.widget.get_root();
        return top instanceof Gtk.Window ? top : null;
    }

    // Folder tempat item baru dibuat untuk baris yang diklik kanan: folder itu sendiri,
    // atau folder induk file; null (area kosong) = root.
    private targetDir(treePath: Gtk.TreePath | null): string | null {
        if (treePath) {
            const [ok, iter] = this.store.get_iter(treePath);
            if (ok) {
                const path = this.get(iter, Col.Path);
                return this.get(iter, Col.IsDir) ? path : GLib.path_get_dirname(path);
            }
        }
        return this.root;
    }

    // Tanya nama lalu buat file/folder di dir. File baru langsung dibuka di editor.
    create(kind: 'file' | 'folder', dir: string): string | null {
        const label = kind === 'file' ? 'Nama file' : 'Nama folder';
        const name = this.dialogs.prompt(kind === 'file' ? 'File Baru' : 'Folder Baru', label);
        if (name === null) return null;
        let path: string;
        try {
            path = kind === 'file' ? createFile(dir, name) : createFolder(dir, name);
        } catch (e) {
            this.dialogs.error((e as Error).message);
            return null;
        }
        this.refresh(dir);
        this.reveal(path);
        if (kind === 'file') this.onOpenFile(path);
        return path;
    }

    // Ganti nama file/folder lewat dialog.
    rename(path: string): string | null {
        const isDir = isDirectory(path);
        const name = this.dialogs.prompt('Ganti Nama', isDir ? 'Nama folder' : 'Nama file', GLib.path_get_basename(path));
        if (name === null) return null;
        let target: string | null;
        try {
            target = renameEntry(path, name);
        } catch (e) {
            this.dialogs.error((e as Error).message);
            return null;
        }
        if (!target) return null;
        this.refresh(GLib.path_get_dirname(path));
        this.reveal(target);
        this.onMoved(path, target);
        return target;
    }

    // Buang ke Tempat Sampah setelah konfirmasi.
    remove(path: string): boolean {
        const isDir = isDirectory(path);
        const name = GLib.path_get_basename(path);
        const detail = isDir ? 'Folder beserta seluruh isinya akan dipindahkan ke Tempat Sampah.' : 'File akan dipindahkan ke Tempat Sampah.';
        if (!this.dialogs.confirm(`Hapus “${name}”?`, detail)) return false;
        try {
            trashEntry(path);
        } catch (e) {
            this.dialogs.error((e as Error).message);
            return false;
        }
        this.refresh(GLib.path_get_dirname(path));
        this.onDeleted(path);
        return true;
    }

    // Menu klik kanan untuk baris tertentu (null = area kosong).
    contextMenu(treePath: Gtk.TreePath | null): MenuEntry[] {
        const dir = this.targetDir(treePath);
        const entries: MenuEntry[] = [
            { label: 'File Baru…', enabled: dir !== null, run: () => { if (dir) this.create('file', dir); } },
            { label: 'Folder Baru…', enabled: dir !== null, run: () => { if (dir) this.create('folder', dir); } },
        ];
        const rowPath = treePath ? this.pathOf(treePath) : null;
        if (rowPath) {
            entries.push(separator());
            entries.push({ label: 'Ganti Nama…', enabled: true, run: () => this.rename(rowPath) });
            entries.push({ label: 'Hapus', enabled: true, run: () => this.remove(rowPath) });
        }
        return entries;
    }

    // Klik kanan di (x, y), koordinat widget TreeView.
    private showContextMenu(x: number, y: number): boolean {
        if (!this.root) return false;
        const [bx, by] = this.view.convert_widget_to_bin_window_coords(Math.round(x), Math.round(y));
        const [found, treePath] = this.view.get_path_at_pos(bx, by);
        const row = found ? treePath : null;
        if (row) this.view.get_selection().select_path(row);
        else this.view.get_selection().unselect_all();

        popupMenu(this.view, this.contextMenu(row), x, y);
        return true;
    }

    private pathOf(treePath: Gtk.TreePath): string | null {
        const [ok, iter] = this.store.get_iter(treePath);
        return ok ? this.get(iter, Col.Path) : null;
    }

    // ---------- Pindah lewat drag and drop ----------

    // Drag memakai DragSource/DropTarget sendiri, bukan DnD model TreeView: TreeStore akan
    // memindahkan barisnya sendiri, padahal yang dipindah adalah berkas di disk.
    private setupDrag(): void {
        const source = new Gtk.DragSource({ actions: Gdk.DragAction.MOVE });
        source.connect('prepare', (_s, x, y) => {
            const [bx, by] = this.view.convert_widget_to_bin_window_coords(Math.round(x), Math.round(y));
            const [found, treePath] = this.view.get_path_at_pos(bx, by);
            this.dragSource = found && treePath ? this.pathOf(treePath) : null;
            if (!this.dragSource) return null;
            // Ikon drag: ikon jenis berkasnya. Tanpa ini GTK memakai gambar seluruh TreeView;
            // widget sebagai ikon (GtkDragIcon) memicu Gtk-CRITICAL saat drag selesai di GTK 4.14.
            const icon = Gtk.IconTheme.get_for_display(this.view.get_display()).lookup_icon(
                isDirectory(this.dragSource) ? 'folder-symbolic' : 'text-x-generic-symbolic', null, 32,
                this.view.get_scale_factor(), Gtk.TextDirection.NONE, 0 as Gtk.IconLookupFlags);
            source.set_icon(icon, 0, 0);
            return Gdk.ContentProvider.new_for_value(this.dragSource);
        });
        source.connect('drag-end', () => { this.dragSource = null; });
        this.view.add_controller(source);

        const target = new Gtk.DropTarget({ actions: Gdk.DragAction.MOVE });
        target.set_gtypes([GObject.TYPE_STRING]);
        target.connect('motion', (_t, x, y) => {
            const dir = this.dropDirAt(x, y);
            const valid = this.canMoveTo(dir);
            this.highlightDrop(valid ? this.dropRowAt(x, y) : null);
            this.scheduleExpand(x, y);
            return valid ? Gdk.DragAction.MOVE : NO_ACTION;
        });
        target.connect('leave', () => {
            this.highlightDrop(null);
            this.cancelExpand();
        });
        target.connect('drop', (_t, _value, x, y) => {
            this.cancelExpand();
            this.highlightDrop(null);
            const dir = this.dropDirAt(x, y);
            return this.canMoveTo(dir) && this.moveTo(this.dragSource!, dir!);
        });
        this.view.add_controller(target);
    }

    private setupTitleDrop(box: Gtk.Box): void {
        const target = new Gtk.DropTarget({ actions: Gdk.DragAction.MOVE });
        target.set_gtypes([GObject.TYPE_STRING]);
        target.connect('motion', () => {
            const valid = this.canMoveTo(this.root);
            if (valid) box.add_css_class('side-drop'); else box.remove_css_class('side-drop');
            return valid ? Gdk.DragAction.MOVE : NO_ACTION;
        });
        target.connect('leave', () => box.remove_css_class('side-drop'));
        target.connect('drop', () => {
            box.remove_css_class('side-drop');
            return this.canMoveTo(this.root) && this.moveTo(this.dragSource!, this.root!);
        });
        box.add_controller(target);
    }

    // Sorot baris tujuan dengan seleksi; null = kembalikan sorotan ke file yang terbuka.
    // Bukan set_drag_dest_row(): tanpa DnD model bawaan TreeView, GTK 4.14 crash (segfault)
    // saat menggambar penanda tujuan itu.
    private highlightDrop(row: Gtk.TreePath | null): void {
        const selection = this.view.get_selection();
        if (row) {
            selection.select_path(row);
            return;
        }
        const revealed = this.revealed ? this.findRow(this.revealed, false) : null;
        if (revealed) selection.select_iter(revealed);
        else selection.unselect_all();
    }

    private dropRowAt(x: number, y: number): Gtk.TreePath | null {
        const [found, treePath] = this.view.get_dest_row_at_pos(x, y);
        return found ? treePath : null;
    }

    // Folder tujuan di posisi itu: folder yang ditunjuk, folder induk file yang ditunjuk, atau root.
    private dropDirAt(x: number, y: number): string | null {
        return this.targetDir(this.dropRowAt(x, y));
    }

    // Lepas ke folder tempat item sudah berada = tidak berguna, dan folder ke dalam dirinya sendiri dilarang.
    private canMoveTo(dir: string | null): boolean {
        const source = this.dragSource;
        if (!source || !dir) return false;
        if (GLib.path_get_dirname(source) === dir) return false;
        return dir !== source && !dir.startsWith(`${source}/`);
    }

    private scheduleExpand(x: number, y: number): void {
        this.cancelExpand();
        const treePath = this.dropRowAt(x, y);
        if (!treePath || this.view.row_expanded(treePath)) return;
        const [ok, iter] = this.store.get_iter(treePath);
        if (!ok || !this.get(iter, Col.IsDir)) return;
        this.expandTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, EXPAND_DELAY, () => {
            this.expandTimer = 0;
            this.view.expand_row(treePath, false);
            return GLib.SOURCE_REMOVE;
        });
    }

    private cancelExpand(): void {
        if (this.expandTimer) GLib.source_remove(this.expandTimer);
        this.expandTimer = 0;
    }

    // Pindahkan source ke dalam dir, perbarui pohon, dan kabari pemilik (file yang terbuka ikut berpindah).
    moveTo(source: string, dir: string): boolean {
        let target: string | null;
        try {
            target = moveEntry(source, dir);
        } catch (e) {
            this.dialogs.error((e as Error).message);
            return false;
        }
        if (!target) return false;
        this.refresh(GLib.path_get_dirname(source));
        this.refresh(dir);
        const dirIter = dir === this.root ? null : this.findRow(dir, false);
        if (dirIter) {
            const dirPath = this.store.get_path(dirIter);
            if (dirPath && this.get(dirIter, Col.Loaded)) this.view.expand_row(dirPath, false);
        }
        this.reveal(target);
        this.onMoved(source, target);
        return true;
    }

    // ---------- Baris ----------

    private get(iter: Gtk.TreeIter, col: Col.Path | Col.Name | Col.Icon): string;
    private get(iter: Gtk.TreeIter, col: Col.IsDir | Col.Loaded): boolean;
    private get(iter: Gtk.TreeIter, col: Col): unknown {
        return this.store.get_value(iter, col);
    }

    private addRow(parent: Gtk.TreeIter | null, entry: FolderEntry, before: Gtk.TreeIter | null): Gtk.TreeIter {
        const iter = before ? this.store.insert_before(parent, before) : this.store.append(parent);
        this.store.set(iter, [Col.Name, Col.Path, Col.IsDir, Col.Icon, Col.Loaded],
            [entry.name, entry.path, entry.isDir, entry.isDir ? 'folder-symbolic' : 'text-x-generic-symbolic', false]);
        // Pengganti isi folder, supaya tanda ▸ tampil sebelum isinya dibaca.
        if (entry.isDir) this.store.set(this.store.append(iter), [Col.Name, Col.Path], ['', '']);
        return iter;
    }

    // Baca isi folder saat pertama kali dibuka.
    private loadChildren(iter: Gtk.TreeIter): void {
        if (!this.get(iter, Col.IsDir) || this.get(iter, Col.Loaded)) return;
        const path = this.get(iter, Col.Path);
        let [ok, child] = this.store.iter_children(iter);
        while (ok) ok = this.store.remove(child);  // remove() memajukan child ke baris berikutnya
        this.store.set(iter, [Col.Loaded], [true]);
        for (const entry of listFolder(path)) this.addRow(iter, entry, null);
        this.watch(path);
    }

    private childPaths(parent: Gtk.TreeIter | null): string[] {
        const paths: string[] = [];
        let [ok, iter] = this.store.iter_children(parent);
        while (ok) {
            paths.push(this.get(iter, Col.Path));
            ok = this.store.iter_next(iter);
        }
        return paths;
    }

    private findChild(parent: Gtk.TreeIter | null, path: string): Gtk.TreeIter | null {
        let [ok, iter] = this.store.iter_children(parent);
        while (ok) {
            if (this.get(iter, Col.Path) === path) return iter;
            ok = this.store.iter_next(iter);
        }
        return null;
    }

    // Cari baris untuk path di dalam folder root. load = baca dan buka folder
    // perantara yang belum dibaca; tanpa itu, path di folder yang belum dibaca
    // tidak ditemukan.
    private findRow(path: string, load: boolean): Gtk.TreeIter | null {
        if (!this.root || !path.startsWith(`${this.root}/`)) return null;
        const parts = path.slice(this.root.length + 1).split('/');
        let parent: Gtk.TreeIter | null = null;
        let current = this.root;
        for (let i = 0; i < parts.length; i++) {
            current = GLib.build_filenamev([current, parts[i]]);
            const iter = this.findChild(parent, current);
            if (!iter) return null;
            if (i === parts.length - 1) return iter;
            if (!this.get(iter, Col.Loaded)) {
                if (!load) return null;
                this.loadChildren(iter);
            }
            if (load) {
                const treePath = this.store.get_path(iter);
                if (treePath) this.view.expand_row(treePath, false);
            }
            parent = iter;
        }
        return null;
    }

    private activate(treePath: Gtk.TreePath): void {
        const [ok, iter] = this.store.get_iter(treePath);
        if (!ok) return;
        if (this.get(iter, Col.IsDir)) {
            if (this.view.row_expanded(treePath)) this.view.collapse_row(treePath);
            else this.view.expand_row(treePath, false);
        } else {
            this.onOpenFile(this.get(iter, Col.Path));
        }
    }

    // ---------- Pemantauan disk ----------

    private watch(dirPath: string): void {
        if (this.monitors.has(dirPath)) return;
        try {
            const monitor = Gio.File.new_for_path(dirPath).monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            monitor.connect('changed', () => this.scheduleRefresh(dirPath));
            this.monitors.set(dirPath, monitor);
        } catch {
            // Tidak bisa dipantau (misalnya sistem file jaringan); pohon tetap bisa dipakai.
        }
    }

    // Berhenti memantau folder yang dihapus beserta semua subfoldernya.
    private unwatchTree(dirPath: string): void {
        for (const [path, monitor] of this.monitors) {
            if (path === dirPath || path.startsWith(`${dirPath}/`)) {
                monitor.cancel();
                this.monitors.delete(path);
            }
        }
    }

    private scheduleRefresh(dirPath: string): void {
        const pending = this.pendingRefresh.get(dirPath);
        if (pending) GLib.source_remove(pending);
        this.pendingRefresh.set(dirPath, GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_DELAY, () => {
            this.pendingRefresh.delete(dirPath);
            this.refresh(dirPath);
            return GLib.SOURCE_REMOVE;
        }));
    }
}
