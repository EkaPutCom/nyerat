// Tab Riwayat di sidebar: commit git yang menyentuh file aktif, terbaru dulu.
// Klik commit untuk melihat perubahan dan isinya (ui/historyviewer.ts, dibuka jendela).

import Gtk from 'gi://Gtk?version=3.0';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import { fileLog, type GitFailure } from '../git.js';
import { relativeTime, type Commit } from '../gitlog.js';

// Commit yang dimuat per permintaan; riwayat panjang dimuat bertahap.
const PAGE_SIZE = 100;

const FAILURE_TEXT: Record<GitFailure, string> = {
    'no-git': 'git tidak terpasang',
    'no-repo': 'Berkas ini tidak berada di repositori git',
    'failed': 'Riwayat tidak dapat dibaca',
};

export class History {
    readonly list: Gtk.ListBox;
    readonly widget: Gtk.Box;
    readonly more: Gtk.Button;
    onOpen: (commit: Commit) => void = () => {};   // commit diklik

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

        const scroll = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true });
        scroll.add(this.list);
        this.more = new Gtk.Button({ label: 'Muat lebih banyak', margin: 8, no_show_all: true });
        this.more.connect('clicked', () => this.load(this.commits.length, false));

        this.widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        this.widget.pack_start(header, false, false, 0);
        this.widget.pack_start(scroll, true, true, 0);
        this.widget.pack_start(this.more, false, false, 0);
        this.widget.show_all();
    }

    // Tampilkan riwayat file ini. Memanggil lagi dengan file yang sama tidak melakukan apa-apa
    // kecuali force, jadi aman dipanggil sering.
    setFile(file: string | null, force = false): void {
        if (!force && file === this.file) return;
        const same = file === this.file;
        this.file = file;
        this.token++;
        // Muat ulang file yang sama tidak mengosongkan daftar dulu; daftar hanya diganti jika isinya berubah.
        if (!same) this.clear();
        if (!file) {
            this.note.set_text('Simpan dokumen ke berkas, lalu riwayat git-nya tampil di sini');
            return;
        }
        if (!same) this.note.set_text('Memuat…');
        this.load(0, same);
    }

    refresh(): void {
        if (this.file !== undefined) this.setFile(this.file, true);
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
