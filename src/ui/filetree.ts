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
import { newBoard, serializeBoard } from '../markdown/kanban.js';
import { confirmDialog, promptDialog, showError } from './dialogs.js';
import { onClick, pack } from '../gtkutil.js';
import { popupMenu, separator, type MenuEntry } from './menu.js';

export const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd'];
const SKIPPED_FOLDERS = new Set(['node_modules']);
const EXPAND_DELAY = 600;   // ms; folder tertutup dibuka otomatis bila ditahan saat drag
const NO_ACTION = 0 as Gdk.DragAction;
const REFRESH_DELAY = 150;  // ms; perubahan beruntun di disk digabung jadi satu refresh

// Satu file atau folder di pohon.
class FileNode extends GObject.Object {
    static { GObject.registerClass({ GTypeName: 'NyeratFileNode' }, this); }
    name = '';
    path = '';
    isDir = false;
}

const nodeOf = (entry: FolderEntry): FileNode => Object.assign(new FileNode(), entry);

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
    readonly list: Gtk.ListView;
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

    private readonly rootStore = new Gio.ListStore({ item_type: FileNode.$gtype });
    private readonly dirStores = new Map<string, Gio.ListStore>();   // path folder yang sudah dibaca → isinya
    private readonly tree: Gtk.TreeListModel;
    private readonly selection: Gtk.SingleSelection;
    private readonly title: Gtk.Label;
    private readonly pages: Gtk.Stack;
    private monitors = new Map<string, Gio.FileMonitor>();  // path folder → pemantau
    private pendingRefresh = new Map<string, number>();     // path folder → id timeout
    private dragSource: string | null = null;               // path yang sedang di-drag
    private expandTimer = 0;
    private revealed: string | null = null;                 // file yang terakhir disorot reveal()

    constructor() {
        this.tree = Gtk.TreeListModel.new(this.rootStore, false, false, item => this.childrenOf(item as FileNode));
        this.selection = new Gtk.SingleSelection({ model: this.tree, autoselect: false, can_unselect: true });
        this.selection.selected = Gtk.INVALID_LIST_POSITION;
        this.list = new Gtk.ListView({ model: this.selection, factory: this.createFactory(), single_click_activate: true });
        this.list.add_css_class('navigation-sidebar');
        onClick(this.list, (_n, x, y) => this.showContextMenu(x, y), 3);
        this.setupDrag();
        this.list.connect('activate', (_list, position) => this.activatePosition(position));

        const scroll = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true, child: this.list });

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

    private createFactory(): Gtk.SignalListItemFactory {
        const factory = new Gtk.SignalListItemFactory();
        factory.connect('setup', (_f, item) => {
            const box = new Gtk.Box({ spacing: 6 });
            box.append(new Gtk.Image());
            box.append(new Gtk.Label({ xalign: 0, ellipsize: Pango.EllipsizeMode.END }));
            (item as Gtk.ListItem).child = new Gtk.TreeExpander({ child: box });
        });
        factory.connect('bind', (_f, item) => {
            const listItem = item as Gtk.ListItem;
            const row = listItem.item as Gtk.TreeListRow;
            const node = row.get_item() as FileNode;
            const expander = listItem.child as Gtk.TreeExpander;
            expander.set_list_row(row);
            const box = expander.get_child() as Gtk.Box;
            (box.get_first_child() as Gtk.Image).icon_name = node.isDir ? 'folder-symbolic' : 'text-x-generic-symbolic';
            (box.get_last_child() as Gtk.Label).label = node.name;
        });
        return factory;
    }

    // Anak sebuah folder untuk TreeListModel; null = bukan folder. Dipanggil juga hanya untuk
    // memeriksa apakah baris bisa dibuka, jadi hasilnya disimpan dan isinya dibaca sekali.
    private childrenOf(node: FileNode): Gio.ListModel | null {
        if (!node.isDir) return null;
        let store = this.dirStores.get(node.path);
        if (!store) {
            store = new Gio.ListStore({ item_type: FileNode.$gtype });
            store.splice(0, 0, listFolder(node.path).map(nodeOf));
            this.dirStores.set(node.path, store);
            this.watch(node.path);
        }
        return store;
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
        this.dirStores.clear();
        this.rootStore.remove_all();
        this.root = path;

        if (!path) {
            this.title.label = 'BERKAS';
            this.title.tooltip_text = null;
            this.pages.visible_child_name = 'empty';
            return;
        }
        this.title.label = GLib.path_get_basename(path).toUpperCase();
        this.title.tooltip_text = path;
        this.dirStores.set(path, this.rootStore);
        this.rootStore.splice(0, 0, listFolder(path).map(nodeOf));
        this.watch(path);
        this.pages.visible_child_name = 'tree';
    }

    // ---------- Posisi dan baris ----------

    private rowAt(position: number): Gtk.TreeListRow | null {
        return position >= 0 && position < this.tree.get_n_items() ? this.tree.get_row(position) : null;
    }

    private nodeAt(position: number): FileNode | null {
        return (this.rowAt(position)?.get_item() as FileNode | null) ?? null;
    }

    // Posisi baris yang sedang tampil untuk path; -1 jika tidak ada (atau induknya tertutup).
    private positionOf(path: string): number {
        for (let i = 0, n = this.tree.get_n_items(); i < n; i++) if (this.nodeAt(i)?.path === path) return i;
        return -1;
    }

    private select(position: number): void {
        this.selection.selected = position < 0 ? Gtk.INVALID_LIST_POSITION : position;
    }

    // Posisi baris di titik (x, y) koordinat ListView; -1 = area kosong.
    private positionAtPoint(x: number, y: number): number {
        let widget = this.list.pick(x, y, Gtk.PickFlags.DEFAULT);
        // Baris ListView adalah anak langsung ListView; isinya TreeExpander yang tahu barisnya.
        while (widget && widget.get_parent() !== this.list) widget = widget.get_parent();
        const expander = widget?.get_first_child();
        return expander instanceof Gtk.TreeExpander ? expander.get_list_row()?.get_position() ?? -1 : -1;
    }

    private pathAtPoint(x: number, y: number): string | null {
        return this.nodeAt(this.positionAtPoint(x, y))?.path ?? null;
    }

    // Sorot file di pohon, membuka folder-folder induknya bila perlu.
    // false jika file tidak berada di dalam folder yang dibuka.
    reveal(filePath: string | null): boolean {
        this.revealed = filePath;
        const position = filePath ? this.expandTo(filePath) : -1;
        if (position < 0) {
            this.select(-1);
            return false;
        }
        this.select(position);
        this.list.scroll_to(position, Gtk.ListScrollFlags.NONE, null);
        return true;
    }

    // Buka semua folder di atas path dan kembalikan posisinya; -1 jika tidak ada.
    private expandTo(path: string): number {
        if (!this.root || !path.startsWith(`${this.root}/`)) return -1;
        const parts = path.slice(this.root.length + 1).split('/');
        let current = this.root;
        for (const part of parts.slice(0, -1)) {
            current = GLib.build_filenamev([current, part]);
            const row = this.rowAt(this.positionOf(current));
            if (!row) return -1;
            if (!row.expanded) row.expanded = true;
        }
        return this.positionOf(path);
    }

    // Baca ulang satu folder dari disk dan samakan itemnya.
    refresh(dirPath: string): void {
        const store = this.dirStores.get(dirPath);
        if (!store) return;   // belum pernah dibaca; dibaca baru saat dibutuhkan
        const entries = listFolder(dirPath);
        const wanted = new Set(entries.map(e => e.path));

        // 1. Hapus item yang sudah tidak ada di disk.
        for (let i = store.n_items - 1; i >= 0; i--) {
            const node = store.get_item(i) as FileNode;
            if (wanted.has(node.path)) continue;
            store.remove(i);
            this.forget(node.path);
        }

        // 2. Sisipkan item baru di posisi urutnya. Isi store sekarang adalah
        //    subset terurut dari entries, jadi cukup berjalan bersamaan.
        let at = 0;
        for (const entry of entries) {
            if (at < store.n_items && (store.get_item(at) as FileNode).path === entry.path) at++;
            else store.insert(at++, nodeOf(entry));
        }
    }

    // Lupakan folder yang dihapus beserta seluruh isinya: pemantau dan isi yang tersimpan.
    private forget(dirPath: string): void {
        for (const path of [...this.monitors.keys()]) {
            if (path === dirPath || path.startsWith(`${dirPath}/`)) {
                this.monitors.get(path)!.cancel();
                this.monitors.delete(path);
            }
        }
        for (const path of [...this.dirStores.keys()]) if (path === dirPath || path.startsWith(`${dirPath}/`)) this.dirStores.delete(path);
    }

    // ---------- Untuk tes ----------

    // Nama anak langsung sebuah folder yang sudah dibaca (kosong jika belum dibaca).
    childNames(dir: string): string[] {
        const store = this.dirStores.get(dir);
        const names: string[] = [];
        for (let i = 0; store && i < store.n_items; i++) names.push((store.get_item(i) as FileNode).name);
        return names;
    }

    isExpanded(path: string): boolean {
        return this.rowAt(this.positionOf(path))?.expanded ?? false;
    }

    expand(path: string, expanded = true): void {
        const row = this.rowAt(this.positionOf(path));
        if (row) row.expanded = expanded;
    }

    get selectedPath(): string | null {
        return this.nodeAt(this.selection.selected)?.path ?? null;
    }

    // Seolah baris diklik: file dibuka, folder dibuka/ditutup.
    activate(path: string): void {
        this.activatePosition(this.positionOf(path));
    }

    // Titik di tengah baris `path` dalam koordinat ListView; null jika barisnya tampil.
    // Dicari dengan memindai ke bawah, karena tinggi baris tidak diketahui sebelum digambar.
    rowPoint(path: string): [number, number] | null {
        const position = this.positionOf(path);
        let first = -1, last = -1;
        for (let y = 1; position >= 0 && y < this.list.get_height(); y += 2) {
            if (this.positionAtPoint(60, y) !== position) {
                if (first >= 0) break;
                continue;
            }
            if (first < 0) first = y;
            last = y;
        }
        return first < 0 ? null : [60, (first + last) / 2];
    }

    // ---------- Buat file/folder ----------

    private parentWindow(): Gtk.Window | null {
        const top = this.widget.get_root();
        return top instanceof Gtk.Window ? top : null;
    }

    // Folder tempat item baru dibuat untuk baris yang diklik kanan: folder itu sendiri,
    // atau folder induk file; null (area kosong) = root.
    private targetDir(path: string | null): string | null {
        if (path) return isDirectory(path) ? path : GLib.path_get_dirname(path);
        return this.root;
    }

    // Tanya nama lalu buat file/folder di dir. File baru langsung dibuka di editor.
    // `board`: file berisi papan kanban kosong, langsung tampil sebagai papan saat dibuka.
    create(kind: 'file' | 'folder' | 'board', dir: string): string | null {
        const title = kind === 'file' ? 'File Baru' : kind === 'board' ? 'Papan Kanban Baru' : 'Folder Baru';
        const name = this.dialogs.prompt(title, kind === 'folder' ? 'Nama folder' : 'Nama file');
        if (name === null) return null;
        let path: string;
        try {
            path = kind === 'folder' ? createFolder(dir, name)
                : createFile(dir, name, kind === 'board' ? serializeBoard(newBoard()) : '');
        } catch (e) {
            this.dialogs.error((e as Error).message);
            return null;
        }
        this.refresh(dir);
        this.reveal(path);
        if (kind !== 'folder') this.onOpenFile(path);
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
    contextMenu(rowPath: string | null): MenuEntry[] {
        const dir = this.targetDir(rowPath);
        const entries: MenuEntry[] = [
            { label: 'File Baru…', enabled: dir !== null, run: () => { if (dir) this.create('file', dir); } },
            { label: 'Folder Baru…', enabled: dir !== null, run: () => { if (dir) this.create('folder', dir); } },
            { label: 'Papan Kanban Baru…', enabled: dir !== null, run: () => { if (dir) this.create('board', dir); } },
        ];
        if (rowPath) {
            entries.push(separator());
            entries.push({ label: 'Ganti Nama…', enabled: true, run: () => this.rename(rowPath) });
            entries.push({ label: 'Hapus', enabled: true, run: () => this.remove(rowPath) });
        }
        return entries;
    }

    // Klik kanan di (x, y), koordinat ListView.
    private showContextMenu(x: number, y: number): boolean {
        if (!this.root) return false;
        const position = this.positionAtPoint(x, y);
        this.select(position);
        this.popupContextMenu(this.nodeAt(position)?.path ?? null, x, y);
        return true;
    }

    // Menu konteks di (x, y) koordinat ListView. Popover dipasang di kotak luar, bukan di ListView,
    // supaya tidak ikut tergulir atau terpotong bersama daftarnya.
    popupContextMenu(rowPath: string | null, x: number, y: number): Gtk.PopoverMenu {
        const [, px, py] = this.list.translate_coordinates(this.widget, x, y);
        return popupMenu(this.widget, this.contextMenu(rowPath), px, py);
    }

    // ---------- Pindah lewat drag and drop ----------

    private setupDrag(): void {
        const source = new Gtk.DragSource({ actions: Gdk.DragAction.MOVE });
        source.connect('prepare', (_s, x, y) => {
            this.dragSource = this.pathAtPoint(x, y);
            if (!this.dragSource) return null;
            // Ikon drag: ikon jenis berkasnya. Widget sebagai ikon (GtkDragIcon) memicu
            // Gtk-CRITICAL saat drag selesai di GTK 4.14.
            const icon = Gtk.IconTheme.get_for_display(this.list.get_display()).lookup_icon(
                isDirectory(this.dragSource) ? 'folder-symbolic' : 'text-x-generic-symbolic', null, 32,
                this.list.get_scale_factor(), Gtk.TextDirection.NONE, 0 as Gtk.IconLookupFlags);
            source.set_icon(icon, 0, 0);
            return Gdk.ContentProvider.new_for_value(this.dragSource);
        });
        source.connect('drag-end', () => { this.dragSource = null; });
        this.list.add_controller(source);

        const target = new Gtk.DropTarget({ actions: Gdk.DragAction.MOVE });
        target.set_gtypes([GObject.TYPE_STRING]);
        target.connect('motion', (_t, x, y) => {
            const dir = this.dropDirAt(x, y);
            const valid = this.canMoveTo(dir);
            this.highlightDrop(valid ? this.positionAtPoint(x, y) : -1);
            this.scheduleExpand(x, y);
            return valid ? Gdk.DragAction.MOVE : NO_ACTION;
        });
        target.connect('leave', () => {
            this.highlightDrop(-1);
            this.cancelExpand();
        });
        target.connect('drop', (_t, _value, x, y) => {
            this.cancelExpand();
            this.highlightDrop(-1);
            const dir = this.dropDirAt(x, y);
            return this.canMoveTo(dir) && this.moveTo(this.dragSource!, dir!);
        });
        this.list.add_controller(target);
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

    // Sorot baris tujuan dengan seleksi; -1 = kembalikan sorotan ke file yang terbuka.
    private highlightDrop(position: number): void {
        if (position >= 0) return this.select(position);
        this.select(this.revealed ? this.positionOf(this.revealed) : -1);
    }

    // Folder tujuan di posisi itu: folder yang ditunjuk, folder induk file yang ditunjuk, atau root.
    private dropDirAt(x: number, y: number): string | null {
        return this.targetDir(this.pathAtPoint(x, y));
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
        const row = this.rowAt(this.positionAtPoint(x, y));
        if (!row || row.expanded || !(row.get_item() as FileNode).isDir) return;
        this.expandTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, EXPAND_DELAY, () => {
            this.expandTimer = 0;
            row.expanded = true;
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
        if (dir !== this.root && this.dirStores.has(dir)) this.expand(dir);
        this.reveal(target);
        this.onMoved(source, target);
        return true;
    }

    private activatePosition(position: number): void {
        const row = this.rowAt(position);
        const node = row?.get_item() as FileNode | undefined;
        if (!row || !node) return;
        if (node.isDir) row.expanded = !row.expanded;
        else this.onOpenFile(node.path);
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
