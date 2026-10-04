// Pembantu tes GUI untuk GTK 4: tangkapan layar widget, menelusuri anak widget, dan memicu
// klik tanpa mouse sungguhan. Juga dipakai scripts/capture.ts.

import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Graphene from 'gi://Graphene';
import GdkX11 from 'gi://GdkX11?version=4.0';
import type GdkPixbuf from 'gi://GdkPixbuf';

// Tangkapan layar widget. GTK 4 tidak lagi memberi GdkWindow yang bisa dibaca pikselnya
// (gdk_pixbuf_get_from_window); widget digambar ulang lewat GtkWidgetPaintable lalu
// dirender jadi tekstur oleh renderer jendelanya.
export function widgetPixbuf(widget: Gtk.Widget): GdkPixbuf.Pixbuf | null {
    // Ukuran intrinsik paintable, bukan get_width(): jendela CSD lebih besar beberapa piksel
    // (bingkainya), dan menggambarnya ke ukuran widget menyusutkan gambar sehingga garis 1 px hilang.
    const paintable = new Gtk.WidgetPaintable({ widget });
    const width = paintable.get_intrinsic_width(), height = paintable.get_intrinsic_height();
    const renderer = widget.get_native()?.get_renderer();
    if (!renderer || width <= 0 || height <= 0) return null;
    const snapshot = new Gtk.Snapshot();
    paintable.snapshot(snapshot, width, height);
    const node = snapshot.to_node();
    if (!node) return null;
    const viewport = new Graphene.Rect().init(0, 0, width, height);
    return Gdk.pixbuf_get_from_texture(renderer.render_texture(node, viewport));
}

// Semua keturunan widget (tanpa widget itu sendiri), urut kedalaman lebih dulu.
export function descendants(root: Gtk.Widget): Gtk.Widget[] {
    const result: Gtk.Widget[] = [];
    for (let child = root.get_first_child(); child; child = child.get_next_sibling()) result.push(child, ...descendants(child));
    return result;
}

// Picu klik tombol `button` pada widget lewat GestureClick-nya, seolah GTK menerima klik di (x, y).
// count = klik ke berapa (2 = klik ganda). Melempar jika widget tidak punya penerima klik itu.
export function emitClick(widget: Gtk.Widget, count = 1, x = 1, y = 1, button = 1): void {
    const controllers = widget.observe_controllers();
    for (let i = 0; i < controllers.get_n_items(); i++) {
        const c = controllers.get_item(i);
        if (c instanceof Gtk.GestureClick && c.get_button() === button) {
            c.emit('pressed', count, x, y);
            return;
        }
    }
    throw new Error(`widget ${widget.constructor.name} tidak punya GestureClick tombol ${button}`);
}

// Baris ListBox (tanpa placeholder, yang di GTK 4 juga anak ListBox).
export function listRows(list: Gtk.ListBox): Gtk.ListBoxRow[] {
    const rows: Gtk.ListBoxRow[] = [];
    for (let row = list.get_row_at_index(0); row; row = list.get_row_at_index(rows.length)) rows.push(row);
    return rows;
}

// Titik (x, y) pada widget dalam koordinat layar X11, untuk menggerakkan pointer XTest ke sana.
// GTK 4 tidak memberi posisi jendela di layar; posisinya ditanyakan ke server X lewat `toRoot`
// (MouseInput.toRoot) dengan XID permukaan jendelanya.
export function screenPoint(widget: Gtk.Widget, x: number, y: number, toRoot: (xid: number, x: number, y: number) => [number, number]): [number, number] {
    const native = widget.get_native();
    if (!native) throw new Error('widget belum berada di jendela');
    const [valid, nx, ny] = widget.translate_coordinates(native, x, y);
    if (!valid) throw new Error('koordinat widget tidak bisa diterjemahkan');
    // Jendela GTK 4 bisa berbayang (CSD): widget jendela tidak berada di pojok permukaannya.
    const [sx, sy] = native.get_surface_transform();
    const surface = native.get_surface();
    if (!(surface instanceof GdkX11.X11Surface)) throw new Error('tes mouse membutuhkan GDK_BACKEND=x11');
    // Tipe @girs menyebut xlib.Window; saat runtime XID berupa angka.
    return toRoot(surface.get_xid() as unknown as number, nx + sx, ny + sy);
}

// Hitung tekan/gerak/lepas tombol mouse yang sampai ke widget (sebelum ditangani anak/handler lain).
export function countPointerEvents(widget: Gtk.Widget): { presses: number; motions: number; releases: number; stop(): void } {
    const counts = { presses: 0, motions: 0, releases: 0, stop: () => widget.remove_controller(legacy) };
    const legacy = new Gtk.EventControllerLegacy({ propagation_phase: Gtk.PropagationPhase.CAPTURE });
    legacy.connect('event', (_c, event) => {
        const kind = event.get_event_type();
        if (kind === Gdk.EventType.BUTTON_PRESS) counts.presses++;
        if (kind === Gdk.EventType.MOTION_NOTIFY) counts.motions++;
        if (kind === Gdk.EventType.BUTTON_RELEASE) counts.releases++;
        return false;
    });
    widget.add_controller(legacy);
    return counts;
}
