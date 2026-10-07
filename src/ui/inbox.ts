// Tampilan inbox untuk dokumen inbox (markdown/inbox.ts).
//
//   Inbox                                        [+ Catatan Baru]
//   Tempat menangkap ide, catatan, dan hal yang perlu diproses nanti.
//   ┌ Tangkap cepat: ketik lalu Enter ───────────────────────┐
//   ┌────────────────────────────────────────────────────────┐
//   │ Ide: Muara bisa menggunakan SQLite…          #idea   ✕ │   klik untuk menyunting
//   │ 10 menit lalu                                          │
//   └────────────────────────────────────────────────────────┘
//
// Seperti papan kanban, komponen ini hanya memegang model dan tampilannya: setiap
// perubahan lewat commit(), yang memanggil onChange supaya jendela menulisnya ke buffer
// (teks Markdown tetap satu-satunya sumber kebenaran).

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import { ageOf, captureItem, deleteItem, itemMeta, newInbox, updateItem, type Age, type Inbox } from '../markdown/inbox.js';
import { cellMarkup, NOTE_URI, type MarkupColors } from '../markdown/pango.js';
import { parseWikiLink, type WikiLink } from '../markdown/wikilink.js';
import { editNoteDialog, type CardDraft } from './dialogs.js';
import type { Palette } from './theme.js';
import { after, removeChildren, type Awaitable } from '../gtkutil.js';
import { _, fmt, ngettext } from '../i18n.js';

const MAX_WIDTH = 720;

// "10 menit lalu", "1 jam lalu", "3 hari lalu"; lebih lama dari seminggu berupa tanggal. Dipakai juga Beranda.
export function ageLabel(captured: Date, now: Date): string {
    const age: Age = ageOf(captured, now);
    switch (age.unit) {
        case 'now': return _('baru saja');
        case 'minutes': return fmt(ngettext('{n} menit lalu', '{n} menit lalu', age.n), { n: age.n });
        case 'hours': return fmt(ngettext('{n} jam lalu', '{n} jam lalu', age.n), { n: age.n });
        case 'days': return fmt(ngettext('{n} hari lalu', '{n} hari lalu', age.n), { n: age.n });
        default: return captured.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: captured.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
    }
}

export interface InboxDialogs {
    editNote(parent: Gtk.Window | null, item: CardDraft, title?: string, listNotes?: () => string[]): Awaitable<CardDraft | null>;
}

export class InboxView {
    readonly widget: Gtk.ScrolledWindow;
    onChange: (inbox: Inbox) => void = () => {};
    dialogs: InboxDialogs = { editNote: editNoteDialog };
    now: () => Date = () => new Date();
    onOpenNote: (link: WikiLink) => void = () => {};
    listNotes: (() => string[]) | null = null;

    private inbox: Inbox = newInbox();
    private colors: MarkupColors = { code: '#c7254e', codeBg: '#f3f4f4', link: '#1c71d8', mark: '#fff3a3' };
    private readonly page: Gtk.Box;
    private readonly entry: Gtk.Entry;
    private readonly list: Gtk.ListBox;
    private readonly empty: Adw.StatusPage;
    private readonly title: Gtk.Label;
    private readonly description: Gtk.Label;
    private renderQueued = false;

