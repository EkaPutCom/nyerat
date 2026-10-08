// Row of document tabs above the editor: an Adw.TabBar showing an Adw.TabView, visible only
// when there are two or more documents (autohide). The document contents are not in the TabView; each page is
// only a marker, because the editor and the kanban board are chosen by the window's own Gtk.Stack.
// Tabs do not know the document contents; the window supplies the title and the "unsaved" status.

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Gio from 'gi://Gio';

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
        // The tab's close button only requests; the window decides (it may ask first) and then calls remove().
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
        this.syncing = true;   // TabView picks a neighboring tab by itself; the window decides the active tab
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

    // Symbolic icon in front of the title (e.g. Home); null = no icon like a document tab.
    setIcon(id: number, icon: string | null): void {
        const page = this.pages.get(id);
        if (page) page.icon = icon ? Gio.ThemedIcon.new(icon) : null;
    }

    setActive(id: number): void {
        const page = this.pages.get(id);
        if (!page) return;
        this.syncing = true;
        this.view.selected_page = page;
        this.syncing = false;
    }

    // Tab order from left to right (the user can drag them).
    ids(): number[] {
        const result: number[] = [];
        for (let i = 0; i < this.view.n_pages; i++) result.push(this.ids_.get(this.view.get_nth_page(i))!);
        return result;
    }
}
