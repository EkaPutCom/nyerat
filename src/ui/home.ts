// Halaman Beranda: tab khusus yang merangkum apa yang bisa dilanjutkan hari ini.
//
//   Selamat pagi, Eka
//   Rabu, 7 Oktober 2026
//
//   Lanjutkan           ┌ muara ─────┐ ┌ nyerat ────┐      satu kartu per folder
//                       │ arch.md    │ │ roadmap.md │
//                       └────────────┘ └────────────┘
//   Jurnal              ┌ Jurnal hari ini  2 catatan · 4 aktivitas  [+] ┐
//   Agent               ┌ pi · Perbaiki checkout   Menunggu jawabanmu ┐
//   Tenggat             ┌ ☐ Implement search   Nyerat · Hari ini     ┐
//   Inbox               ┌ inbox.md                 5 belum diproses   ┐
//   Berkas terbaru      ┌ journal/2026-10-06.md        2 jam lalu     ┐
//
// Komponen ini hanya menggambar data yang diberikan jendela (render) dan memberi kabar lewat callback;
// ia tidak membaca berkas sendiri. Bagian Agent dan Inbox hanya tampil bila ada isinya.

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import { dayPart, type DayPart, type InboxCount, type Task } from '../markdown/home.js';
import type { RunStatus } from '../agent/harness.js';
import { ageLabel } from './inbox.js';
import { removeChildren } from '../gtkutil.js';
import { _, fmt, ngettext } from '../i18n.js';

const MAX_WIDTH = 720;
// Kartu Lanjutkan sebaris penuh di jendela lebar; di jendela sempit FlowBox melipatnya.
export const RESUME_CARDS = 3;
// Beranda adalah ringkasan: tenggat selebihnya disembunyikan di balik satu baris (dan menggambar puluhan baris juga mahal).
const SHOWN_TASKS = 7;

// Satu berkas di kartu Lanjutkan atau di daftar Berkas terbaru.
export interface HomeEntry {
    path: string;
    title: string;      // kartu: nama folder; daftar: nama berkas
    subtitle: string;   // kartu: nama berkas; daftar: folder relatif
    time: number;       // detik Unix
}

export interface HomeRun {
    id: number;
    agent: string;
    title: string;
    status: RunStatus;
}

export interface HomeJournal {
    exists: boolean;    // berkas jurnal hari ini sudah ada
    notes: number;      // butir di bagian Catatan
    activity: number;   // aktivitas tercatat hari ini (log), termasuk yang belum masuk ke berkas
}

export interface HomeData {
    now: Date;
    name: string | null;          // nama depan pengguna, null = sapaan tanpa nama
    workspace: string | null;     // folder kerja; null = belum ada, tenggat dan inbox tidak bisa dibaca
    resume: HomeEntry[];
    recent: HomeEntry[];
    tasks: Task[];
    runs: HomeRun[];
    inboxes: InboxCount[];
    journal: HomeJournal | null;  // null = tanpa folder kerja
}

export class HomeView {
    readonly widget: Gtk.ScrolledWindow;
    onOpenFile: (path: string) => void = () => {};
    onOpenTask: (task: Task) => void = () => {};
    // true = berhasil ditulis ke papan; false = kotak centang dikembalikan.
    onToggleTask: (task: Task, done: boolean) => boolean = () => false;
    onOpenRun: (id: number) => void = () => {};
    onOpenInbox: (file: string) => void = () => {};
    onOpenFolder: () => void = () => {};
    onNewDocument: () => void = () => {};
    onOpenJournal: () => void = () => {};
    onCaptureJournal: () => void = () => {};

    private readonly page: Gtk.Box;
    private data: HomeData | null = null;
    private allTasks = false;   // pengguna membuka semua tenggat; bertahan sampai jendela ditutup

