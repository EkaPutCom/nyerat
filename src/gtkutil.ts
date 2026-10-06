// Pembantu kecil untuk API GTK 4 yang dipakai di semua lapisan (editor, ui, jendela).
// Tidak meng-import modul proyek lain, jadi boleh dipakai dari mana saja.

import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';

// Iter di awal baris `line`. GTK 4 mengembalikan [ok, iter]; jika baris di luar dokumen,
// iter-nya tetap diisi akhir buffer (perilaku yang sama dengan GTK 3).
export function iterAtLine(buffer: Gtk.TextBuffer, line: number): Gtk.TextIter {
    return buffer.get_iter_at_line(line)[1];
}

// Anak langsung sebuah widget, urut dari pertama. GTK 4 tidak punya get_children().
export function childrenOf(widget: Gtk.Widget): Gtk.Widget[] {
    const result: Gtk.Widget[] = [];
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) result.push(child);
    return result;
}

interface Container {
    remove(child: Gtk.Widget): void;
}

// Lepaskan widget dari induknya (pengganti destroy() GTK 3 untuk widget anak). Induk yang
// punya remove() (Box, Grid, ListBox, TextView, Stack, ...) dipakai supaya data internalnya
// ikut diperbarui; selain itu widget dilepas langsung.
export function removeWidget(widget: Gtk.Widget): void {
    const parent = widget.get_parent();
    if (!parent) return;
    if (parent instanceof Gtk.ListBoxRow || parent instanceof Gtk.FlowBoxChild) {
        // Baris ListBox/FlowBox dibuang bersama barisnya, bukan hanya isinya.
        removeWidget(parent);
        return;
    }
    if (typeof (parent as unknown as Partial<Container>).remove === 'function') (parent as unknown as Container).remove(widget);
    else widget.unparent();
}

// Kosongkan wadah dari semua anaknya. Placeholder ListBox juga anaknya di GTK 4, dan
// remove_all() GTK 4.14 ikut membuangnya; karena itu ListBox dikosongkan per baris.
export function removeChildren(widget: Gtk.Widget): void {
    if (widget instanceof Gtk.ListBox) {
        for (let row = widget.get_row_at_index(0); row; row = widget.get_row_at_index(0)) widget.remove(row);
        return;
    }
    for (const child of childrenOf(widget)) removeWidget(child);
}

// Nilai yang mungkin baru tersedia nanti: dialog asli mengembalikan Promise, tiruannya di tes nilai biasa.
export type Awaitable<T> = T | Promise<T>;

// Dialog modal tanpa main loop bersarang (GTK 4 sengaja menghapus gtk_dialog_run(): main loop di dalam
// handler membuat kode lain berjalan di tengah-tengah handler itu). `start` menampilkan dialog dan memanggil
// finish(nilai) sekali saat dijawab; panggilan berikutnya diabaikan.
export function modal<T>(start: (finish: (value: T) => void) => void): Promise<T> {
    return new Promise(resolve => {
        let done = false;
        start(value => {
            if (done) return;
            done = true;
            resolve(value);
        });
    });
}

// Lanjutkan dengan nilai yang mungkin masih Promise. Nilai biasa (tiruan dialog di tes, atau jalur yang
// tidak perlu bertanya) diproses seketika sehingga hasilnya juga sinkron; Promise diproses setelah selesai.
export function after<T, R>(value: Awaitable<T>, next: (value: T) => Awaitable<R>): Awaitable<R> {
    return value instanceof Promise ? value.then(next) : next(value);
}

// Klik tombol mouse pada widget (pengganti sinyal button-press-event). `handler` menerima
// jumlah klik beruntun (2 = klik ganda), posisi, dan modifier; true = klik ditangani dan
// tidak diteruskan ke widget di bawahnya.
export function onClick(widget: Gtk.Widget, handler: (count: number, x: number, y: number, state: number) => boolean | void, button = 1): Gtk.GestureClick {
    const gesture = new Gtk.GestureClick({ button });
    gesture.connect('pressed', (g, count, x, y) => {
        if (handler(count, x, y, g.get_current_event_state()) === true) g.set_state(Gtk.EventSequenceState.CLAIMED);
    });
    widget.add_controller(gesture);
    return gesture;
}

// Tombol keyboard ditekan saat widget (atau anaknya) berfokus. true = sudah ditangani.
export function onKeyPress(widget: Gtk.Widget, handler: (keyval: number, state: number) => boolean, phase = Gtk.PropagationPhase.BUBBLE): Gtk.EventControllerKey {
    const controller = new Gtk.EventControllerKey({ propagation_phase: phase });
    controller.connect('key-pressed', (_c, keyval, _code, state) => handler(keyval, state));
    widget.add_controller(controller);
    return controller;
}

// Pengganti gtk_box_pack_start() GTK 3: tambahkan child di akhir box. expand = child mengambil
// sisa ruang searah orientasi box (GTK 4 memakai hexpand/vexpand milik child).
export function pack(box: Gtk.Box, child: Gtk.Widget, expand = false): void {
    if (expand) {
        if (box.get_orientation() === Gtk.Orientation.HORIZONTAL) child.set_hexpand(true);
        else child.set_vexpand(true);
    }
    box.append(child);
}

// Isi Gtk.Template dari berkas .ui yang dibundel sebagai teks (`import xml from './x.ui?raw'`).
export const uiTemplate = (xml: string): Uint8Array => new TextEncoder().encode(xml);

// Pixbuf → Gdk.Texture. Gtk.Picture.new_for_pixbuf() dan Gdk.Texture.new_for_pixbuf() sudah usang
// (GTK 4.12/4.20); data piksel pixbuf (RGB/RGBA 8 bit, tanpa premultiply) disalin apa adanya.
export function textureFromPixbuf(pixbuf: GdkPixbuf.Pixbuf): Gdk.Texture {
    const format = pixbuf.get_has_alpha() ? Gdk.MemoryFormat.R8G8B8A8 : Gdk.MemoryFormat.R8G8B8;
    return Gdk.MemoryTexture.new(pixbuf.get_width(), pixbuf.get_height(), format, pixbuf.read_pixel_bytes(), pixbuf.get_rowstride());
}

// Gdk.Texture → pixbuf RGBA, pengganti Gdk.pixbuf_get_from_texture() yang usang sejak GTK 4.12.
export function pixbufFromTexture(texture: Gdk.Texture): GdkPixbuf.Pixbuf {
    const downloader = Gdk.TextureDownloader.new(texture);
    downloader.set_format(Gdk.MemoryFormat.R8G8B8A8);
    const [bytes, stride] = downloader.download_bytes();
    return GdkPixbuf.Pixbuf.new_from_bytes(bytes, GdkPixbuf.Colorspace.RGB, true, 8, texture.get_width(), texture.get_height(), stride);
}

// Saat dijalankan dari dist/ (belum dipasang), ikon aplikasi ada di dist/icons (disalin vite.config.ts),
// bukan di tema hicolor sistem. Aman dipanggil berulang: jalur yang sudah ada tidak ditambahkan lagi.
export function addBundledIcons(display: Gdk.Display): void {
    let dir = Gio.File.new_for_uri(import.meta.url).get_parent();
    if (dir && !dir.get_child('icons').query_exists(null)) dir = dir.get_parent();   // dari dist/chunks/
    const icons = dir?.get_child('icons');
    if (!icons?.query_exists(null)) return;
    const theme = Gtk.IconTheme.get_for_display(display);
    if (!theme.get_search_path()?.includes(icons.get_path()!)) theme.add_search_path(icons.get_path()!);
}
