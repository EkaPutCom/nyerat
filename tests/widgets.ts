// Helpers for GTK 4 GUI tests: widget screenshots, walking widget children, and triggering
// clicks without a real mouse. Also used by scripts/capture.ts.

import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Graphene from 'gi://Graphene';
import GdkX11 from 'gi://GdkX11?version=4.0';
import type GdkPixbuf from 'gi://GdkPixbuf';

// Widget screenshot. GTK 4 no longer gives a GdkWindow whose pixels can be read
// (gdk_pixbuf_get_from_window); the widget is redrawn through a GtkWidgetPaintable and then
// rendered into a texture by its window's renderer.
export function widgetPixbuf(widget: Gtk.Widget): GdkPixbuf.Pixbuf | null {
    // The paintable's intrinsic size, not get_width(): a CSD window is a few pixels larger
    // (its frame), and drawing it at the widget size shrinks the image so 1 px lines disappear.
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

// All descendants of a widget (without the widget itself), depth first.
export function descendants(root: Gtk.Widget): Gtk.Widget[] {
    const result: Gtk.Widget[] = [];
    for (let child = root.get_first_child(); child; child = child.get_next_sibling()) result.push(child, ...descendants(child));
    return result;
}

// Trigger a click of button `button` on a widget through its GestureClick, as if GTK received a click at (x, y).
// count = which click it is (2 = double click). Throws if the widget has no such click receiver.
export function emitClick(widget: Gtk.Widget, count = 1, x = 1, y = 1, button = 1): void {
    const controllers = widget.observe_controllers();
    for (let i = 0; i < controllers.get_n_items(); i++) {
        const c = controllers.get_item(i);
        if (c instanceof Gtk.GestureClick && c.get_button() === button) {
            c.emit('pressed', count, x, y);
            return;
        }
    }
    throw new Error(`widget ${widget.constructor.name} has no GestureClick for button ${button}`);
}

// ListBox rows (without the placeholder, which in GTK 4 is also a child of the ListBox).
export function listRows(list: Gtk.ListBox): Gtk.ListBoxRow[] {
    const rows: Gtk.ListBoxRow[] = [];
    for (let row = list.get_row_at_index(0); row; row = list.get_row_at_index(rows.length)) rows.push(row);
    return rows;
}

// The point (x, y) on a widget in X11 screen coordinates, to move the XTest pointer there.
// GTK 4 gives no window position on screen; the position is asked from the X server through `toRoot`
// (MouseInput.toRoot) with the XID of the window's surface.
export function screenPoint(widget: Gtk.Widget, x: number, y: number, toRoot: (xid: number, x: number, y: number) => [number, number]): [number, number] {
    const native = widget.get_native();
    if (!native) throw new Error('the widget is not in a window yet');
    const [valid, nx, ny] = widget.translate_coordinates(native, x, y);
    if (!valid) throw new Error('the widget coordinates cannot be translated');
    // A GTK 4 window can have a shadow (CSD): the window widget is not at the corner of its surface.
    const [sx, sy] = native.get_surface_transform();
    const surface = native.get_surface();
    if (!(surface instanceof GdkX11.X11Surface)) throw new Error('mouse tests require GDK_BACKEND=x11');
    // The @girs types say xlib.Window; at runtime the XID is a number.
    return toRoot(surface.get_xid() as unknown as number, nx + sx, ny + sy);
}

// Count the mouse button press/motion/release that reach the widget (before being handled by children/other handlers).
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

// Run `act` on a modal dialog once it can take an answer. libadwaita 1.5 drops a close that arrives before the
// dialog has been drawn twice after it is mapped, including the close that follows a button response: the dialog
// then stays the window's visible dialog forever and covers the window for every later test. On a busy machine a
// fixed delay is not enough, so this polls from a timer (it also works while the caller waits in settle()) and asks
// for frames so the count advances. Gives up after `timeoutMs`.
export function whenDialogReady(find: () => Adw.Dialog | null, act: (dialog: Adw.Dialog) => void, timeoutMs = 5000): void {
    const start = GLib.get_monotonic_time();
    let dialog: Adw.Dialog | null = null, mappedAt = -1;
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
        if ((GLib.get_monotonic_time() - start) / 1000 > timeoutMs) return GLib.SOURCE_REMOVE;
        dialog ??= find();
        const clock = dialog?.get_mapped() ? dialog.get_frame_clock() : null;
        if (!dialog || !clock) return GLib.SOURCE_CONTINUE;
        if (mappedAt < 0) mappedAt = clock.get_frame_counter();
        if (clock.get_frame_counter() < mappedAt + 2) {
            dialog.queue_draw();
            return GLib.SOURCE_CONTINUE;
        }
        act(dialog);
        return GLib.SOURCE_REMOVE;
    });
}
