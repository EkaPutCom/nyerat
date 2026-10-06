// Tab Riwayat di sidebar: commit git yang menyentuh file aktif, terbaru dulu.
// Klik commit untuk melihat perubahan dan isinya (ui/historyviewer.ts, dibuka jendela).

import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import { commitFiles, fileLog, repoChanges, workingState, type GitFailure } from '../git.js';
import { relativeTime, type ChangeKind, type Commit, type FileChange } from '../gitlog.js';
import { pack, removeChildren } from '../gtkutil.js';

// Commit yang dimuat per permintaan; riwayat panjang dimuat bertahap.
const PAGE_SIZE = 100;

const FAILURE_TEXT: Record<GitFailure, string> = {
    'no-git': 'git tidak terpasang',
    'no-repo': 'Berkas ini tidak berada di repositori git',
    'failed': 'Riwayat tidak dapat dibaca',
};

const KIND_MARK: Record<ChangeKind, string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U' };

// Satu baris daftar commit. Datanya field biasa; tampilan dibaca ListView saat baris di-bind.
class CommitItem extends GObject.Object {
    static { GObject.registerClass({ GTypeName: 'NyeratCommitItem' }, this); }
    commit!: Commit;
    now = 0;
}

export class History {
    readonly store = new Gio.ListStore({ item_type: CommitItem.$gtype });
    readonly list: Gtk.ListView;
    readonly widget: Gtk.Box;
    readonly more: Gtk.Button;
    readonly changes: Gtk.Button;              // baris "belum di-commit", tampil hanya jika file berubah
    onOpen: (commit: Commit) => void = () => {};   // commit diklik
    onOpenChanges: (file: string) => void = () => {};   // perubahan belum di-commit diklik (file aktif atau file dari daftar)
    readonly changedList: Gtk.ListBox;         // semua file di repositori yang belum di-commit
    readonly changedBox: Gtk.Expander;
    private changed: FileChange[] = [];
    private readonly unchecked = new Set<string>();   // file daftar yang tidak ikut di-commit; sisanya dicentang
    private readonly checks = new Map<string, Gtk.CheckButton>();
    readonly commitBar: Gtk.Box;
    readonly messageEntry: Gtk.Entry;
    readonly commitButton: Gtk.Button;
    readonly commitStatus: Gtk.Label;
    beforeCommit: () => boolean = () => true;      // simpan dokumen dulu; false = batalkan commit
    onCommitted: () => void = () => {};

    private folder: string | null = null;     // folder yang dibuka; sumber daftar perubahan saat belum ada file
    private file: string | null | undefined;   // undefined = belum pernah dimuat
    private commits: Commit[] = [];
    private token = 0;                         // hasil git yang basi (file sudah berganti) diabaikan
    readonly note: Gtk.Label;                  // pesan saat daftar kosong