    constructor() {
        this.page = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, margin_top: 32, margin_bottom: 32, margin_start: 16, margin_end: 16 });
        const clamp = new Adw.Clamp({ maximum_size: MAX_WIDTH, tightening_threshold: 560, child: this.page, valign: Gtk.Align.START });
        this.widget = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true, hexpand: true, child: clamp });
        this.widget.add_css_class('home-view');
    }

    render(data: HomeData): void {
        this.data = data;
        removeChildren(this.page);
        if (!data.workspace && !data.resume.length && !data.recent.length) {
            this.page.append(this.welcome(data));
            return;
        }
        this.page.append(this.header(data));
        if (data.resume.length) this.addSection(_('Lanjutkan'), this.resumeCards(data));
        if (data.journal) this.addSection(_('Jurnal'), this.list([this.journalRow(data.journal)]));
        if (data.runs.length) this.addSection(_('Agent'), this.list(data.runs.map(run => this.runRow(run))));
        this.addSection(_('Tenggat'), this.taskList(data));
        if (data.inboxes.length) this.addSection(_('Inbox'), this.list(data.inboxes.map(inbox => this.inboxRow(inbox))));
        if (data.recent.length) this.addSection(_('Berkas terbaru'), this.list(data.recent.map(entry => this.recentRow(entry, data.now))));
    }

    // ---------- Bagian ----------

    private greeting(data: HomeData): string {
        const part: DayPart = dayPart(data.now.getHours());
        const { name } = data;
        if (!name) return { morning: _('Selamat pagi'), midday: _('Selamat siang'), afternoon: _('Selamat sore'), evening: _('Selamat malam') }[part];
        const text = { morning: _('Selamat pagi, {name}'), midday: _('Selamat siang, {name}'), afternoon: _('Selamat sore, {name}'), evening: _('Selamat malam, {name}') }[part];
        return fmt(text, { name });
    }

    private header(data: HomeData): Gtk.Widget {
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, margin_bottom: 8 });
        const title = new Gtk.Label({ label: this.greeting(data), xalign: 0, wrap: true });
        title.add_css_class('title-1');
        const date = new Gtk.Label({ label: data.now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }), xalign: 0, wrap: true });
        date.add_css_class('dim-label');
        box.append(title);
        box.append(date);
        return box;
    }

    // Belum ada folder kerja maupun riwayat berkas: arahkan ke dua langkah pertama.
    private welcome(data: HomeData): Gtk.Widget {
        const buttons = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, halign: Gtk.Align.CENTER });
        const folder = new Gtk.Button({ label: _('Buka Folder…') });
        folder.add_css_class('pill');
        folder.add_css_class('suggested-action');
        folder.connect('clicked', () => this.onOpenFolder());
        const doc = new Gtk.Button({ label: _('Dokumen Baru') });
        doc.add_css_class('pill');
        doc.connect('clicked', () => this.onNewDocument());
        buttons.append(folder);
        buttons.append(doc);
        return new Adw.StatusPage({
            icon_name: 'user-home-symbolic', title: this.greeting(data), child: buttons,
            description: _('Buka folder kerja untuk melihat berkas terakhir, tenggat kanban, dan inbox di sini.'),
        });
    }

    private addSection(title: string, child: Gtk.Widget): void {
        const label = new Gtk.Label({ label: title, xalign: 0, margin_top: 16, accessible_role: Gtk.AccessibleRole.HEADING });
        label.add_css_class('heading');
        this.page.append(label);
        this.page.append(child);
    }

    private list(rows: Gtk.Widget[]): Gtk.ListBox {
        const list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE });
        list.add_css_class('boxed-list');
        for (const row of rows) list.append(row);
        return list;
    }

    private row(title: string, subtitle = ''): Adw.ActionRow {
        // Judul kartu dan nama berkas bisa berisi "&" atau "<": tampilkan apa adanya, bukan markup.
        const row = new Adw.ActionRow({ title, subtitle, use_markup: false, activatable: true });
        row.set_title_lines(2);
        row.set_subtitle_lines(1);
        return row;
    }

    private suffix(text: string, style: string | null = 'dim-label'): Gtk.Label {
        const label = new Gtk.Label({ label: text, valign: Gtk.Align.CENTER });
        if (style) label.add_css_class(style);
        return label;
    }

    // ---------- Lanjutkan ----------

    private resumeCards(data: HomeData): Gtk.Widget {
        const flow = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE, homogeneous: true, min_children_per_line: 1, max_children_per_line: RESUME_CARDS,
            column_spacing: 12, row_spacing: 12,
        });
        for (const entry of data.resume) {
            const folder = new Gtk.Label({ label: entry.title, xalign: 0, ellipsize: Pango.EllipsizeMode.END });
            folder.add_css_class('heading');
            const file = new Gtk.Label({ label: entry.subtitle, xalign: 0, ellipsize: Pango.EllipsizeMode.MIDDLE });
            const time = new Gtk.Label({ label: ageLabel(new Date(entry.time * 1000), data.now), xalign: 0, ellipsize: Pango.EllipsizeMode.END });
            time.add_css_class('dim-label');
            time.add_css_class('caption');
            const icon = new Gtk.Image({ icon_name: 'folder-documents-symbolic', halign: Gtk.Align.START, margin_bottom: 4 });
            icon.add_css_class('dim-label');
            const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12 });
            box.append(icon);
            box.append(folder);
            box.append(file);
            box.append(time);
            const card = new Gtk.Button({ child: box, width_request: 150 });
            card.add_css_class('card');
            card.add_css_class('home-card');
            card.set_tooltip_text(entry.path);
            card.update_property([Gtk.AccessibleProperty.LABEL], [fmt(_('Lanjutkan {file} di {folder}'), { file: entry.subtitle, folder: entry.title })]);
            card.connect('clicked', () => this.onOpenFile(entry.path));
            // Fokus keyboard langsung ke tombol, bukan ke anak FlowBox pembungkusnya.
            flow.append(new Gtk.FlowBoxChild({ child: card, focusable: false }));
        }
        return flow;
    }

    // ---------- Jurnal ----------

    private journalRow(journal: HomeJournal): Adw.ActionRow {
        const parts: string[] = [];
        if (journal.notes) parts.push(fmt(ngettext('{n} catatan', '{n} catatan', journal.notes), { n: journal.notes }));
        if (journal.activity) parts.push(fmt(ngettext('{n} aktivitas', '{n} aktivitas', journal.activity), { n: journal.activity }));
        const subtitle = parts.length ? parts.join(' · ') : journal.exists ? _('Belum ada catatan') : _('Belum ditulis');
        const row = this.row(_('Jurnal hari ini'), subtitle);
        row.add_prefix(new Gtk.Image({ icon_name: 'x-office-calendar-symbolic' }));
        const capture = new Gtk.Button({ icon_name: 'list-add-symbolic', valign: Gtk.Align.CENTER, tooltip_text: _('Catat ke Jurnal…') });
        capture.add_css_class('flat');
        capture.update_property([Gtk.AccessibleProperty.LABEL], [_('Catat ke Jurnal…')]);
        capture.connect('clicked', () => this.onCaptureJournal());
        row.add_suffix(capture);
        row.add_suffix(new Gtk.Image({ icon_name: 'go-next-symbolic' }));
        row.connect('activated', () => this.onOpenJournal());
        return row;
    }

    // ---------- Agent ----------

    private runRow(run: HomeRun): Adw.ActionRow {
        const row = this.row(run.title, run.agent);
        const [text, style] = run.status === 'waiting' ? [_('Menunggu jawabanmu'), 'warning']
            : run.status === 'queued' ? [_('Dalam antrean'), 'dim-label']
            : [_('Sedang bekerja'), 'accent'];
        row.add_suffix(this.suffix(text, style));
        row.add_suffix(new Gtk.Image({ icon_name: 'go-next-symbolic' }));
        row.connect('activated', () => this.onOpenRun(run.id));
        return row;
    }

    // ---------- Tenggat ----------

    private dueText(task: Task): [string, string] {
        if (task.status === 'overdue') return [fmt(ngettext('Terlambat {n} hari', 'Terlambat {n} hari', -task.days), { n: -task.days }), 'error'];
        if (task.status === 'today') return [_('Hari ini'), 'warning'];
        return [task.days === 1 ? _('Besok') : _('Lusa'), 'dim-label'];
    }

    private taskList(data: HomeData): Gtk.Widget {
        if (!data.workspace) {
            const row = this.row(_('Buka folder kerja untuk melihat tenggat dari papan kanban'));
            row.add_suffix(new Gtk.Image({ icon_name: 'folder-open-symbolic' }));
            row.connect('activated', () => this.onOpenFolder());
            return this.list([row]);
        }
        if (!data.tasks.length) {
            const row = new Adw.ActionRow({ title: _('Tidak ada tenggat sampai lusa'), activatable: false });
            row.add_css_class('dim-label');
            return this.list([row]);
        }
        const shown = this.allTasks ? data.tasks : data.tasks.slice(0, SHOWN_TASKS);
        const rows: Gtk.Widget[] = shown.map(task => this.taskRow(task));
        const hidden = data.tasks.length - shown.length;
        if (hidden > 0) {
            const more = new Adw.ActionRow({ title: fmt(ngettext('Tampilkan {n} tugas lainnya', 'Tampilkan {n} tugas lainnya', hidden), { n: hidden }), activatable: true });
            more.add_suffix(new Gtk.Image({ icon_name: 'pan-down-symbolic' }));
            more.connect('activated', () => {
                this.allTasks = true;
                // Ditunda: baris ini ikut dihancurkan saat Beranda digambar ulang.
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    if (this.data) this.render(this.data);
                    return GLib.SOURCE_REMOVE;
                });
            });
            rows.push(more);
        }
        return this.list(rows);
    }

    private taskRow(task: Task): Adw.ActionRow {
        const board = task.file.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
        const row = this.row(task.title, task.project ? `${task.project} · ${board}` : board);
        const check = new Gtk.CheckButton({ valign: Gtk.Align.CENTER });
        check.add_css_class('selection-mode');
        check.update_property([Gtk.AccessibleProperty.LABEL], [fmt(_('Tandai selesai: {title}'), { title: task.title })]);
        let reverting = false;
        check.connect('toggled', () => {
            if (reverting) return;
            const done = check.active;
            if (!this.onToggleTask(task, done)) {
                reverting = true;
                check.active = !done;
                reverting = false;
                return;
            }
            // Baris tetap di tempatnya sampai Beranda digambar ulang, supaya centang yang keliru bisa dibatalkan.
            if (done) row.add_css_class('dim-label'); else row.remove_css_class('dim-label');
        });
        row.add_prefix(check);
        const [text, style] = this.dueText(task);
        row.add_suffix(this.suffix(text, style));
        row.connect('activated', () => this.onOpenTask(task));
        return row;
    }

    // ---------- Inbox dan berkas terbaru ----------

    private inboxRow(inbox: InboxCount): Adw.ActionRow {
        const row = this.row(inbox.file);
        row.add_prefix(new Gtk.Image({ icon_name: 'mail-unread-symbolic' }));
        row.add_suffix(this.suffix(fmt(ngettext('{n} belum diproses', '{n} belum diproses', inbox.open), { n: inbox.open })));
        row.connect('activated', () => this.onOpenInbox(inbox.file));
        return row;
    }

    private recentRow(entry: HomeEntry, now: Date): Adw.ActionRow {
        const row = this.row(entry.title, entry.subtitle);
        row.set_title_lines(1);
        row.set_tooltip_text(entry.path);
        row.add_prefix(new Gtk.Image({ icon_name: 'text-x-generic-symbolic' }));
        row.add_suffix(this.suffix(ageLabel(new Date(entry.time * 1000), now)));
        row.connect('activated', () => this.onOpenFile(entry.path));
        return row;
    }
}
