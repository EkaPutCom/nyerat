// Dialog standar: pilih file, konfirmasi simpan, pesan error, tentang.
// Semua dialog bersifat modal dan blocking (dialog.run()), jadi hasilnya bisa
// langsung dikembalikan.

import Gtk from 'gi://Gtk?version=3.0';
import { APP_NAME, APP_VERSION } from '../config.js';

export const FILTERS = {
    markdown: ['Markdown', f => ['*.md', '*.markdown', '*.mdown', '*.txt'].forEach(p => f.add_pattern(p))],
    image: ['Gambar', f => f.add_mime_type('image/*')],
    html: ['HTML', f => f.add_pattern('*.html')],
    all: ['Semua file', f => f.add_pattern('*')],
};

// Mengembalikan path yang dipilih, atau null jika dibatalkan.
export function chooseFile(parent, { title, save = false, filters = [], name = null, folder = null }) {
    const dialog = new Gtk.FileChooserNative({
        title, transient_for: parent,
        action: save ? Gtk.FileChooserAction.SAVE : Gtk.FileChooserAction.OPEN,
    });
    if (save) dialog.set_do_overwrite_confirmation(true);
    for (const key of filters) {
        const [label, setup] = FILTERS[key];
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
export function askSaveChanges(parent, documentName) {
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

export function showError(parent, message) {
    const dialog = new Gtk.MessageDialog({
        transient_for: parent, modal: true, message_type: Gtk.MessageType.ERROR,
        buttons: Gtk.ButtonsType.CLOSE, text: message,
    });
    dialog.run();
    dialog.destroy();
}

export function showAbout(parent) {
    const dialog = new Gtk.AboutDialog({
        transient_for: parent, modal: true, program_name: APP_NAME, version: APP_VERSION,
        logo_icon_name: 'accessories-text-editor',
        comments: 'Editor Markdown ala Typora dengan GTK 3 dan GJS.',
    });
    dialog.run();
    dialog.destroy();
}
