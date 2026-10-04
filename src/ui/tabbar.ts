// Baris tab dokumen di atas editor. Hanya tampil jika ada dua dokumen atau lebih, jadi
// pemakaian satu dokumen tidak berubah. Tab tidak tahu isi dokumen; jendela yang
// menyuplai judul dan status "belum disimpan".

import Gtk from 'gi://Gtk?version=3.0';

interface Tab {
    id: number;
    box: Gtk.Box;
    button: Gtk.ToggleButton;
    label: Gtk.Label;
}

export class TabBar {
    readonly widget: Gtk.Revealer;
    onSelect: (id: number) => void = () => {};
    onClose: (id: number) => void = () => {};

    private readonly row: Gtk.Box;
    private readonly scroller: Gtk.ScrolledWindow;
    private tabs: Tab[] = [];
    private active = -1;
    private syncing = false;

    constructor() {
        this.row = new Gtk.Box({ spacing: 2, margin_start: 6, margin_end: 6, margin_top: 4, margin_bottom: 4 });
        // Bar gulir bawaan tidak dipakai (tinggi bilah tab tetap); roda mouse tetap menggulir.
        this.scroller = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.EXTERNAL, vscrollbar_policy: Gtk.PolicyType.NEVER, hexpand: true });
        this.scroller.add(this.row);
        const wrap = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        wrap.get_style_context().add_class('tabbar');
        wrap.pack_start(this.scroller, false, false, 0);
        wrap.pack_start(new Gtk.Separator(), false, false, 0);
        this.widget = new Gtk.Revealer({ transition_type: Gtk.RevealerTransitionType.SLIDE_DOWN, transition_duration: 100 });
        this.widget.add(wrap);
        wrap.show_all();
    }

    get count(): number {
        return this.tabs.length;
    }

    add(id: number, title: string): void {
        const button = new Gtk.ToggleButton({ relief: Gtk.ReliefStyle.NONE, focus_on_click: false });
        const label = new Gtk.Label({ label: title, ellipsize: 3, max_width_chars: 22, xalign: 0 });
        button.add(label);
        button.connect('toggled', () => {
            if (this.syncing) return;
            // Mengklik tab yang sudah aktif tidak boleh mematikannya.
            if (id === this.active) button.set_active(true);
            else this.onSelect(id);
        });
        const close = Gtk.Button.new_from_icon_name('window-close-symbolic', Gtk.IconSize.MENU);
        close.set_relief(Gtk.ReliefStyle.NONE);
        close.set_focus_on_click(false);
        close.set_tooltip_text('Tutup tab (Ctrl+W)');
        close.get_style_context().add_class('tab-close');
        close.connect('clicked', () => this.onClose(id));
        const box = new Gtk.Box();
        box.get_style_context().add_class('tab');
        box.pack_start(button, true, true, 0);
        box.pack_start(close, false, false, 0);
        box.show_all();
        this.row.pack_start(box, false, false, 0);
        this.tabs.push({ id, box, button, label });
        this.refresh();
    }

    remove(id: number): void {
        const tab = this.tabs.find(t => t.id === id);
        if (!tab) return;
        this.tabs = this.tabs.filter(t => t !== tab);
        tab.box.destroy();
        this.refresh();
    }

    setTitle(id: number, title: string, tooltip: string | null = null): void {
        const tab = this.tabs.find(t => t.id === id);
        if (!tab) return;
        tab.label.set_text(title);
        tab.button.set_tooltip_text(tooltip);
    }

    setActive(id: number): void {
        this.active = id;
        this.syncing = true;
        for (const t of this.tabs) t.button.set_active(t.id === id);
        this.syncing = false;
        const tab = this.tabs.find(t => t.id === id);
        if (tab) this.scrollTo(tab);
    }

    // Urutan tab dari kiri ke kanan.
    ids(): number[] {
        return this.tabs.map(t => t.id);
    }

    private refresh(): void {
        this.widget.set_reveal_child(this.tabs.length > 1);
    }

    private scrollTo(tab: Tab): void {
        const adj = this.scroller.get_hadjustment();
        const alloc = tab.box.get_allocation();
        if (alloc.width <= 1) return;   // belum dialokasikan
        if (alloc.x < adj.get_value()) adj.set_value(alloc.x);
        else if (alloc.x + alloc.width > adj.get_value() + adj.get_page_size()) adj.set_value(alloc.x + alloc.width - adj.get_page_size());
    }
}
