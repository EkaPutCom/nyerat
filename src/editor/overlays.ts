// Slot widget yang ditempel di atas teks (gambar, tabel, diagram) dengan add_overlay().
//
// GTK 4.14 tidak bisa melepas anak overlay GtkTextView: gtk_text_view_remove() hanya
// mengenal anak di tepi dan anak yang berjangkar, sehingga memanggilnya untuk overlay
// berakhir dengan "GtkBox is not a child of GtkSourceView" dan widgetnya tetap terpasang.
// Karena itu tiap lapisan meminjam slot (Box kosong yang sudah menjadi overlay) dan
// mengembalikannya saat bloknya dibuang: isinya dikosongkan, slotnya disembunyikan, lalu
// dipakai lagi oleh blok berikutnya. Jumlah slot = jumlah blok terbanyak yang pernah tampil.
//
// Penerima klik dipasang di isi slot, bukan di slotnya, supaya tidak ikut terbawa ke blok lain.

import Gtk from 'gi://Gtk?version=4.0';
import { removeChildren } from '../gtkutil.js';

export class OverlaySlots {
    private readonly free: Gtk.Box[] = [];

    constructor(private readonly view: Gtk.TextView) {}

    // Slot kosong yang terlihat, belum diposisikan (pemanggil memakai move_overlay()).
    acquire(): Gtk.Box {
        const slot = this.free.pop();
        if (slot) {
            slot.set_visible(true);
            return slot;
        }
        const fresh = new Gtk.Box();
        this.view.add_overlay(fresh, 0, 0);
        return fresh;
    }

    release(slot: Gtk.Box): void {
        removeChildren(slot);
        slot.set_visible(false);
        this.free.push(slot);
    }
}
