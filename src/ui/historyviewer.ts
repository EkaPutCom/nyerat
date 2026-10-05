// Jendela baca untuk satu commit (atau, dengan commit null, perubahan file yang belum di-commit): tab Perubahan (diff terhadap commit sebelumnya) dan
// tab Isi (file lengkap pada commit itu). Hanya baca; jendela tidak modal supaya dokumen
// tetap bisa dibandingkan sambil mengedit.

import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import { commitContent, commitDiff, commitFile, workingDiff, type TextResult } from '../git.js';
import { parseDiff, type Commit, type DiffLine } from '../gitlog.js';
import { replaceAllText } from '../editor/view.js';
import { iterAtLine, onKeyPress, pack } from '../gtkutil.js';

const DIFF_COLORS = {
    light: { add: '#dafbe1', del: '#ffebe9', hunk: '#0969da' },
    dark: { add: '#17331f', del: '#3d1a1c', hunk: '#6cb6ff' },
};

// Tampilan diff bersama (riwayat Git dan usulan perubahan agent): tag warna di buffer, lalu isi baris berjenis.
export function setupDiffTags(view: Gtk.TextView, dark: boolean): void {
    const colors = DIFF_COLORS[dark ? 'dark' : 'light'];
    const table = view.buffer.get_tag_table();
    const add = (name: string, props: Record<string, string>) => {
        const existing = table.lookup(name);
        const tag = existing ?? new Gtk.TextTag({ name });
        for (const [key, value] of Object.entries(props)) tag.set_property(key, value);
        if (!existing) table.add(tag);
    };
    add('add', { paragraph_background: colors.add });
    add('del', { paragraph_background: colors.del });
    add('hunk', { foreground: colors.hunk });
}

export function fillDiff(view: Gtk.TextView, lines: DiffLine[]): void {
    const buffer = view.buffer;
    // Diff dan isi file bisa sepanjang satu buku.
    replaceAllText(view, () => buffer.set_text(lines.map(l => l.text).join('\n'), -1));
    lines.forEach((line, i) => {
        if (line.kind === 'context') return;
        const start = iterAtLine(buffer, i);
        const end = start.copy();
        end.forward_to_line_end();
        buffer.apply_tag_by_name(line.kind, start, end);
    });
}

export function createDiffView(): Gtk.TextView {
    const view = new Gtk.TextView({
        editable: false, cursor_visible: false, monospace: true,
        wrap_mode: Gtk.WrapMode.WORD_CHAR,
        left_margin: 14, right_margin: 14, top_margin: 10, bottom_margin: 10,
    });
    view.add_css_class('history-text');
    return view;
}

export class HistoryViewer {
    readonly window: Gtk.Window;
    readonly diffView: Gtk.TextView;
    readonly contentView: Gtk.TextView;
    readonly stack: Gtk.Stack;
    closed = false;
    readonly messageEntry: Gtk.Entry;          // pesan commit (hanya mode perubahan belum di-commit)
    readonly commitButton: Gtk.Button;
    readonly status: Gtk.Label;
    beforeCommit: () => boolean = () => true;  // simpan dokumen dulu; false = batalkan commit
    onCommitted: () => void = () => {};