    constructor() {
        this.list = new Gtk.ListView({ model: new Gtk.NoSelection({ model: this.store }), factory: this.createFactory(), single_click_activate: true });
        this.list.add_css_class('navigation-sidebar');
        this.list.connect('activate', (_list, position) => {
            const commit = this.commits[position];
            if (commit) this.onOpen(commit);
        });
        // Daftar kosong: pesan (memuat, bukan repositori, belum ada commit) menggantikan daftar.
        this.note = new Gtk.Label({ margin_top: 16, margin_bottom: 16, margin_start: 16, margin_end: 16, wrap: true, xalign: 0, max_width_chars: 24, valign: Gtk.Align.START });
        this.note.add_css_class('dim-label');

        // Judul mengembang di dalam header saja; sidebar tidak ikut mengembang karena lebarnya
        // diatur width_request dan Box utama memberi sisa ruang ke kolom editor yang hexpand.
        const title = new Gtk.Label({ label: 'RIWAYAT', xalign: 0, margin_start: 16 });
        title.add_css_class('side-title');
        const refresh = Gtk.Button.new_from_icon_name('view-refresh-symbolic');
        refresh.set_has_frame(false);
        refresh.set_tooltip_text('Muat ulang riwayat');
        refresh.connect('clicked', () => this.refresh());
        const header = new Gtk.Box({ margin_top: 4, margin_bottom: 8, margin_end: 6 });
        pack(header, title, true);
        header.append(refresh);

        this.changes = new Gtk.Button({ visible: false, margin_start: 8, margin_end: 8, margin_bottom: 8 });
        this.changes.set_has_frame(false);
        this.changes.set_tooltip_text('Lihat perubahan terhadap commit terakhir');
        this.changes.connect('clicked', () => { if (this.file) this.onOpenChanges(this.file); });

        this.changedList = new Gtk.ListBox({ activate_on_single_click: true });
        this.changedList.set_selection_mode(Gtk.SelectionMode.NONE);
        this.changedList.connect('row-activated', (_list, row) => {
            const change = this.changed[row.get_index()];
            if (change) this.onOpenChanges(change.path);
        });
        const changedScroll = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER, propagate_natural_height: true, max_content_height: 240,
        });
        changedScroll.set_child(this.changedList);
        this.messageEntry = new Gtk.Entry({ placeholder_text: 'Pesan commit' });
        this.commitButton = new Gtk.Button({ label: 'Commit' });
        this.commitButton.add_css_class('suggested-action');
        this.commitStatus = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 24, visible: false });
        this.commitStatus.add_css_class('dim-label');
        this.commitButton.connect('clicked', () => this.commitSelected());
        this.messageEntry.connect('activate', () => this.commitSelected());
        this.commitBar = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, margin_top: 8 });
        this.commitBar.append(this.messageEntry);
        this.commitBar.append(this.commitButton);
        this.commitBar.append(this.commitStatus);
        const changedContent = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        changedContent.append(changedScroll);
        changedContent.append(this.commitBar);
        this.changedBox = new Gtk.Expander({ expanded: true, visible: false, margin_start: 8, margin_end: 8, margin_bottom: 8 });
        this.changedBox.set_child(changedContent);

        const scroll = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true, child: this.list });
        const pages = new Gtk.Stack({ vexpand: true });
        pages.add_named(scroll, 'list');
        pages.add_named(this.note, 'note');
        pages.visible_child_name = 'note';
        this.store.connect('items-changed', () => { pages.visible_child_name = this.store.n_items ? 'list' : 'note'; });
        this.more = new Gtk.Button({ label: 'Muat lebih banyak', margin_top: 8, margin_bottom: 8, margin_start: 8, margin_end: 8, visible: false });
        this.more.connect('clicked', () => this.load(this.commits.length, false));

        // hexpand false: judul di header mengembang, dan GTK 4 meneruskannya ke atas sampai sidebar.
        this.widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: false });
        this.widget.append(header);
        this.widget.append(this.changes);
        this.widget.append(this.changedBox);
        pack(this.widget, pages, true);
        this.widget.append(this.more);
    }

    // Tampilkan riwayat file ini. Memanggil lagi dengan file yang sama tidak melakukan apa-apa
    // kecuali force, jadi aman dipanggil sering.
    setFile(file: string | null, force = false, folder: string | null = this.folder): void {
        if (!force && file === this.file && folder === this.folder) return;
        const same = file === this.file;
        this.file = file;
        this.folder = folder;
        this.token++;
        // Muat ulang file yang sama tidak mengosongkan daftar dulu; daftar hanya diganti jika isinya berubah.
        if (!same) this.clear();
        this.changes.set_visible(false);
        if (!same) this.setChanged([]);
        if (!file) {
            this.note.set_text('Simpan dokumen ke berkas, lalu riwayat git-nya tampil di sini');
            this.loadChanges();
            return;
        }
        if (!same) this.note.set_text('Memuat…');
        this.load(0, same);
        this.loadChanges();
    }

    refresh(): void {
        if (this.file !== undefined) this.setFile(this.file, true);
    }

    // Jendela ditutup: hasil git yang masih ditunggu diabaikan.
    destroy(): void {
        this.token++;
    }

    // Tombol perubahan hanya tampil jika isi file berbeda dari commit terakhir.
    private async loadChanges(): Promise<void> {
        const token = this.token, file = this.file;
        const dir = file ? GLib.path_get_dirname(file) : this.folder;
        if (!dir) return this.setChanged([]);
        const [state, repo] = await Promise.all([file ? workingState(file) : null, repoChanges(dir)]);
        if (token !== this.token) return;
        this.setChanged(repo.ok ? repo.changes : []);
        if (!state || !state.ok || state.state === 'clean') return this.changes.set_visible(false);
        this.changes.set_label(state.state === 'untracked' ? '● File baru, belum di-commit' : '● Perubahan belum di-commit');
        this.changes.set_visible(true);
    }

    // Daftar file berubah; tidak dibangun ulang jika sama, supaya posisi gulir tidak lompat saat muat ulang.
    private setChanged(changes: FileChange[]): void {
        const same = changes.length === this.changed.length
            && changes.every((c, i) => c.path === this.changed[i].path && c.kind === this.changed[i].kind);
        if (same) return;
        this.changed = changes;
        this.checks.clear();
        removeChildren(this.changedList);
        for (const path of [...this.unchecked]) if (!changes.some(c => c.path === path)) this.unchecked.delete(path);
        const dir = this.file ? GLib.path_get_dirname(this.file) : this.folder ?? '';
        for (const change of changes) {
            const rel = dir && change.path.startsWith(dir + '/') ? change.path.slice(dir.length + 1) : change.path;
            const check = new Gtk.CheckButton({ active: !this.unchecked.has(change.path) });
            check.set_tooltip_text('Ikut di-commit');
            check.connect('toggled', () => {
                if (check.active) this.unchecked.delete(change.path); else this.unchecked.add(change.path);
                this.updateCommitButton();
            });
            this.checks.set(change.path, check);
            const mark = new Gtk.Label({ label: KIND_MARK[change.kind], xalign: 0, width_chars: 1 });
            mark.add_css_class('side-meta');
            const name = new Gtk.Label({ label: rel, xalign: 0, ellipsize: Pango.EllipsizeMode.START });
            const box = new Gtk.Box({ spacing: 8, margin_start: 4, margin_end: 4, margin_top: 0, margin_bottom: 0 });
            box.append(check);
            box.append(mark);
            pack(box, name, true);
            const row = new Gtk.ListBoxRow({ child: box, tooltip_text: change.path });
            this.changedList.insert(row, -1);
        }
        this.changedBox.set_label(`Belum di-commit (${changes.length})`);
        this.updateCommitButton();
        this.changedBox.set_visible(changes.length > 0);
    }

    // File yang dicentang; urutannya mengikuti daftar.
    private selected(): string[] {
        return this.changed.filter(c => !this.unchecked.has(c.path)).map(c => c.path);
    }

    private updateCommitButton(): void {
        const n = this.selected().length;
        this.commitButton.set_label(n ? `Commit ${n} file` : 'Commit');
        this.commitButton.set_sensitive(n > 0);
    }

    private showCommitStatus(text: string): void {
        this.commitStatus.set_text(text);
        this.commitStatus.set_visible(true);
    }

    private async commitSelected(): Promise<void> {
        const files = this.selected();
        const message = this.messageEntry.get_text().trim();
        if (!files.length) return this.showCommitStatus('Pilih file yang akan di-commit');
        if (!message) return this.showCommitStatus('Isi pesan commit dulu');
        if (!this.beforeCommit()) return this.showCommitStatus('Dokumen gagal disimpan; commit dibatalkan');
        this.commitButton.set_sensitive(false);
        const result = await commitFiles(files, message);
        this.updateCommitButton();
        if (!result.ok) return this.showCommitStatus(`Commit gagal: ${result.message}`);
        this.messageEntry.set_text('');
        this.commitStatus.set_visible(false);
        this.onCommitted();
    }

    private clear(): void {
        this.commits = [];
        this.more.set_visible(false);
        this.store.remove_all();
    }

    private async load(skip: number, keep: boolean): Promise<void> {
        const token = this.token, file = this.file;
        if (!file) return;
        const result = await fileLog(file, skip, PAGE_SIZE);
        if (token !== this.token) return;
        if (!result.ok) {
            this.clear();
            this.note.set_text(FAILURE_TEXT[result.reason]);
            return;
        }
        if (skip === 0) {
            // Muat ulang yang hasilnya sama dengan yang tampil: biarkan daftar (dan posisi gulirnya).
            const shown = this.commits.slice(0, result.commits.length);
            if (keep && shown.length === result.commits.length && shown.every((c, i) => c.hash === result.commits[i].hash)) return;
            this.clear();
            this.note.set_text('Belum ada commit untuk berkas ini');
        }
        const now = Math.floor(Date.now() / 1000);
        this.commits.push(...result.commits);
        this.store.splice(this.store.n_items, 0, result.commits.map(commit => Object.assign(new CommitItem(), { commit, now })));
        this.more.set_visible(result.commits.length === PAGE_SIZE);
    }

    private createFactory(): Gtk.SignalListItemFactory {
        const factory = new Gtk.SignalListItemFactory();
        factory.connect('setup', (_f, item) => {
            const subject = new Gtk.Label({ xalign: 0, ellipsize: Pango.EllipsizeMode.END });
            const meta = new Gtk.Label({ xalign: 0, ellipsize: Pango.EllipsizeMode.END });
            meta.add_css_class('side-meta');
            const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, margin_start: 16, margin_end: 12 });
            box.append(subject);
            box.append(meta);
            (item as Gtk.ListItem).child = box;
        });
        factory.connect('bind', (_f, item) => {
            const listItem = item as Gtk.ListItem;
            const { commit, now } = listItem.item as CommitItem;
            const box = listItem.child as Gtk.Box;
            (box.get_first_child() as Gtk.Label).label = commit.subject || '(tanpa pesan)';
            (box.get_last_child() as Gtk.Label).label = `${commit.short} · ${commit.author} · ${relativeTime(commit.time, now)}`;
            box.set_tooltip_text(`${commit.subject}\n${commit.author}\n${GLib.DateTime.new_from_unix_local(commit.time).format('%d %b %Y %H:%M')}`);
        });
        return factory;
    }
}
