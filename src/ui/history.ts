// Tab Riwayat di sidebar: commit git yang menyentuh file aktif, terbaru dulu.
// Klik commit untuk melihat perubahan dan isinya (ui/historyviewer.ts, dibuka jendela).

import Gtk from 'gi://Gtk?version=3.0';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import { commitFiles, fileLog, repoChanges, workingState, type GitFailure } from '../git.js';
import { relativeTime, type ChangeKind, type Commit, type FileChange } from '../gitlog.js';

// Commit yang dimuat per permintaan; riwayat panjang dimuat bertahap.
const PAGE_SIZE = 100;

const FAILURE_TEXT: Record<GitFailure, string> = {
    'no-git': 'git tidak terpasang',
    'no-repo': 'Berkas ini tidak berada di repositori git',
    'failed': 'Riwayat tidak dapat dibaca',
};

const KIND_MARK: Record<ChangeKind, string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U' };

export class History {
    readonly list: Gtk.ListBox;
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
        this.list = new Gtk.ListBox({ activate_on_single_click: true });
        this.list.set_selection_mode(Gtk.SelectionMode.NONE);
        this.list.connect('row-activated', (_list, row) => {
            const commit = this.commits[row.get_index()];
            if (commit) this.onOpen(commit);
        });
        this.note = new Gtk.Label({ margin: 16, wrap: true, xalign: 0, max_width_chars: 24 });
        this.note.get_style_context().add_class('dim-label');
        this.note.show();
        this.list.set_placeholder(this.note);

        // Tanpa hexpand: GTK3 menghitung ekspansi dari semua keturunan, dan sidebar yang "mengembang" membuat
        // Box utama membagi ruang sisa kepadanya (sidebar terpusat di slot yang lebar). Perataan cukup lewat pack_start.
        const title = new Gtk.Label({ label: 'RIWAYAT', xalign: 0, margin_start: 16 });
        title.get_style_context().add_class('side-title');
        const refresh = Gtk.Button.new_from_icon_name('view-refresh-symbolic', Gtk.IconSize.MENU);
        refresh.set_relief(Gtk.ReliefStyle.NONE);
        refresh.set_tooltip_text('Muat ulang riwayat');
        refresh.connect('clicked', () => this.refresh());
        const header = new Gtk.Box({ margin_top: 4, margin_bottom: 8, margin_end: 6 });
        header.pack_start(title, true, true, 0);
        header.pack_start(refresh, false, false, 0);