    constructor(parent: Gtk.Window | null, file: string, readonly commit: Commit | null, dark: boolean) {
        this.window = new Gtk.Window({
            transient_for: parent, default_width: 860, default_height: 620,
        });
        const title = commit ? commit.subject || '(tanpa pesan)' : 'Perubahan belum di-commit';
        const detail = commit
            ? `${commit.short} · ${commit.author} · ${GLib.DateTime.new_from_unix_local(commit.time).format('%d %b %Y %H:%M')}`
            : `${GLib.path_get_basename(file)} · dibandingkan dengan commit terakhir`;
        // Judul header dipakai StackSwitcher, jadi info commit ditaruh di atas isi.
        const header = new Gtk.HeaderBar({ show_title_buttons: true });
        this.window.set_titlebar(header);
        this.window.set_title(title);
        const subject = new Gtk.Label({ label: title, xalign: 0, wrap: true });
        subject.set_markup(`<b>${GLib.markup_escape_text(title, -1)}</b>`);
        const meta = new Gtk.Label({ label: detail, xalign: 0 });
        meta.add_css_class('dim-label');
        const info = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, margin_top: 12, margin_start: 12, margin_end: 12, margin_bottom: 8 });
        info.append(subject);
        info.append(meta);

        this.diffView = this.createView();
        this.contentView = this.createView();
        this.stack = new Gtk.Stack({ transition_type: Gtk.StackTransitionType.CROSSFADE, transition_duration: 100 });
        this.stack.add_titled(this.scrolled(this.diffView), 'diff', 'Perubahan');
        // Perubahan yang belum di-commit tidak punya "versi"; isi terbarunya sudah ada di editor.
        if (commit) {
            this.stack.add_titled(this.scrolled(this.contentView), 'content', 'Isi versi ini');
            header.set_title_widget(new Gtk.StackSwitcher({ stack: this.stack }));
        }
        const body = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        body.append(info);
        body.append(new Gtk.Separator());
        pack(body, this.stack, true);

        this.messageEntry = new Gtk.Entry({ placeholder_text: 'Pesan commit', hexpand: true });
        this.commitButton = new Gtk.Button({ label: 'Commit file ini' });
        this.commitButton.add_css_class('suggested-action');
        this.status = new Gtk.Label({ xalign: 0, wrap: true, visible: false, margin_start: 12, margin_end: 12, margin_bottom: 8 });
        if (!commit) {
            const bar = new Gtk.Box({ spacing: 8, margin_top: 10, margin_bottom: 10, margin_start: 10, margin_end: 10 });
            pack(bar, this.messageEntry, true);
            bar.append(this.commitButton);
            body.append(new Gtk.Separator());
            body.append(bar);
            body.append(this.status);
            this.commitButton.connect('clicked', () => this.doCommit(file));
            this.messageEntry.connect('activate', () => this.doCommit(file));
        }
        this.window.set_child(body);

        // Jendela dihancurkan (GTK 4 tidak memancarkan "destroy" selama objeknya dipegang JavaScript).
        this.window.connect('unrealize', () => { this.closed = true; });
        onKeyPress(this.window, keyval => {
            if (keyval !== Gdk.KEY_Escape) return false;
            this.window.destroy();
            return true;
        });

        setupDiffTags(this.diffView, dark);
        this.setPlaceholder('Memuat…');
        if (commit) {
            commitDiff(file, commit).then(result => this.showDiff(result));
            commitContent(file, commit).then(result => this.showContent(result));
        } else {
            workingDiff(file).then(result => this.showDiff(result));
        }
    }

    private async doCommit(file: string): Promise<void> {
        const message = this.messageEntry.get_text().trim();
        if (!message) return this.showStatus('Isi pesan commit dulu');
        if (!this.beforeCommit()) return this.showStatus('Dokumen gagal disimpan; commit dibatalkan');
        this.commitButton.set_sensitive(false);
        const result = await commitFile(file, message);
        if (this.closed) return;
        if (!result.ok) {
            this.commitButton.set_sensitive(true);
            return this.showStatus(`Commit gagal: ${result.message}`);
        }
        this.onCommitted();
        this.window.destroy();
    }

    private showStatus(text: string): void {
        this.status.set_text(text);
        this.status.set_visible(true);
    }

    show(): void {
        this.window.present();
    }

    private setPlaceholder(message: string): void {
        this.diffView.buffer.set_text(message, -1);
        this.contentView.buffer.set_text(message, -1);
    }

    private createView(): Gtk.TextView {
        return createDiffView();
    }

    private scrolled(view: Gtk.TextView): Gtk.ScrolledWindow {
        const scroll = new Gtk.ScrolledWindow();
        scroll.set_child(view);
        return scroll;
    }

    private showDiff(result: TextResult): void {
        if (this.closed) return;
        const buffer = this.diffView.buffer;
        if (!result.ok) return buffer.set_text(`Gagal membaca perubahan:\n${result.message}`, -1);
        const lines = parseDiff(result.text);
        if (!lines.length) return buffer.set_text(this.commit
            ? 'Tidak ada perubahan isi pada commit ini (misalnya hanya ganti nama)'
            : 'Tidak ada perubahan yang belum di-commit', -1);
        fillDiff(this.diffView, lines);
    }

    private showContent(result: TextResult): void {
        if (this.closed) return;
        replaceAllText(this.contentView, () =>
            this.contentView.buffer.set_text(result.ok ? result.text : `Gagal membaca isi file:\n${result.message}`, -1));
    }
}
