// Jendela baca untuk satu commit: tab Perubahan (diff terhadap commit sebelumnya) dan
// tab Isi (file lengkap pada commit itu). Hanya baca; jendela tidak modal supaya dokumen
// tetap bisa dibandingkan sambil mengedit.

import Gtk from 'gi://Gtk?version=3.0';
import Gdk from 'gi://Gdk?version=3.0';
import GLib from 'gi://GLib';
import { commitContent, commitDiff, type TextResult } from '../git.js';
import { parseDiff, type Commit } from '../gitlog.js';

const DIFF_COLORS = {
    light: { add: '#dafbe1', del: '#ffebe9', hunk: '#0969da' },
    dark: { add: '#17331f', del: '#3d1a1c', hunk: '#6cb6ff' },
};

export class HistoryViewer {
    readonly window: Gtk.Window;
    readonly diffView: Gtk.TextView;
    readonly contentView: Gtk.TextView;
    readonly stack: Gtk.Stack;
    closed = false;

    constructor(parent: Gtk.Window | null, file: string, readonly commit: Commit, dark: boolean) {
        this.window = new Gtk.Window({
            transient_for: parent, default_width: 860, default_height: 620,
            window_position: Gtk.WindowPosition.CENTER_ON_PARENT,
        });
        const date = GLib.DateTime.new_from_unix_local(commit.time).format('%d %b %Y %H:%M');
        // Judul header dipakai StackSwitcher, jadi info commit ditaruh di atas isi.
        const header = new Gtk.HeaderBar({ show_close_button: true });
        this.window.set_titlebar(header);
        this.window.set_title(commit.subject || '(tanpa pesan)');
        const subject = new Gtk.Label({ label: commit.subject || '(tanpa pesan)', xalign: 0, wrap: true });
        subject.set_markup(`<b>${GLib.markup_escape_text(commit.subject || '(tanpa pesan)', -1)}</b>`);
        const meta = new Gtk.Label({ label: `${commit.short} · ${commit.author} · ${date}`, xalign: 0 });
        meta.get_style_context().add_class('dim-label');
        const info = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, margin: 12, margin_bottom: 8 });
        info.pack_start(subject, false, false, 0);
        info.pack_start(meta, false, false, 0);

        this.diffView = this.createView();
        this.contentView = this.createView();
        this.stack = new Gtk.Stack({ transition_type: Gtk.StackTransitionType.CROSSFADE, transition_duration: 100 });
        this.stack.add_titled(this.scrolled(this.diffView), 'diff', 'Perubahan');
        this.stack.add_titled(this.scrolled(this.contentView), 'content', 'Isi versi ini');
        header.set_custom_title(new Gtk.StackSwitcher({ stack: this.stack }));
        const body = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        body.pack_start(info, false, false, 0);
        body.pack_start(new Gtk.Separator(), false, false, 0);
        body.pack_start(this.stack, true, true, 0);
        this.window.add(body);

        this.window.connect('destroy', () => { this.closed = true; });
        this.window.connect('key-press-event', (_w, event) => {
            if (event.keyval !== Gdk.KEY_Escape) return false;
            this.window.destroy();
            return true;
        });

        this.setupDiffTags(dark);
        this.setPlaceholder('Memuat…');
        commitDiff(file, commit).then(result => this.showDiff(result));
        commitContent(file, commit).then(result => this.showContent(result));
    }

    show(): void {
        this.window.show_all();
    }

    private setPlaceholder(message: string): void {
        this.diffView.buffer.set_text(message, -1);
        this.contentView.buffer.set_text(message, -1);
    }

    private createView(): Gtk.TextView {
        const view = new Gtk.TextView({
            editable: false, cursor_visible: false, monospace: true,
            wrap_mode: Gtk.WrapMode.WORD_CHAR,
            left_margin: 14, right_margin: 14, top_margin: 10, bottom_margin: 10,
        });
        view.get_style_context().add_class('history-text');
        return view;
    }

    private scrolled(view: Gtk.TextView): Gtk.ScrolledWindow {
        const scroll = new Gtk.ScrolledWindow();
        scroll.add(view);
        return scroll;
    }

    private setupDiffTags(dark: boolean): void {
        const colors = DIFF_COLORS[dark ? 'dark' : 'light'];
        const table = this.diffView.buffer.get_tag_table();
        const add = (name: string, props: Record<string, string>) => {
            const tag = new Gtk.TextTag({ name });
            for (const [key, value] of Object.entries(props)) tag.set_property(key, value);
            table.add(tag);
        };
        add('add', { paragraph_background: colors.add });
        add('del', { paragraph_background: colors.del });
        add('hunk', { foreground: colors.hunk });
    }

    private showDiff(result: TextResult): void {
        if (this.closed) return;
        const buffer = this.diffView.buffer;
        if (!result.ok) return buffer.set_text(`Gagal membaca perubahan:\n${result.message}`, -1);
        const lines = parseDiff(result.text);
        if (!lines.length) return buffer.set_text('Tidak ada perubahan isi pada commit ini (misalnya hanya ganti nama)', -1);
        buffer.set_text(lines.map(l => l.text).join('\n'), -1);
        lines.forEach((line, i) => {
            if (line.kind === 'context') return;
            const start = buffer.get_iter_at_line(i);
            const end = start.copy();
            end.forward_to_line_end();
            buffer.apply_tag_by_name(line.kind, start, end);
        });
    }

    private showContent(result: TextResult): void {
        if (this.closed) return;
        this.contentView.buffer.set_text(result.ok ? result.text : `Gagal membaca isi file:\n${result.message}`, -1);
    }
}
