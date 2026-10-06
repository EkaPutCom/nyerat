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

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import cairo from 'cairo';
import { onKeyPress, pack } from '../gtkutil.js';

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
    private drag: { h: number; v: number } | null = null;
    private pointer: [number, number] | null = null;   // posisi penunjuk di atas gambar

    constructor(parent: Gtk.Window | null, private readonly pixbuf: GdkPixbuf.Pixbuf, title: string) {
        const width = pixbuf.get_width(), height = pixbuf.get_height();

        this.window = new Gtk.Window({
            transient_for: parent, modal: true, title,
            ...this.initialSize(parent, width, height),
        });
        const header = new Adw.HeaderBar();
        const titles = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER });
        for (const [text, css] of [[title, 'title'], [`${width} × ${height} px`, 'subtitle']]) {
            const label = new Gtk.Label({ label: text, ellipsize: 3 });
            label.add_css_class(css);
            titles.append(label);
        }
        header.set_title_widget(titles);
        this.window.set_titlebar(header);

        // Tidak bisa difokuskan: tombol ditangani di tingkat jendela, dan fokus hanya menambah garis putus-putus di sekitar gambar.
        this.area = new Gtk.DrawingArea({ halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, can_focus: false });
        this.area.set_draw_func((_area, cr) => this.draw(cr));
        const motion = new Gtk.EventControllerMotion();
        motion.connect('motion', (_m, x, y) => { this.pointer = [x, y]; });
        motion.connect('leave', () => { this.pointer = null; });
        this.area.add_controller(motion);
        const click = new Gtk.GestureClick({ button: 1 });
        click.connect('pressed', (_g, count) => { if (count === 2) this.doubleClick(); });
        this.area.add_controller(click);

        this.scroller = new Gtk.ScrolledWindow({ hexpand: true, vexpand: true, can_focus: false });
        this.scroller.set_child(this.area);
        this.scroller.add_css_class('image-viewer');
        // Roda mouse: zoom di titik penunjuk jika di atas gambar, kalau tidak di tengah. Fase
        // CAPTURE supaya ScrolledWindow tidak menggulirnya.
        const scroll = new Gtk.EventControllerScroll({ flags: Gtk.EventControllerScrollFlags.VERTICAL, propagation_phase: Gtk.PropagationPhase.CAPTURE });
        scroll.connect('scroll', (c, _dx, dy) => this.scrollZoom(dy, c.get_unit() === Gdk.ScrollUnit.WHEEL, this.pointer));
        this.scroller.add_controller(scroll);
        // Drag di ScrolledWindow (yang tidak ikut bergeser), bukan di gambar: pergeserannya
        // tidak terpengaruh gulir yang sedang dilakukannya.
        const drag = new Gtk.GestureDrag({ button: 1 });
        drag.connect('drag-begin', () => this.beginDrag());
        drag.connect('drag-update', (_g, dx, dy) => this.dragBy(dx, dy));
        drag.connect('drag-end', () => this.endDrag());
        this.scroller.add_controller(drag);
        // Ukuran area tampilan berubah (page_size adjustment) → sesuaikan zoom pas layar.
        this.scroller.get_hadjustment().connect('notify::page-size', () => this.refit());
        this.scroller.get_vadjustment().connect('notify::page-size', () => this.refit());

        this.percent = new Gtk.Label({ width_chars: 5 });
        const button = (label: string, tooltip: string, run: () => void) => {
            const b = new Gtk.Button({ label, tooltip_text: tooltip });
            b.connect('clicked', run);
            return b;
        };
        const bar = new Gtk.Box({ spacing: 6, margin_top: 6, margin_bottom: 6, margin_start: 6, margin_end: 6, halign: Gtk.Align.CENTER });
        bar.append(button('−', 'Perkecil (−)', () => this.zoomOut()));
        bar.append(this.percent);
        bar.append(button('+', 'Perbesar (+)', () => this.zoomIn()));
        bar.append(button('Pas', 'Pas layar (F)', () => this.fit()));
        bar.append(button('100%', 'Ukuran asli (0)', () => this.actual()));

        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        pack(box, this.scroller, true);
        box.append(bar);
        this.window.set_child(box);

        onKeyPress(this.window, keyval => this.handleKey(keyval));
        // Jendela dihancurkan (GTK 4 tidak memancarkan "destroy" selama objeknya dipegang JavaScript).
        this.window.connect('unrealize', () => { this.closed = true; });
        this.applyZoom(1);
    }

    // Gambar kecil: seukuran gambar; gambar besar: hampir memenuhi jendela induk.
    private initialSize(parent: Gtk.Window | null, width: number, height: number): { default_width: number; default_height: number } {
        const [pw, ph] = parent ? [parent.get_width(), parent.get_height()] : [1000, 700];
        return {
            default_width: Math.max(480, Math.min(width + 40, Math.floor(pw * 0.9))),
            default_height: Math.max(360, Math.min(height + 140, Math.floor(ph * 0.9))),
        };
    }

    show(): void {
        this.window.present();
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

    private draw(cr: cairo.Context): void {
        cr.scale(this.zoom, this.zoom);
        Gdk.cairo_set_source_pixbuf(cr, this.pixbuf, 0, 0);
        // Diperbesar banyak: tampilkan piksel apa adanya, bukan dikaburkan.
        // Tipe cairo di @girs tidak memuat Pattern.setFilter, padahal ada saat runtime GJS.
        const source = cr.getSource() as unknown as { setFilter(filter: number): void };
        source.setFilter(this.zoom >= 3 ? cairo.Filter.NEAREST : cairo.Filter.GOOD);
        cr.paint();
        cr.$dispose();
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

    // Roda mouse sebesar dy (ke atas negatif). wheel = langkah roda biasa (zoom per ZOOM_STEP);
    // selain itu gulir halus touchpad. point = posisi penunjuk di atas gambar, atau null (zoom di tengah).
    scrollZoom(dy: number, wheel: boolean, point: [number, number] | null): boolean {
        if (dy === 0) return true;
        const focus = point ? this.focusAtPoint(point[0], point[1]) : undefined;
        this.mode = 'manual';
        this.applyZoom(this.zoom * (wheel ? Math.pow(ZOOM_STEP, -dy) : Math.pow(1.1, -dy)), focus);
        return true;
    }

    // Klik ganda: bergantian antara pas layar dan ukuran asli.
    doubleClick(): void {
        if (this.mode !== 'manual' && Math.abs(this.zoom - 1) > 1e-6) this.actual();
        else this.fit();
        this.endDrag();
    }

    beginDrag(): void {
        this.drag = { h: this.scroller.get_hadjustment().get_value(), v: this.scroller.get_vadjustment().get_value() };
    }

    // (dx, dy): pergeseran penunjuk sejak beginDrag(). false = tidak sedang drag.
    dragBy(dx: number, dy: number): boolean {
        if (!this.drag) return false;
        this.scroller.get_hadjustment().set_value(this.drag.h - dx);
        this.scroller.get_vadjustment().set_value(this.drag.v - dy);
        return true;
    }

    endDrag(): boolean {
        this.drag = null;
        return true;
    }
}
