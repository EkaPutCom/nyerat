// Widget slots attached above the text (images, tables, diagrams) with add_overlay().
//
// GTK 4.14 cannot remove overlay children of a GtkTextView: gtk_text_view_remove() only
// knows edge children and anchored children, so calling it for an overlay
// ends with "GtkBox is not a child of GtkSourceView" and the widget stays attached.
// That is why each layer borrows a slot (an empty Box that is already an overlay) and
// returns it when its block is discarded: its contents are emptied, the slot is hidden, and then
// reused by the next block. Number of slots = the largest number of blocks ever shown.
//
// Click receivers are attached to the slot contents, not to the slot itself, so they do not carry over to another block.
//
// Overlay positions use buffer coordinates; GtkTextViewChild subtracts the scroll offset
// when allocating. But in GTK 4.14 that offset is only updated in the TextView's own size_allocate
// (gtk_text_view_child_set_offset), and scrolling does not reallocate the TextView:
// overlays stay at their old position (images "vanish", tables float) until something else triggers an
// allocation. That is why every scrolling adjustment makes the slot request a reallocation of the TextView (so that
// set_offset() is called) as well as of the overlay container (without it GTK skips allocating a container
// whose size did not change, and the overlays are not moved).

import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
import { removeChildren } from '../gtkutil.js';

export class OverlaySlots {
    private readonly free: Gtk.Box[] = [];
    private container: Gtk.Widget | null = null;   // GtkTextViewChild, the parent of all overlays
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
            // Immediately, so the widget moves in the same frame as its text; then once more
            // in idle: the scroll from scroll_to_iter() is applied by the TextView in the middle of its allocation, and
            // the allocation request made then can be missed for that frame.
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

    // Reallocate the TextView and the overlay container so overlays follow the latest scroll offset.
    // Without overlays there is nothing to move.
    private reallocate(): void {
        if (!this.container) return;
        this.view.queue_allocate();
        this.container.queue_allocate();
    }

    // Editor closed: stop the pending reallocation.
    destroy(): void {
        this.destroyed = true;
        if (this.queued) GLib.source_remove(this.queued);
        this.queued = 0;
    }

    // Taruh slot di (x, y) koordinat buffer.
    place(slot: Gtk.Box, x: number, y: number): void {
        this.view.move_overlay(slot, x, y);
        slot.set_opacity(1);
    }

    // An empty visible slot, not yet positioned (the caller uses place()).
    // Transparent until the first place(): a new overlay sits at (0, 0) and, without this,
    // the image/table would flash in the top-left corner before being moved to its line.
    acquire(): Gtk.Box {
        const slot = this.free.pop();
        if (slot) {
            slot.set_opacity(0);
            slot.set_visible(true);
            return slot;
        }
        const fresh = new Gtk.Box();
        fresh.set_opacity(0);
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