    constructor() {
        this.title = new Gtk.Label({ xalign: 0, hexpand: true, wrap: true });
        this.title.add_css_class('title-1');
        this.description = new Gtk.Label({ xalign: 0, wrap: true, visible: false });
        this.description.add_css_class('dim-label');

        const add = new Gtk.Button({ child: new Adw.ButtonContent({ icon_name: 'list-add-symbolic', label: _('Catatan Baru') }), valign: Gtk.Align.START });
        add.set_tooltip_text(_('Tambah catatan dengan judul, tag, dan catatan lengkap'));
        add.connect('clicked', () => this.showAddNote());
        const titles = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, hexpand: true });
        titles.append(this.title);
        titles.append(this.description);
        const header = new Gtk.Box({ spacing: 12 });
        header.append(titles);
        header.append(add);

        this.entry = new Gtk.Entry({ placeholder_text: _('Tulis ide, tautan, atau catatan cepat…'), hexpand: true });
        this.entry.set_name('inbox-entry');
        this.entry.update_property([Gtk.AccessibleProperty.LABEL], [_('Tangkap cepat ke inbox')]);
        this.entry.connect('activate', () => this.capture(this.entry.text));

        this.list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE });
        this.list.add_css_class('inbox-list');
        this.empty = new Adw.StatusPage({ icon_name: 'mail-inbox-symbolic', title: _('Inbox kosong'), description: _('Tulis sesuatu di atas untuk menangkapnya.') });
        this.empty.add_css_class('compact');

        this.page = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 16, margin_top: 24, margin_bottom: 24, margin_start: 16, margin_end: 16 });
        this.page.append(header);
        this.page.append(this.entry);
        this.page.append(this.list);
        this.page.append(this.empty);

        const clamp = new Adw.Clamp({ maximum_size: MAX_WIDTH, tightening_threshold: 560, child: this.page, valign: Gtk.Align.START });
        this.widget = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true, hexpand: true, child: clamp });
        this.widget.add_css_class('inbox-view');
    }

    // ---------- Model ----------

    getInbox(): Inbox {
        return this.inbox;
    }

    // Ganti isi (dokumen dibuka atau undo) tanpa memanggil onChange.
    setInbox(inbox: Inbox): void {
        this.inbox = inbox;
        this.render();
    }

    commit(next: Inbox): void {
        if (next === this.inbox) return;
        this.inbox = next;
        this.queueRender();
        this.onChange(next);
    }

    setPalette(palette: Palette): void {
        this.colors = { code: palette.codeFg, codeBg: palette.codeBg, link: palette.accent, mark: palette.markBg };
        this.render();
    }

    private get parent(): Gtk.Window | null {
        const top = this.widget.get_root();
        return top instanceof Gtk.Window ? top : null;
    }

    // ---------- Menggambar ----------

    // Ditunda ke idle: perubahan datang dari klik widget yang akan dihancurkan.
    queueRender(): void {
        if (this.renderQueued) return;
        this.renderQueued = true;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.renderQueued = false;
            this.render();
            return GLib.SOURCE_REMOVE;
        });
    }

    render(): void {
        const { title, description } = this.heading();
        this.title.set_label(title);
        this.description.set_label(description);
        this.description.set_visible(!!description);
        removeChildren(this.list);
        this.inbox.items.forEach((_item, i) => this.list.append(this.buildRow(i)));
        this.list.set_visible(this.inbox.items.length > 0);
        this.empty.set_visible(this.inbox.items.length === 0);
    }

    // Judul dan deskripsi diambil dari bagian head setelah frontmatter.
    private heading(): { title: string; description: string } {
        const lines = [...this.inbox.head];
        if (lines[0]?.trim() === '---') {
            const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
            lines.splice(0, close < 0 ? lines.length : close + 1);
        }
        const at = lines.findIndex(l => /^#\s+\S/.test(l));
        const title = at >= 0 ? lines[at].replace(/^#\s+/, '').trim() : _('Inbox');
        const rest = at >= 0 ? lines.slice(at + 1) : lines;
        return { title, description: rest.map(l => l.trim()).filter(Boolean).join(' ') };
    }

    ageLabel(captured: Date): string {
        return ageLabel(captured, this.now());
    }

    private buildRow(i: number): Gtk.ListBoxRow {
        const item = this.inbox.items[i];
        const meta = itemMeta(item.text);

        const title = new Gtk.Label({ use_markup: true, xalign: 0, wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR, hexpand: true, width_chars: 10 });
        title.set_markup(cellMarkup(meta.title, this.colors, true));
        title.connect('activate-link', (_l, uri: string) => this.activateNote(uri));
        const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, hexpand: true, valign: Gtk.Align.CENTER });
        text.append(title);
        const details: string[] = [];
        if (meta.captured) details.push(this.ageLabel(meta.captured));
        if (item.notes.length) details.push(_('ada catatan'));
        if (details.length) {
            const sub = new Gtk.Label({ label: details.join(' · '), xalign: 0 });
            sub.add_css_class('dim-label');
            sub.add_css_class('caption');
            text.append(sub);
        }

        const box = new Gtk.Box({ spacing: 8, margin_top: 10, margin_bottom: 10, margin_start: 14, margin_end: 8 });
        box.append(text);
        for (const tag of meta.tags) {
            const chip = new Gtk.Label({ label: `#${tag}`, valign: Gtk.Align.CENTER });
            chip.add_css_class('inbox-tag');
            box.append(chip);
        }
        const remove = new Gtk.Button({ icon_name: 'window-close-symbolic', valign: Gtk.Align.CENTER, tooltip_text: _('Hapus catatan') });
        remove.add_css_class('flat');
        remove.add_css_class('circular');
        remove.update_property([Gtk.AccessibleProperty.LABEL], [fmt(_('Hapus catatan: {title}'), { title: meta.title })]);
        remove.connect('clicked', () => this.commit(deleteItem(this.inbox, i)));
        box.append(remove);

        const row = new Gtk.ListBoxRow({ child: box, activatable: true });
        row.connect('activate', () => this.editItem(i));
        return row;
    }

    private activateNote(uri: string): boolean {
        if (!uri.startsWith(NOTE_URI)) return false;
        this.onOpenNote(parseWikiLink(decodeURIComponent(uri.slice(NOTE_URI.length))));
        return true;
    }

    // ---------- Aksi ----------

    // Tangkap cepat: satu baris dari isian di atas daftar.
    capture(text: string): void {
        this.entry.set_text('');
        if (!text.trim()) return;
        this.commit(captureItem(this.inbox, text, this.now()));
        this.entry.grab_focus();
    }

    // Catatan baru lewat dialog, dengan tag dan catatan.
    showAddNote(): void {
        void after(this.dialogs.editNote(this.parent, { text: '', notes: [] }, _('Catatan Baru'), this.listNotes ?? undefined), draft => {
            if (draft?.text) this.commit(captureItem(this.inbox, draft.text, this.now(), draft.notes));
        });
    }

    editItem(index: number): void {
        const item = this.inbox.items[index];
        if (!item) return;
        void after(this.dialogs.editNote(this.parent, { text: item.text, notes: item.notes }, undefined, this.listNotes ?? undefined), result => {
            // Inbox bisa berubah selama dialog terbuka; item yang sama dicari lagi lewat posisinya.
            if (result?.text && this.inbox.items[index]?.text === item.text)
                this.commit(updateItem(this.inbox, index, { text: result.text, notes: result.notes }));
        });
    }

    focusCapture(): void {
        this.entry.grab_focus();
    }
}
