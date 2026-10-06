// Sidebar kiri dengan tiga tab: Berkas (pohon folder), Outline (daftar heading), dan Riwayat (git).
// Sidebar sendiri tidak tahu isi tabnya; keduanya diberikan oleh jendela.
// Dibungkus Adw.OverlaySplitView: sidebar selebar tetap di kiri, sisanya untuk konten.

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import { _ } from '../i18n.js';

export type SidebarPage = 'files' | 'outline' | 'history';

export class Sidebar {
    readonly widget: Adw.OverlaySplitView;
    readonly panel: Gtk.Box;
    readonly stack: Gtk.Stack;
    onPageChanged: (page: SidebarPage) => void = () => {};

    constructor(files: Gtk.Widget, outline: Gtk.Widget, history: Gtk.Widget) {
        this.stack = new Gtk.Stack({ transition_type: Gtk.StackTransitionType.CROSSFADE, transition_duration: 100, vexpand: true });
        this.stack.add_titled(files, 'files', _('Berkas'));
        this.stack.add_titled(outline, 'outline', _('Outline'));
        this.stack.add_titled(history, 'history', _('Riwayat'));
        this.stack.connect('notify::visible-child-name', () => this.onPageChanged(this.page));

        const switcher = new Gtk.StackSwitcher({ stack: this.stack, halign: Gtk.Align.CENTER, margin_top: 10, margin_bottom: 10, margin_start: 4, margin_end: 4 });
        // Tiga tab harus muat di lebar sidebar; tombol yang terlalu lebar menaikkan lebar minimum jendela.
        switcher.add_css_class('sidebar-tabs');

        this.panel = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        this.panel.add_css_class('sidebar');
        this.panel.append(switcher);
        this.panel.append(this.stack);

        // Lebar tetap 240: isi sidebar (judul, kolom isian) tidak boleh membuatnya mengembang.
        this.widget = new Adw.OverlaySplitView({
            sidebar: this.panel, min_sidebar_width: 240, max_sidebar_width: 240,
            enable_show_gesture: false, enable_hide_gesture: false,
        });
    }

    setContent(content: Gtk.Widget): void {
        this.widget.set_content(content);
    }

    get page(): SidebarPage {
        return this.stack.visible_child_name as SidebarPage;
    }

    setPage(page: SidebarPage): void {
        this.stack.visible_child_name = page;
    }

    get visible(): boolean {
        return this.widget.show_sidebar;
    }

    setVisible(visible: boolean): void {
        this.widget.set_show_sidebar(visible);
    }
}
