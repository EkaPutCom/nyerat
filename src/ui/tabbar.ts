// Baris tab dokumen di atas editor: Adw.TabBar yang menampilkan Adw.TabView, dan hanya terlihat
// jika ada dua dokumen atau lebih (autohide). Isi dokumen tidak ada di TabView; tiap halamannya
// hanya penanda, karena editor dan papan kanban dipilih oleh Gtk.Stack milik jendela.
// Tab tidak tahu isi dokumen; jendela yang menyuplai judul dan status "belum disimpan".

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';

export class TabBar {
    readonly widget: Adw.TabBar;
    onSelect: (id: number) => void = () => {};
    onClose: (id: number) => void = () => {};

    private readonly view = new Adw.TabView();
    private readonly pages = new Map<number, Adw.TabPage>();
    private readonly ids_ = new Map<Adw.TabPage, number>();
    private syncing = false;
    private removing: Adw.TabPage | null = null;

    constructor() {
        this.widget = new Adw.TabBar({ view: this.view, autohide: true });
        this.view.connect('notify::selected-page', () => {
            const id = this.view.selected_page && this.ids_.get(this.view.selected_page);
            if (!this.syncing && id !== null && id !== undefined) this.onSelect(id);
        });
        // Tombol tutup di tab hanya meminta; jendela yang memutuskan (mungkin bertanya dulu) lalu memanggil remove().
        this.view.connect('close-page', (_view, page) => {
            if (page === this.removing) {
                this.view.close_page_finish(page, true);
            } else {
                this.view.close_page_finish(page, false);
                const id = this.ids_.get(page);
                if (id !== undefined) this.onClose(id);
            }
            return true;
        });
    }

    get count(): number {
        return this.view.n_pages;
    }

    add(id: number, title: string): void {
        this.syncing = true;
        const page = this.view.append(new Gtk.Box());
        this.syncing = false;
        page.title = title;
        this.pages.set(id, page);
        this.ids_.set(page, id);
    }

    remove(id: number): void {
        const page = this.pages.get(id);
        if (!page) return;
        this.pages.delete(id);
        this.ids_.delete(page);
        this.removing = page;
        this.syncing = true;   // TabView memilih tab tetangga sendiri; jendela yang menentukan tab aktif
        this.view.close_page(page);
        this.syncing = false;
        this.removing = null;
    }

    setTitle(id: number, title: string, tooltip: string | null = null): void {
        const page = this.pages.get(id);
        if (!page) return;
        page.title = title;
        page.tooltip = tooltip ?? '';
    }

    setActive(id: number): void {
        const page = this.pages.get(id);
        if (!page) return;
        this.syncing = true;
        this.view.selected_page = page;
        this.syncing = false;
    }

    // Urutan tab dari kiri ke kanan (pengguna bisa menyeretnya).
    ids(): number[] {
        const result: number[] = [];
        for (let i = 0; i < this.view.n_pages; i++) result.push(this.ids_.get(this.view.get_nth_page(i))!);
        return result;
    }
}
