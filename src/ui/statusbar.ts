// Bilah status di bawah editor.
//   kiri:  mode aktif, atau pesan singkat ("Tersimpan") selama 2,5 detik
//   kanan: jumlah kata/karakter dan posisi kursor

import Gtk from 'gi://Gtk?version=3.0';
import GLib from 'gi://GLib';

export class StatusBar {
    readonly left: Gtk.Label;
    readonly right: Gtk.Label;
    readonly widget: Gtk.Box;

    private counts = '';
    private cursor = '';
    private modes = '';
    private toastId = 0;

    constructor() {
        this.left = new Gtk.Label({ xalign: 0 });
        this.right = new Gtk.Label({ xalign: 1, hexpand: true });
        this.widget = new Gtk.Box({ spacing: 12 });
        this.widget.get_style_context().add_class('statusbar');
        this.widget.pack_start(this.left, false, false, 0);
        this.widget.pack_end(this.right, true, true, 0);
    }

    setCounts(text: string): void {
        // Simbol Markdown tidak dihitung sebagai kata.
        const words = (text.match(/[^\s#>*_`~=|-]+/g) || []).length;
        this.counts = `${words} kata   ${Array.from(text).length} karakter`;
        this.render();
    }

    setCursor(line: number, column: number): void {
        this.cursor = `Baris ${line + 1}, Kolom ${column + 1}`;
        this.render();
    }

    setModes(names: string[]): void {
        this.modes = names.length ? `Mode: ${names.join(' · ')}` : '';
        if (!this.toastId) this.left.label = this.modes;
    }

    toast(message: string): void {
        this.left.label = message;
        if (this.toastId) GLib.source_remove(this.toastId);
        this.toastId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500, () => {
            this.toastId = 0;
            this.left.label = this.modes;
            return GLib.SOURCE_REMOVE;
        });
    }

    private render(): void {
        this.right.label = `${this.counts}   ${this.cursor}`;
    }
}
