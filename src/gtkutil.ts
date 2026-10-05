// Pembantu kecil untuk API GTK 4 yang dipakai di semua lapisan (editor, ui, jendela).
// Tidak meng-import modul proyek lain, jadi boleh dipakai dari mana saja.

import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';

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

// Jalankan main loop bersarang sampai `start` memanggil finish(nilai), lalu kembalikan nilainya.
// GTK 4 menghapus gtk_dialog_run(); ini menggantikannya supaya dialog modal tetap bisa
// dipakai seperti fungsi biasa (pemanggil langsung mendapat jawabannya).
export function runModal<T>(start: (finish: (value: T) => void) => void): T {
    let result!: T;
    let done = false;
    const loop = GLib.MainLoop.new(null, false);
    start(value => {
        if (done) return;
        done = true;
        result = value;
        loop.quit();
    });
    if (!done) loop.run();
    return result;
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