        this.changes = new Gtk.Button({ no_show_all: true, margin_start: 8, margin_end: 8, margin_bottom: 8 });
        this.changes.set_relief(Gtk.ReliefStyle.NONE);
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
        changedScroll.add(this.changedList);
        this.messageEntry = new Gtk.Entry({ placeholder_text: 'Pesan commit' });
        this.commitButton = new Gtk.Button({ label: 'Commit' });
        this.commitButton.get_style_context().add_class('suggested-action');
        this.commitStatus = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 24, no_show_all: true });
        this.commitStatus.get_style_context().add_class('dim-label');
        this.commitButton.connect('clicked', () => this.commitSelected());
        this.messageEntry.connect('activate', () => this.commitSelected());
        this.commitBar = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, margin_top: 8 });
        this.commitBar.pack_start(this.messageEntry, false, false, 0);
        this.commitBar.pack_start(this.commitButton, false, false, 0);
        this.commitBar.pack_start(this.commitStatus, false, false, 0);
        const changedContent = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        changedContent.pack_start(changedScroll, false, false, 0);
        changedContent.pack_start(this.commitBar, false, false, 0);
        this.changedBox = new Gtk.Expander({ expanded: true, no_show_all: true, margin_start: 8, margin_end: 8, margin_bottom: 8 });
        this.changedBox.add(changedContent);

        const scroll = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true });
        scroll.add(this.list);
        this.more = new Gtk.Button({ label: 'Muat lebih banyak', margin: 8, no_show_all: true });
        this.more.connect('clicked', () => this.load(this.commits.length, false));

        this.widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        this.widget.pack_start(header, false, false, 0);
        this.widget.pack_start(this.changes, false, false, 0);
        this.widget.pack_start(this.changedBox, false, false, 0);
        this.widget.pack_start(scroll, true, true, 0);
        this.widget.pack_start(this.more, false, false, 0);
        this.widget.show_all();
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
        this.changes.hide();
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

    // Tombol perubahan hanya tampil jika isi file berbeda dari commit terakhir.
    private async loadChanges(): Promise<void> {
        const token = this.token, file = this.file;
        const dir = file ? GLib.path_get_dirname(file) : this.folder;
        if (!dir) return this.setChanged([]);
        const [state, repo] = await Promise.all([file ? workingState(file) : null, repoChanges(dir)]);
        if (token !== this.token) return;
        this.setChanged(repo.ok ? repo.changes : []);
        if (!state || !state.ok || state.state === 'clean') return this.changes.hide();
        this.changes.set_label(state.state === 'untracked' ? '● File baru, belum di-commit' : '● Perubahan belum di-commit');
        this.changes.show();
    }

    // Daftar file berubah; tidak dibangun ulang jika sama, supaya posisi gulir tidak lompat saat muat ulang.
    private setChanged(changes: FileChange[]): void {
        const same = changes.length === this.changed.length
            && changes.every((c, i) => c.path === this.changed[i].path && c.kind === this.changed[i].kind);
        if (same) return;
        this.changed = changes;
        this.checks.clear();
        for (const row of this.changedList.get_children()) row.destroy();
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
            mark.get_style_context().add_class('side-meta');
            const name = new Gtk.Label({ label: rel, xalign: 0, ellipsize: Pango.EllipsizeMode.START });
            const box = new Gtk.Box({ spacing: 8, margin_start: 4, margin_end: 4, margin_top: 0, margin_bottom: 0 });
            box.pack_start(check, false, false, 0);
            box.pack_start(mark, false, false, 0);
            box.pack_start(name, true, true, 0);
            const row = new Gtk.ListBoxRow();
            row.add(box);
            row.set_tooltip_text(change.path);
            row.show_all();
            this.changedList.insert(row, -1);
        }
        this.changedBox.set_label(`Belum di-commit (${changes.length})`);
        this.updateCommitButton();
        if (changes.length) {
            this.changedBox.show();
            this.changedBox.get_child()?.show_all();   // show_all pada widget no_show_all diabaikan, dan anaknya belum pernah ditampilkan
        } else this.changedBox.hide();
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
        this.commitStatus.show();
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
        this.commitStatus.hide();
        this.onCommitted();
    }

    private clear(): void {
        this.commits = [];
        this.more.hide();
        for (const row of this.list.get_children()) row.destroy();
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
        for (const commit of result.commits) {
            this.commits.push(commit);
            this.list.insert(this.createRow(commit, now), -1);
        }
        this.more.set_visible(result.commits.length === PAGE_SIZE);
    }

    private createRow(commit: Commit, now: number): Gtk.ListBoxRow {
        const subject = new Gtk.Label({
            label: commit.subject || '(tanpa pesan)', xalign: 0, ellipsize: Pango.EllipsizeMode.END,
        });
        const meta = new Gtk.Label({
            label: `${commit.short} · ${commit.author} · ${relativeTime(commit.time, now)}`,
            xalign: 0, ellipsize: Pango.EllipsizeMode.END,
        });
        meta.get_style_context().add_class('side-meta');
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, margin_start: 16, margin_end: 12 });
        box.pack_start(subject, false, false, 0);
        box.pack_start(meta, false, false, 0);
        const row = new Gtk.ListBoxRow();
        row.add(box);
        row.set_tooltip_text(`${commit.subject}\n${commit.author}\n${GLib.DateTime.new_from_unix_local(commit.time).format('%d %b %Y %H:%M')}`);
        row.show_all();
        return row;
    }
}
