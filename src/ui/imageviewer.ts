// Penampil gambar dengan zoom: jendela terpisah untuk melihat gambar lebih besar.
//
//   roda mouse            zoom di titik penunjuk
//   + / −                 zoom masuk / keluar
//   0                     ukuran asli (100%)
//   F                     pas layar
//   klik ganda            bergantian antara pas layar dan 100%
//   drag                  geser gambar
//   Esc                   tutup
//
// Gambar digambar dengan cairo pada skala zoom, bukan dibuatkan salinan yang
// diperbesar, jadi zoom 800% pada foto besar tidak menghabiskan memori.

import Gtk from 'gi://Gtk?version=3.0';
import Gdk from 'gi://Gdk?version=3.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import cairo from 'cairo';

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 8;
export const ZOOM_STEP = 1.25;

export const clampZoom = (zoom: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

// Zoom agar seluruh gambar muat di area (imageW × imageH) → (viewW × viewH).
export const fitZoom = (imageW: number, imageH: number, viewW: number, viewH: number): number =>
    Math.min(viewW / imageW, viewH / imageH);

// 'fit-cap': pas layar tapi tidak diperbesar melebihi 100% (keadaan awal);
// 'fit': pas layar, boleh diperbesar; 'manual': zoom diatur pengguna.
type Mode = 'fit-cap' | 'fit' | 'manual';

// Titik gambar (ix, iy) yang harus tetap berada di posisi (vx, vy) pada area tampilan saat zoom.
interface Focus { ix: number; iy: number; vx: number; vy: number }

export class ImageViewer {
    readonly window: Gtk.Window;
    readonly area: Gtk.DrawingArea;
    zoom = 1;
    closed = false;

    private mode: Mode = 'fit-cap';
    private readonly scroller: Gtk.ScrolledWindow;
    private readonly percent: Gtk.Label;
    private drag: { x: number; y: number; h: number; v: number } | null = null;

    constructor(parent: Gtk.Window | null, private readonly pixbuf: GdkPixbuf.Pixbuf, title: string) {
        const width = pixbuf.get_width(), height = pixbuf.get_height();

        this.window = new Gtk.Window({
            transient_for: parent, modal: true, window_position: Gtk.WindowPosition.CENTER_ON_PARENT,
            ...this.initialSize(parent, width, height),
        });
        const header = new Gtk.HeaderBar({ show_close_button: true, title, subtitle: `${width} × ${height} px` });
        this.window.set_titlebar(header);

        // Tidak bisa difokuskan: tombol ditangani di tingkat jendela, dan fokus hanya menambah garis putus-putus di sekitar gambar.
        this.area = new Gtk.DrawingArea({ halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, can_focus: false });
        this.area.add_events(Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.BUTTON_RELEASE_MASK
            | Gdk.EventMask.POINTER_MOTION_MASK | Gdk.EventMask.SCROLL_MASK);
        this.area.connect('draw', (_area, cr) => this.draw(cr));
        this.area.connect('button-press-event', (_area, ev) => this.onPress(ev as unknown as Gdk.Event));
        this.area.connect('motion-notify-event', (_area, ev) => this.onMotion(ev as unknown as Gdk.Event));
        this.area.connect('button-release-event', () => this.endDrag());
        // Gulir di atas gambar: zoom di titik penunjuk.
        this.area.connect('scroll-event', (_area, ev) => this.onScroll(ev as unknown as Gdk.Event, true));

        this.scroller = new Gtk.ScrolledWindow({ hexpand: true, vexpand: true, can_focus: false });
        this.scroller.add(this.area);
        this.scroller.get_style_context().add_class('image-viewer');
        this.scroller.add_events(Gdk.EventMask.SCROLL_MASK);
        // Gulir di margin sekitar gambar: zoom di tengah.
        this.scroller.connect('scroll-event', (_s, ev) => this.onScroll(ev as unknown as Gdk.Event, false));
        this.scroller.connect('size-allocate', () => this.refit());

        this.percent = new Gtk.Label({ width_chars: 5 });
        const button = (label: string, tooltip: string, run: () => void) => {
            const b = new Gtk.Button({ label, tooltip_text: tooltip });
            b.connect('clicked', run);
            return b;
        };
        const bar = new Gtk.Box({ spacing: 6, margin: 6, halign: Gtk.Align.CENTER });
        bar.pack_start(button('−', 'Perkecil (−)', () => this.zoomOut()), false, false, 0);
        bar.pack_start(this.percent, false, false, 0);
        bar.pack_start(button('+', 'Perbesar (+)', () => this.zoomIn()), false, false, 0);
        bar.pack_start(button('Pas', 'Pas layar (F)', () => this.fit()), false, false, 8);
        bar.pack_start(button('100%', 'Ukuran asli (0)', () => this.actual()), false, false, 0);

        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        box.pack_start(this.scroller, true, true, 0);
        box.pack_start(bar, false, false, 0);
        this.window.add(box);

        this.window.connect('key-press-event', (_w, ev) => this.handleKey((ev as unknown as Gdk.Event).get_keyval()[1]));
        this.window.connect('destroy', () => { this.closed = true; });
        this.applyZoom(1);
    }

    // Gambar kecil: seukuran gambar; gambar besar: hampir memenuhi jendela induk.
    private initialSize(parent: Gtk.Window | null, width: number, height: number): { default_width: number; default_height: number } {
        const [pw, ph] = parent?.get_size() ?? [1000, 700];
        return {
            default_width: Math.max(480, Math.min(width + 40, Math.floor(pw * 0.9))),
            default_height: Math.max(360, Math.min(height + 140, Math.floor(ph * 0.9))),
        };
    }

    show(): void {
        this.window.show_all();
    }

    close(): void {
        this.window.destroy();
    }

    // ---------- Zoom ----------

    // Ukuran area yang tersedia untuk gambar (tanpa bilah alat).
    private viewport(): [number, number] {
        return [this.scroller.get_allocated_width(), this.scroller.get_allocated_height()];
    }

    // Menyesuaikan zoom dengan ukuran jendela selama masih dalam mode pas layar.
    private refit(): void {
        if (this.mode === 'manual') return;
        const [vw, vh] = this.viewport();
        if (vw <= 1 || vh <= 1) return;
        const fit = fitZoom(this.pixbuf.get_width(), this.pixbuf.get_height(), vw, vh);
        const zoom = clampZoom(this.mode === 'fit-cap' ? Math.min(1, fit) : fit);
        if (Math.abs(zoom - this.zoom) > 1e-6) this.applyZoom(zoom);
    }

    // Pergeseran gambar di dalam area tampilan: gambar yang lebih kecil dari area diletakkan di tengah.
    private offset(zoom: number): [number, number] {
        const [vw, vh] = this.viewport();
        return [
            Math.max(0, (vw - this.pixbuf.get_width() * zoom) / 2),
            Math.max(0, (vh - this.pixbuf.get_height() * zoom) / 2),
        ];
    }

    private focusAtCenter(): Focus {
        const [vw, vh] = this.viewport();
        const [ox, oy] = this.offset(this.zoom);
        return {
            ix: (this.scroller.get_hadjustment().get_value() + vw / 2 - ox) / this.zoom,
            iy: (this.scroller.get_vadjustment().get_value() + vh / 2 - oy) / this.zoom,
            vx: vw / 2, vy: vh / 2,
        };
    }

    // (x, y): posisi penunjuk di dalam area gambar.
    private focusAtPoint(x: number, y: number): Focus {
        const [ox, oy] = this.offset(this.zoom);
        return {
            ix: x / this.zoom, iy: y / this.zoom,
            vx: x + ox - this.scroller.get_hadjustment().get_value(),
            vy: y + oy - this.scroller.get_vadjustment().get_value(),
        };
    }

    private applyZoom(zoom: number, focus: Focus = this.focusAtCenter()): void {
        this.zoom = clampZoom(zoom);
        const w = Math.round(this.pixbuf.get_width() * this.zoom), h = Math.round(this.pixbuf.get_height() * this.zoom);
        this.area.set_size_request(w, h);
        this.percent.label = `${Math.round(this.zoom * 100)}%`;
        this.area.queue_draw();

        // Ukuran baru baru berlaku setelah tata letak, jadi atur posisi gulir sesudahnya.
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (this.closed) return GLib.SOURCE_REMOVE;
            const [ox, oy] = this.offset(this.zoom);
            this.scroller.get_hadjustment().set_value(focus.ix * this.zoom + ox - focus.vx);
            this.scroller.get_vadjustment().set_value(focus.iy * this.zoom + oy - focus.vy);
            return GLib.SOURCE_REMOVE;
        });
    }

    zoomIn(focus?: Focus): void {
        this.mode = 'manual';
        this.applyZoom(this.zoom * ZOOM_STEP, focus);
    }

    zoomOut(focus?: Focus): void {
        this.mode = 'manual';
        this.applyZoom(this.zoom / ZOOM_STEP, focus);
    }

    actual(): void {
        this.mode = 'manual';
        this.applyZoom(1);
    }

    fit(): void {
        this.mode = 'fit';
        this.refit();
    }

    // ---------- Gambar dan masukan ----------

    private draw(cr: cairo.Context): boolean {
        cr.scale(this.zoom, this.zoom);
        Gdk.cairo_set_source_pixbuf(cr, this.pixbuf, 0, 0);
        // Diperbesar banyak: tampilkan piksel apa adanya, bukan dikaburkan.
        // Tipe cairo di @girs tidak memuat Pattern.setFilter, padahal ada saat runtime GJS.
        const source = cr.getSource() as unknown as { setFilter(filter: number): void };
        source.setFilter(this.zoom >= 3 ? cairo.Filter.NEAREST : cairo.Filter.GOOD);
        cr.paint();
        cr.$dispose();
        return false;
    }

    // true = tombol sudah ditangani.
    handleKey(keyval: number): boolean {
        switch (keyval) {
            case Gdk.KEY_Escape: this.close(); return true;
            case Gdk.KEY_plus: case Gdk.KEY_equal: case Gdk.KEY_KP_Add: this.zoomIn(); return true;
            case Gdk.KEY_minus: case Gdk.KEY_KP_Subtract: this.zoomOut(); return true;
            case Gdk.KEY_0: case Gdk.KEY_KP_0: this.actual(); return true;
            case Gdk.KEY_f: case Gdk.KEY_F: this.fit(); return true;
            default: return false;
        }
    }

    // overImage: peristiwa berasal dari area gambar, jadi koordinatnya bisa dipakai sebagai titik zoom.
    private onScroll(ev: Gdk.Event, overImage: boolean): boolean {
        const [, x, y] = ev.get_coords();
        const focus = overImage ? this.focusAtPoint(x, y) : undefined;
        const direction = ev.get_scroll_direction()[1];
        if (direction === Gdk.ScrollDirection.UP) this.zoomIn(focus);
        else if (direction === Gdk.ScrollDirection.DOWN) this.zoomOut(focus);
        else if (direction === Gdk.ScrollDirection.SMOOTH) {
            const dy = ev.get_scroll_deltas()[2];
            if (dy === 0) return true;
            this.mode = 'manual';
            this.applyZoom(this.zoom * Math.pow(1.1, -dy), focus);
        } else return false;
        return true;
    }

    private onPress(ev: Gdk.Event): boolean {
        if (ev.get_button()[1] !== 1) return false;
        if (ev.get_event_type() === Gdk.EventType.DOUBLE_BUTTON_PRESS) {
            // Klik ganda: bergantian antara pas layar dan ukuran asli.
            if (this.mode !== 'manual' && Math.abs(this.zoom - 1) > 1e-6) this.actual();
            else this.fit();
            this.endDrag();
            return true;
        }
        const [, x, y] = ev.get_root_coords();
        this.drag = { x, y, h: this.scroller.get_hadjustment().get_value(), v: this.scroller.get_vadjustment().get_value() };
        return true;
    }

    private onMotion(ev: Gdk.Event): boolean {
        if (!this.drag) return false;
        const [, x, y] = ev.get_root_coords();
        this.scroller.get_hadjustment().set_value(this.drag.h - (x - this.drag.x));
        this.scroller.get_vadjustment().set_value(this.drag.v - (y - this.drag.y));
        return true;
    }

    private endDrag(): boolean {
        this.drag = null;
        return true;
    }
}
