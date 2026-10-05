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
//
// Posisi overlay memakai koordinat buffer; GtkTextViewChild menguranginya dengan offset gulir
// saat mengalokasikan. Tetapi di GTK 4.14 offset itu hanya diperbarui di size_allocate milik
// TextView (gtk_text_view_child_set_offset), dan menggulir tidak mengalokasikan ulang TextView:
// overlay tetap di letak lama (gambar "hilang", tabel melayang) sampai ada hal lain yang memicu
// alokasi. Karena itu setiap adjustment bergulir slot meminta alokasi ulang TextView (supaya
// set_offset() terpanggil) sekaligus wadah overlay-nya (tanpa itu GTK melewati alokasi wadah
// yang ukurannya tidak berubah, dan overlay tidak dipindahkan).

import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
import { removeChildren } from '../gtkutil.js';

export class OverlaySlots {
    private readonly free: Gtk.Box[] = [];
    private container: Gtk.Widget | null = null;   // GtkTextViewChild, induk semua overlay
    private adjustments: Gtk.Adjustment[] = [];
    private queued = 0;
    private destroyed = false;

    constructor(private readonly view: Gtk.TextView) {
        view.connect('notify::vadjustment', () => this.watch());
        view.connect('notify::hadjustment', () => this.watch());
        this.watch();
    }

    private watch(): void {
        const adjs = [this.view.get_vadjustment(), this.view.get_hadjustment()].filter((a): a is Gtk.Adjustment => !!a);
        for (const adj of adjs) {
            if (this.adjustments.includes(adj)) continue;
            // Langsung, supaya widget pindah di frame yang sama dengan teksnya; lalu sekali lagi
            // di idle: gulir dari scroll_to_iter() diterapkan TextView di tengah alokasinya, dan
            // permintaan alokasi saat itu bisa terlewat untuk frame tersebut.
            adj.connect('value-changed', () => {
                this.reallocate();
                this.queueReallocate();
            });
        }
        this.adjustments = adjs;
    }

    private queueReallocate(): void {
        if (this.queued) return;
        this.queued = GLib.idle_add(GLib.PRIORITY_HIGH_IDLE, () => {
            this.queued = 0;
            if (!this.destroyed) this.reallocate();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Alokasikan ulang TextView dan wadah overlay supaya overlay mengikuti offset gulir terbaru.
    // Tanpa overlay tidak ada yang perlu dipindahkan.
    private reallocate(): void {
        if (!this.container) return;
        this.view.queue_allocate();
        this.container.queue_allocate();
    }

    // Editor ditutup: hentikan alokasi ulang yang tertunda.
    destroy(): void {
        this.destroyed = true;
        if (this.queued) GLib.source_remove(this.queued);
        this.queued = 0;
    }

    // Taruh slot di (x, y) koordinat buffer.
    place(slot: Gtk.Box, x: number, y: number): void {
        this.view.move_overlay(slot, x, y);
    }

    // Slot kosong yang terlihat, belum diposisikan (pemanggil memakai place()).
    acquire(): Gtk.Box {
        const slot = this.free.pop();
        if (slot) {
            slot.set_visible(true);
            return slot;
        }
        const fresh = new Gtk.Box();
        this.view.add_overlay(fresh, 0, 0);
        this.container = fresh.get_parent();
        return fresh;
    }

    release(slot: Gtk.Box): void {
        removeChildren(slot);
        slot.set_visible(false);
        this.free.push(slot);
    }
}
