// Sidebar kiri dengan tiga tab: Berkas (pohon folder), Outline (daftar heading), dan Riwayat (git).
// Sidebar sendiri tidak tahu isi tabnya; keduanya diberikan oleh jendela.

import Gtk from 'gi://Gtk?version=3.0';

export type SidebarPage = 'files' | 'outline' | 'history';

export class Sidebar {
    readonly widget: Gtk.Revealer;
    readonly stack: Gtk.Stack;
    onPageChanged: (page: SidebarPage) => void = () => {};

    constructor(files: Gtk.Widget, outline: Gtk.Widget, history: Gtk.Widget) {
        this.stack = new Gtk.Stack({ transition_type: Gtk.StackTransitionType.CROSSFADE, transition_duration: 100, vexpand: true });
        this.stack.add_titled(files, 'files', 'Berkas');
        this.stack.add_titled(outline, 'outline', 'Outline');
        this.stack.add_titled(history, 'history', 'Riwayat');
        this.stack.connect('notify::visible-child-name', () => this.onPageChanged(this.page));

        const switcher = new Gtk.StackSwitcher({ stack: this.stack, halign: Gtk.Align.CENTER, margin: 10, margin_start: 4, margin_end: 4 });
        // Tiga tab harus muat di lebar sidebar; tombol yang terlalu lebar menaikkan lebar minimum jendela.
        switcher.get_style_context().add_class('sidebar-tabs');

        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, width_request: 240 });
        box.get_style_context().add_class('sidebar');
        box.pack_start(switcher, false, false, 0);
        box.pack_start(this.stack, true, true, 0);
        const wrap = new Gtk.Box();
        wrap.pack_start(box, true, true, 0);
        wrap.pack_start(new Gtk.Separator({ orientation: Gtk.Orientation.VERTICAL }), false, false, 0);

        this.widget = new Gtk.Revealer({ transition_type: Gtk.RevealerTransitionType.SLIDE_RIGHT, transition_duration: 150 });
        this.widget.add(wrap);
    }

    get page(): SidebarPage {
        return this.stack.visible_child_name as SidebarPage;
    }

    setPage(page: SidebarPage): void {
        this.stack.visible_child_name = page;
    }

    get visible(): boolean {
        return this.widget.reveal_child;
    }

    setVisible(visible: boolean): void {
        this.widget.set_reveal_child(visible);
    }
}
