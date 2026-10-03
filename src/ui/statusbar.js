// Bilah status di bawah editor.
//   kiri:  mode aktif, atau pesan singkat ("Tersimpan") selama 2,5 detik
//   kanan: jumlah kata/karakter dan posisi kursor

import Gtk from 'gi://Gtk?version=3.0';
import GLib from 'gi://GLib';

export class StatusBar {
    constructor() {
        this._counts = '';
        this._cursor = '';
        this._modes = '';
        this._toastId = 0;

        this.left = new Gtk.Label({ xalign: 0 });
        this.right = new Gtk.Label({ xalign: 1, hexpand: true });
        this.widget = new Gtk.Box({ spacing: 12 });
        this.widget.get_style_context().add_class('statusbar');
        this.widget.pack_start(this.left, false, false, 0);
        this.widget.pack_end(this.right, true, true, 0);
    }

    setCounts(text) {
        // Simbol Markdown tidak dihitung sebagai kata.
        const words = (text.match(/[^\s#>*_`~=|-]+/g) || []).length;
        this._counts = `${words} kata   ${Array.from(text).length} karakter`;
        this._render();
    }

    setCursor(line, column) {
        this._cursor = `Baris ${line + 1}, Kolom ${column + 1}`;
        this._render();
    }

    setModes(names) {
        this._modes = names.length ? `Mode: ${names.join(' · ')}` : '';
        if (!this._toastId) this.left.label = this._modes;
    }

    toast(message) {
        this.left.label = message;
        if (this._toastId) GLib.source_remove(this._toastId);
        this._toastId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500, () => {
            this._toastId = 0;
            this.left.label = this._modes;
            return GLib.SOURCE_REMOVE;
        });
    }

    _render() {
        this.right.label = `${this._counts}   ${this._cursor}`;
    }
}
