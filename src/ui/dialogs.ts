// Dialog standar: pilih file, konfirmasi simpan, pesan error, tentang.
// Semua dialog bersifat modal dan blocking (dialog.run()), jadi hasilnya bisa
// langsung dikembalikan.

import Gtk from 'gi://Gtk?version=3.0';
import Gdk from 'gi://Gdk?version=3.0';
import { APP_NAME, APP_VERSION } from '../config.js';
import { composeCard, DUE_INPUT, splitCard } from '../markdown/kanban.js';

type FilterSetup = [label: string, setup: (filter: Gtk.FileFilter) => void];

export const FILTERS = {
    markdown: ['Markdown', f => ['*.md', '*.markdown', '*.mdown', '*.txt'].forEach(p => f.add_pattern(p))],
    image: ['Gambar', f => f.add_mime_type('image/*')],
    html: ['HTML', f => f.add_pattern('*.html')],
    all: ['Semua file', f => f.add_pattern('*')],
} satisfies Record<string, FilterSetup>;

export type FilterName = keyof typeof FILTERS;

export interface ChooseFileOptions {
    title: string;
    save?: boolean;
    selectFolder?: boolean;     // pilih folder, bukan file
    filters?: FilterName[];
    name?: string | null;       // nama file usulan (dialog simpan)
    folder?: string | null;     // folder awal
}

// Mengembalikan path yang dipilih, atau null jika dibatalkan.
export function chooseFile(parent: Gtk.Window, { title, save = false, selectFolder = false, filters = [], name = null, folder = null }: ChooseFileOptions): string | null {
    const dialog = new Gtk.FileChooserNative({
        title, transient_for: parent,
        action: selectFolder ? Gtk.FileChooserAction.SELECT_FOLDER : save ? Gtk.FileChooserAction.SAVE : Gtk.FileChooserAction.OPEN,
    });
    if (save) dialog.set_do_overwrite_confirmation(true);
    for (const key of filters) {
        const [label, setup]: FilterSetup = FILTERS[key];
        const filter = new Gtk.FileFilter();
        filter.set_name(label);
        setup(filter);
        dialog.add_filter(filter);
    }
    if (folder) dialog.set_current_folder(folder);
    if (name) dialog.set_current_name(name);
    return dialog.run() === Gtk.ResponseType.ACCEPT ? dialog.get_filename() : null;
}

// Mengembalikan 'save', 'discard', atau 'cancel'.
export function askSaveChanges(parent: Gtk.Window, documentName: string): 'save' | 'discard' | 'cancel' {
    const dialog = new Gtk.MessageDialog({
        transient_for: parent, modal: true, message_type: Gtk.MessageType.WARNING,
        text: `Simpan perubahan pada “${documentName}”?`,
        secondary_text: 'Perubahan akan hilang jika tidak disimpan.',
    });
    dialog.add_button('Jangan Simpan', Gtk.ResponseType.NO);
    dialog.add_button('Batal', Gtk.ResponseType.CANCEL);
    dialog.add_button('Simpan', Gtk.ResponseType.YES);
    dialog.set_default_response(Gtk.ResponseType.YES);
    const response = dialog.run();
    dialog.destroy();
    if (response === Gtk.ResponseType.YES) return 'save';
    if (response === Gtk.ResponseType.NO) return 'discard';
    return 'cancel';
}

export function showError(parent: Gtk.Window, message: string): void {
    const dialog = new Gtk.MessageDialog({
        transient_for: parent, modal: true, message_type: Gtk.MessageType.ERROR,
        buttons: Gtk.ButtonsType.CLOSE, text: message,
    });
    dialog.run();
    dialog.destroy();
}

export function showAbout(parent: Gtk.Window): void {
    const dialog = new Gtk.AboutDialog({
        transient_for: parent, modal: true, program_name: APP_NAME, version: APP_VERSION,
        logo_icon_name: 'accessories-text-editor',
        comments: 'Editor Markdown ala Typora dengan GTK 3 dan GJS.',
    });
    dialog.run();
    dialog.destroy();
}

// ---------- Dialog untuk papan kanban ----------

export interface CardDraft {
    text: string;
    notes: string[];
}

// Dialog sunting kartu: judul (satu baris) dan catatan (banyak baris).
// Mengembalikan isi baru, atau null jika dibatalkan.
export function editCardDialog(parent: Gtk.Window | null, card: CardDraft): CardDraft | null {
    const dialog = new Gtk.Dialog({ title: 'Sunting Kartu', transient_for: parent, modal: true, default_width: 440 });
    dialog.add_button('Batal', Gtk.ResponseType.CANCEL);
    dialog.add_button('Simpan', Gtk.ResponseType.OK);
    dialog.set_default_response(Gtk.ResponseType.OK);

    const title = new Gtk.Entry({ text: card.text, activates_default: true, hexpand: true });
    const parts = splitCard(card.text);
    title.text = parts.title;
    const tags = new Gtk.Entry({ text: parts.tags.join(' '), activates_default: true, hexpand: true, placeholder_text: 'tag1 tag2' });
    const due = new Gtk.Entry({ text: parts.due, activates_default: true, hexpand: true, placeholder_text: 'YYYY-MM-DD' });
    due.connect('changed', () => due.get_style_context().remove_class('error'));
    const notes = new Gtk.TextView({ wrap_mode: Gtk.WrapMode.WORD_CHAR, left_margin: 6, right_margin: 6, top_margin: 6, bottom_margin: 6 });
    notes.buffer.set_text(card.notes.join('\n'), -1);
    // Ctrl+Enter menyimpan dari kolom catatan (Enter biasa membuat baris baru).
    notes.connect('key-press-event', (_w, ev) => {
        const event = ev as unknown as Gdk.Event;
        const [, keyval] = event.get_keyval();
        const [, state] = event.get_state();
        if ((keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) && (state & Gdk.ModifierType.CONTROL_MASK)) {
            dialog.response(Gtk.ResponseType.OK);
            return true;
        }
        return false;
    });
    const frame = new Gtk.ScrolledWindow({ min_content_height: 140, shadow_type: Gtk.ShadowType.IN, hexpand: true, vexpand: true });
    frame.add(notes);

    const box = dialog.get_content_area();
    box.spacing = 8;
    box.margin = 12;
    box.pack_start(new Gtk.Label({ label: 'Judul', xalign: 0 }), false, false, 0);
    box.pack_start(title, false, false, 0);
    box.pack_start(new Gtk.Label({ label: 'Tag (pisahkan dengan spasi)', xalign: 0 }), false, false, 0);
    box.pack_start(tags, false, false, 0);
    box.pack_start(new Gtk.Label({ label: 'Tenggat', xalign: 0 }), false, false, 0);
    box.pack_start(due, false, false, 0);
    box.pack_start(new Gtk.Label({ label: 'Catatan', xalign: 0 }), false, false, 0);
    box.pack_start(frame, true, true, 0);
    box.show_all();

    // Tenggat harus kosong atau berformat tanggal; selain itu dialog tetap terbuka.
    let response = dialog.run();
    while (response === Gtk.ResponseType.OK && due.text.trim() && !DUE_INPUT.test(due.text.trim())) {
        due.get_style_context().add_class('error');
        due.grab_focus();
        response = dialog.run();
    }
    const [start, end] = notes.buffer.get_bounds();
    const result: CardDraft = {
        text: composeCard({ title: title.text, tags: tags.text.split(/[\s,]+/), due: due.text }),
        notes: notes.buffer.get_text(start, end, true).replace(/\s+$/, '').split('\n').filter((l, i, all) => all.length > 1 || l !== ''),
    };
    dialog.destroy();
    return response === Gtk.ResponseType.OK ? result : null;
}

// Meminta satu baris teks. null jika dibatalkan.
export function promptDialog(parent: Gtk.Window | null, options: { title: string; label: string; value?: string }): string | null {
    const dialog = new Gtk.Dialog({ title: options.title, transient_for: parent, modal: true, default_width: 360 });
    dialog.add_button('Batal', Gtk.ResponseType.CANCEL);
    dialog.add_button('OK', Gtk.ResponseType.OK);
    dialog.set_default_response(Gtk.ResponseType.OK);
    const entry = new Gtk.Entry({ text: options.value ?? '', activates_default: true });
    const box = dialog.get_content_area();
    box.spacing = 8;
    box.margin = 12;
    box.pack_start(new Gtk.Label({ label: options.label, xalign: 0 }), false, false, 0);
    box.pack_start(entry, false, false, 0);
    box.show_all();
    const response = dialog.run();
    const value = entry.text.trim();
    dialog.destroy();
    return response === Gtk.ResponseType.OK && value ? value : null;
}

export function confirmDialog(parent: Gtk.Window | null, message: string, detail?: string): boolean {
    const dialog = new Gtk.MessageDialog({
        transient_for: parent, modal: true, message_type: Gtk.MessageType.QUESTION, text: message,
    });
    if (detail) dialog.secondary_text = detail;
    dialog.add_button('Batal', Gtk.ResponseType.CANCEL);
    dialog.add_button('Hapus', Gtk.ResponseType.OK);
    const response = dialog.run();
    dialog.destroy();
    return response === Gtk.ResponseType.OK;
}
