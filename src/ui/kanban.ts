// Tampilan papan kanban ala Trello untuk dokumen kanban (markdown/kanban.ts).
//
//   ┌ Rencana ───┐ ┌ Dikerjakan ┐ ┌ Selesai ───┐
//   │ ☐ kartu    │ │ ☐ kartu    │ │ ☑ kartu    │   seret kartu antar daftar,
//   │ ☐ kartu    │ │            │ │            │   klik untuk menyunting,
//   │ + Tambah   │ │ + Tambah   │ │ + Tambah   │   klik kanan untuk menu
//   └────────────┘ └────────────┘ └────────────┘   + Tambah daftar
//
// Komponen ini hanya memegang model papan dan tampilannya. Setiap perubahan lewat
// commit(), yang mengganti model dan memanggil onChange; jendela yang menulis
// hasilnya ke buffer dokumen (satu-satunya sumber kebenaran adalah teks Markdown).
//
// Menyeret memakai penunjuk sendiri (tekan → gerak → lepas pada kartu), bukan
// drag-and-drop bawaan GTK, supaya perilakunya terkendali dan bisa diuji dengan
// event tiruan: kartu bayangan mengikuti penunjuk, dan penanda tujuan menunjukkan
// di mana kartu akan jatuh.

import Gtk from 'gi://Gtk?version=3.0';
import Gdk from 'gi://Gdk?version=3.0';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import {
    addCard, addColumn, cardMeta, deleteCard, deleteColumn, dropIndex, dueStatus, moveCard, moveColumn,
    newBoard, renameColumn, toggleDone, updateCard, type Board, type Position,
} from '../markdown/kanban.js';
import { cellMarkup, type MarkupColors } from '../markdown/pango.js';
import { confirmDialog, editCardDialog, promptDialog, type CardDraft } from './dialogs.js';
import type { Palette } from './theme.js';

const COLUMN_WIDTH = 290;
const DRAG_THRESHOLD = 6;     // piksel penunjuk bergerak sebelum klik dianggap menyeret
const EDGE = 48;              // jarak dari tepi (piksel) yang memicu gulir otomatis saat menyeret
const SCROLL_SPEED = 14;
const TAG_COLORS = 8;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

// Bagian dari Gdk.Event yang dipakai penanganan penunjuk (memudahkan tes membuat event tiruan).
export type PointerEvent = Pick<Gdk.Event, 'get_coords' | 'get_root_coords'>;
export type PressEvent = PointerEvent & Pick<Gdk.Event, 'get_button'>;

// Dialog bisa diganti (misalnya di tes) karena dialog asli menahan program sampai ditutup.
export interface BoardDialogs {
    editCard(parent: Gtk.Window | null, card: CardDraft): CardDraft | null;
    prompt(parent: Gtk.Window | null, options: { title: string; label: string; value?: string }): string | null;
    confirm(parent: Gtk.Window | null, message: string, detail?: string): boolean;
}

export interface ColumnView {
    box: Gtk.Box;
    scroller: Gtk.ScrolledWindow;
    cardsBox: Gtk.Box;
    cards: Gtk.EventBox[];
    footer: Gtk.Stack;
}

interface PressState {
    column: number;
    index: number;
    widget: Gtk.EventBox;
    rootX: number;
    rootY: number;
    localX: number;
    localY: number;
}

interface DragState {
    from: Position;
    widget: Gtk.EventBox;
    ghost: Gtk.Window | null;
    placeholder: Gtk.Box;
    target: Position;
    pointer: [number, number];   // posisi penunjuk di koordinat papan
    timer: number;
}

type Adding = { kind: 'card'; column: number } | { kind: 'list' } | null;

export class KanbanBoard {
    readonly widget: Gtk.ScrolledWindow;
    columns: ColumnView[] = [];
    onChange: (board: Board) => void = () => {};
    dialogs: BoardDialogs = { editCard: editCardDialog, prompt: promptDialog, confirm: confirmDialog };
    today: () => string = () => GLib.DateTime.new_now_local().format('%Y-%m-%d') ?? '';

    private board: Board = newBoard([]);
    private readonly row: Gtk.Box;
    private colors: MarkupColors = { code: '#c7254e', codeBg: '#f3f4f4', link: '#4183c4', mark: '#fff3a3' };
    private adding: Adding = null;
    private renderQueued = false;
    private press: PressState | null = null;
    private drag: DragState | null = null;

    constructor() {
        // Jarak ke tepi lewat padding CSS (.kanban-row), bukan margin widget: margin jatuh di luar
        // alokasi widget dan tidak dicat oleh viewport, sehingga tampil hitam.
        this.row = new Gtk.Box({ spacing: 14, valign: Gtk.Align.FILL });
        this.row.get_style_context().add_class('kanban-row');
        this.widget = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.AUTOMATIC, vscrollbar_policy: Gtk.PolicyType.NEVER, hexpand: true, vexpand: true, can_focus: false });
        this.widget.get_style_context().add_class('kanban-board');
        this.widget.add(this.row);
    }

    // ---------- Model ----------

    getBoard(): Board {
        return this.board;
    }

    // Ganti papan (misalnya dokumen dibuka atau undo) tanpa memanggil onChange.
    setBoard(board: Board): void {
        this.board = board;
        if (this.adding?.kind === 'card' && this.adding.column >= board.columns.length) this.adding = null;
        this.render();
    }

    // Terapkan perubahan dari pengguna: ganti model, gambar ulang, dan beri tahu pemilik.
    commit(next: Board): void {
        if (next === this.board) return;
        this.board = next;
        this.queueRender();
        this.onChange(next);
    }

    setPalette(palette: Palette): void {
        this.colors = { code: palette.codeFg, codeBg: palette.codeBg, link: palette.accent, mark: palette.markBg };
        this.render();
    }

    private get parent(): Gtk.Window | null {
        const top = this.widget.get_toplevel();
        return top instanceof Gtk.Window ? top : null;
    }

    // ---------- Menggambar ----------

    // Digambar ulang di idle: perubahan sering datang dari dalam penanganan klik widget yang
    // akan dihancurkan, dan beberapa perubahan beruntun cukup digambar sekali.
    queueRender(): void {
        if (this.renderQueued) return;
        this.renderQueued = true;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.renderQueued = false;
            this.render();
            return GLib.SOURCE_REMOVE;
        });
    }

    render(): void {
        this.cancelDrag();
        this.press = null;
        const h = this.widget.get_hadjustment().get_value();
        const v = this.columns.map(c => c.scroller.get_vadjustment().get_value());
        for (const child of this.row.get_children()) child.destroy();

        this.columns = this.board.columns.map((_, c) => this.buildColumn(c));
        for (const col of this.columns) this.row.pack_start(col.box, false, false, 0);
        this.row.pack_start(this.buildAddList(), false, false, 0);
        this.row.show_all();

        // Posisi gulir baru berlaku setelah tata letak.
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.widget.get_hadjustment().set_value(h);
            this.columns.forEach((col, c) => col.scroller.get_vadjustment().set_value(v[c] ?? 0));
            this.focusAddEntry();
            return GLib.SOURCE_REMOVE;
        });
    }

    private buildColumn(c: number): ColumnView {
        const column = this.board.columns[c];
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, width_request: COLUMN_WIDTH, vexpand: true });
        box.get_style_context().add_class('kanban-column');

        // Judul: klik ganda untuk mengganti nama.
        const title = new Gtk.Label({ label: column.title, xalign: 0, ellipsize: Pango.EllipsizeMode.END, hexpand: true });
        title.get_style_context().add_class('kanban-column-title');
        const titleBox = new Gtk.EventBox({ visible_window: false });
        titleBox.add(title);
        titleBox.set_tooltip_text('Klik ganda untuk mengganti nama');
        titleBox.connect('button-press-event', (_w, ev) => {
            if ((ev as unknown as Gdk.Event).get_event_type() !== Gdk.EventType.DOUBLE_BUTTON_PRESS) return false;
            this.renameColumnPrompt(c);
            return true;
        });
        const count = new Gtk.Label({ label: String(column.cards.length) });
        count.get_style_context().add_class('kanban-count');
        const more = new Gtk.Button({ label: '⋯', relief: Gtk.ReliefStyle.NONE, tooltip_text: 'Menu daftar' });
        more.connect('clicked', () => this.columnMenu(c).popup_at_widget(more, Gdk.Gravity.SOUTH_WEST, Gdk.Gravity.NORTH_WEST, null));
        const header = new Gtk.Box({ spacing: 6 });
        header.pack_start(titleBox, true, true, 0);
        header.pack_start(count, false, false, 0);
        header.pack_start(more, false, false, 0);
        box.pack_start(header, false, false, 0);

        const cardsBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 });
        const scroller = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vscrollbar_policy: Gtk.PolicyType.AUTOMATIC, vexpand: true });
        scroller.add(cardsBox);
        const cards = column.cards.map((_, i) => this.buildCard(c, i));
        for (const card of cards) cardsBox.pack_start(card, false, false, 0);
        box.pack_start(scroller, true, true, 0);

        const footer = this.buildAddCard(c);
        box.pack_start(footer, false, false, 0);
        return { box, scroller, cardsBox, cards, footer };
    }

    private buildCard(c: number, i: number): Gtk.EventBox {
        const card = this.board.columns[c].cards[i];
        const meta = cardMeta(card.text);

        const widget = new Gtk.EventBox({ visible_window: true });
        const style = widget.get_style_context();
        style.add_class('kanban-card');
        if (card.done) style.add_class('kanban-card-done');

        const check = new Gtk.CheckButton({ active: card.done === true, valign: Gtk.Align.START, tooltip_text: 'Tandai selesai' });
        check.connect('toggled', () => this.commit(toggleDone(this.board, { column: c, index: i })));
        const label = new Gtk.Label({ use_markup: true, xalign: 0, wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR, hexpand: true, width_chars: 10 });
        label.get_style_context().add_class('kanban-card-text');
        const markup = cellMarkup(meta.title, this.colors);
        label.set_markup(card.done ? `<s>${markup}</s>` : markup);
        const top = new Gtk.Box({ spacing: 8 });
        top.pack_start(check, false, false, 0);
        top.pack_start(label, true, true, 0);

        const inner = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
        inner.pack_start(top, false, false, 0);
        const badges = this.buildBadges(card.notes.length > 0, meta.tags, meta.due);
        if (badges) inner.pack_start(badges, false, false, 0);
        widget.add(inner);

        widget.add_events(Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.BUTTON_RELEASE_MASK | Gdk.EventMask.POINTER_MOTION_MASK);
        widget.connect('button-press-event', (_w, ev) => this.onCardPress(c, i, widget, ev as unknown as Gdk.Event));
        widget.connect('motion-notify-event', (_w, ev) => this.onCardMotion(ev as unknown as Gdk.Event));
        widget.connect('button-release-event', (_w, ev) => this.onCardRelease(ev as unknown as Gdk.Event));
        return widget;
    }

    private buildBadges(hasNotes: boolean, tags: string[], due: string | null): Gtk.Box | null {
        if (!hasNotes && !tags.length && !due) return null;
        const row = new Gtk.Box({ spacing: 4 });
        const chip = (text: string, ...classes: string[]) => {
            const label = new Gtk.Label({ label: text });
            for (const cls of ['kanban-chip', ...classes]) label.get_style_context().add_class(cls);
            row.pack_start(label, false, false, 0);
        };
        for (const tag of tags) chip(`#${tag}`, `kanban-tag-${this.tagColor(tag)}`);
        if (due) chip(`📅 ${this.formatDue(due)}`, 'kanban-due', `kanban-due-${dueStatus(due, this.today())}`);
        if (hasNotes) chip('≡', 'kanban-notes');
        return row;
    }

    // Warna tag tetap untuk tag yang sama.
    tagColor(tag: string): number {
        let hash = 0;
        for (const ch of tag) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
        return hash % TAG_COLORS;
    }

    // "2026-10-20" → "20 Okt" (dengan tahun jika bukan tahun ini).
    formatDue(due: string): string {
        const [y, m, d] = due.split('-').map(Number);
        const sameYear = this.today().startsWith(`${y}-`);
        return `${d} ${MONTHS[m - 1]}${sameYear ? '' : ` ${y}`}`;
    }

    // ---------- Tambah kartu dan daftar ----------

    private entryRow(placeholder: string, add: (text: string) => void, cancel: () => void): { box: Gtk.Box; entry: Gtk.Entry } {
        const entry = new Gtk.Entry({ placeholder_text: placeholder, hexpand: true });
        entry.connect('activate', () => { if (entry.text.trim()) add(entry.text); });
        entry.connect('key-press-event', (_w, ev) => {
            if ((ev as unknown as Gdk.Event).get_keyval()[1] !== Gdk.KEY_Escape) return false;
            cancel();
            return true;
        });
        const ok = new Gtk.Button({ label: 'Tambah' });
        ok.connect('clicked', () => { if (entry.text.trim()) add(entry.text); });
        const close = new Gtk.Button({ label: '✕', relief: Gtk.ReliefStyle.NONE, tooltip_text: 'Batal (Esc)' });
        close.connect('clicked', cancel);
        const box = new Gtk.Box({ spacing: 4 });
        box.pack_start(entry, true, true, 0);
        box.pack_start(ok, false, false, 0);
        box.pack_start(close, false, false, 0);
        return { box, entry };
    }

    private buildAddCard(c: number): Gtk.Stack {
        const stack = new Gtk.Stack();
        const button = new Gtk.Button({ label: '+ Tambah kartu', relief: Gtk.ReliefStyle.NONE, halign: Gtk.Align.FILL });
        (button.get_child() as Gtk.Label).xalign = 0;
        button.get_style_context().add_class('kanban-add');
        button.connect('clicked', () => this.showAddCard(c));
        const { box, entry } = this.entryRow('Judul kartu…', text => this.commit(addCard(this.board, c, text)), () => this.hideAdd());
        entry.set_name(`kanban-entry-${c}`);
        stack.add_named(button, 'button');
        stack.add_named(box, 'entry');
        stack.show_all();   // Gtk.Stack hanya mau menampilkan anak yang sudah visible
        stack.visible_child_name = this.adding?.kind === 'card' && this.adding.column === c ? 'entry' : 'button';
        return stack;
    }

    private buildAddList(): Gtk.Box {
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, width_request: COLUMN_WIDTH, valign: Gtk.Align.START });
        box.get_style_context().add_class('kanban-add-list');
        const button = new Gtk.Button({ label: '+ Tambah daftar', relief: Gtk.ReliefStyle.NONE });
        button.connect('clicked', () => this.showAddList());
        const { box: entryBox, entry } = this.entryRow('Nama daftar…', text => this.commit(addColumn(this.board, text)), () => this.hideAdd());
        entry.set_name('kanban-entry-list');
        const stack = new Gtk.Stack();
        stack.add_named(button, 'button');
        stack.add_named(entryBox, 'entry');
        stack.show_all();
        stack.visible_child_name = this.adding?.kind === 'list' ? 'entry' : 'button';
        box.pack_start(stack, false, false, 0);
        return box;
    }

    showAddCard(column: number): void {
        this.adding = { kind: 'card', column };
        this.queueRender();
    }

    showAddList(): void {
        this.adding = { kind: 'list' };
        this.queueRender();
    }

    hideAdd(): void {
        this.adding = null;
        this.queueRender();
    }

    // Kolom isian yang sedang terbuka diberi fokus (setelah digambar ulang pun tetap terbuka,
    // supaya beberapa kartu bisa ditambahkan beruntun).
    private focusAddEntry(): void {
        if (!this.adding) return;
        const name = this.adding.kind === 'list' ? 'kanban-entry-list' : `kanban-entry-${this.adding.column}`;
        const entry = this.findByName(this.row, name);
        entry?.grab_focus();
        if (this.adding.kind === 'card') {
            const scroller = this.columns[this.adding.column]?.scroller;
            const adj = scroller?.get_vadjustment();
            adj?.set_value(adj.get_upper());
        }
    }

    private findByName(root: Gtk.Widget, name: string): Gtk.Widget | null {
        if (root.get_name() === name) return root;
        if (!(root instanceof Gtk.Container)) return null;
        for (const child of root.get_children()) {
            const found = this.findByName(child, name);
            if (found) return found;
        }
        return null;
    }

    // ---------- Sunting ----------

    editCard(column: number, index: number): void {
        const card = this.board.columns[column]?.cards[index];
        if (!card) return;
        const result = this.dialogs.editCard(this.parent, { text: card.text, notes: card.notes });
        if (result?.text) this.commit(updateCard(this.board, { column, index }, { text: result.text, notes: result.notes }));
    }

    renameColumnPrompt(column: number): void {
        const current = this.board.columns[column]?.title;
        if (current === undefined) return;
        const name = this.dialogs.prompt(this.parent, { title: 'Ganti Nama Daftar', label: 'Nama daftar', value: current });
        if (name) this.commit(renameColumn(this.board, column, name));
    }

    deleteColumnConfirm(column: number): void {
        const col = this.board.columns[column];
        if (!col) return;
        const detail = col.cards.length ? `${col.cards.length} kartu di dalamnya ikut terhapus.` : undefined;
        if (this.dialogs.confirm(this.parent, `Hapus daftar “${col.title}”?`, detail)) this.commit(deleteColumn(this.board, column));
    }

    // ---------- Menu ----------

    private menuItem(menu: Gtk.Menu, label: string, run: () => void, enabled = true): Gtk.MenuItem {
        const item = new Gtk.MenuItem({ label, sensitive: enabled });
        item.connect('activate', run);
        menu.append(item);
        return item;
    }

    cardMenu(column: number, index: number): Gtk.Menu {
        const col = this.board.columns[column];
        const card = col.cards[index];
        const at = { column, index };
        const menu = new Gtk.Menu();
        this.menuItem(menu, 'Sunting…', () => this.editCard(column, index));
        this.menuItem(menu, card.done ? 'Tandai Belum Selesai' : 'Tandai Selesai', () => this.commit(toggleDone(this.board, at)));

        const move = new Gtk.Menu();
        this.board.columns.forEach((target, t) => {
            if (t !== column) this.menuItem(move, target.title, () => this.commit(moveCard(this.board, at, { column: t, index: Infinity })));
        });
        const moveItem = new Gtk.MenuItem({ label: 'Pindahkan ke', sensitive: this.board.columns.length > 1 });
        moveItem.set_submenu(move);
        menu.append(moveItem);

        this.menuItem(menu, 'Naik', () => this.commit(moveCard(this.board, at, { column, index: index - 1 })), index > 0);
        this.menuItem(menu, 'Turun', () => this.commit(moveCard(this.board, at, { column, index: index + 1 })), index < col.cards.length - 1);
        menu.append(new Gtk.SeparatorMenuItem());
        this.menuItem(menu, 'Hapus', () => this.commit(deleteCard(this.board, at)));
        menu.show_all();
        return menu;
    }

    columnMenu(column: number): Gtk.Menu {
        const menu = new Gtk.Menu();
        this.menuItem(menu, 'Ganti Nama…', () => this.renameColumnPrompt(column));
        this.menuItem(menu, 'Geser ke Kiri', () => this.commit(moveColumn(this.board, column, column - 1)), column > 0);
        this.menuItem(menu, 'Geser ke Kanan', () => this.commit(moveColumn(this.board, column, column + 1)), column < this.board.columns.length - 1);
        menu.append(new Gtk.SeparatorMenuItem());
        this.menuItem(menu, 'Hapus Daftar…', () => this.deleteColumnConfirm(column));
        menu.show_all();
        return menu;
    }

    // ---------- Klik dan seret ----------

    onCardPress(column: number, index: number, widget: Gtk.EventBox, ev: PressEvent): boolean {
        const button = ev.get_button()[1];
        if (button === 3) {
            this.cardMenu(column, index).popup_at_pointer(ev as unknown as Gdk.Event);
            return true;
        }
        if (button !== 1) return false;
        const [, localX, localY] = ev.get_coords();
        const [, rootX, rootY] = ev.get_root_coords();
        this.press = { column, index, widget, rootX, rootY, localX, localY };
        return true;
    }

    onCardMotion(ev: PointerEvent): boolean {
        const press = this.press;
        if (!press) return false;
        const [, rootX, rootY] = ev.get_root_coords();
        if (!this.drag) {
            if (Math.hypot(rootX - press.rootX, rootY - press.rootY) < DRAG_THRESHOLD) return true;
            this.startDrag(press);
        }
        this.updateDrag(ev);
        return true;
    }

    onCardRelease(_ev: PointerEvent): boolean {
        const press = this.press;
        this.press = null;
        if (!press) return false;
        if (this.drag) this.finishDrag();
        else this.editCard(press.column, press.index);   // tidak bergeser: klik biasa
        return true;
    }

    get dragging(): boolean {
        return this.drag !== null;
    }

    private startDrag(press: PressState): void {
        const { widget } = press;
        const width = widget.get_allocated_width(), height = widget.get_allocated_height();
        const win = widget.get_window();
        const pixbuf = win ? Gdk.pixbuf_get_from_window(win, 0, 0, width, height) : null;

        // Kartu bayangan yang mengikuti penunjuk.
        let ghost: Gtk.Window | null = null;
        if (pixbuf) {
            ghost = new Gtk.Window({ type: Gtk.WindowType.POPUP, decorated: false, resizable: false, accept_focus: false, skip_taskbar_hint: true });
            ghost.add(Gtk.Image.new_from_pixbuf(pixbuf));
            ghost.set_opacity(0.9);
            ghost.show_all();
        }
        const placeholder = new Gtk.Box({ height_request: height });
        placeholder.get_style_context().add_class('kanban-placeholder');
        widget.set_opacity(0.35);

        this.drag = {
            from: { column: press.column, index: press.index }, widget, ghost, placeholder,
            target: { column: -1, index: -1 }, pointer: [0, 0],
            timer: GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => this.autoscroll()),
        };
    }

    private updateDrag(ev: PointerEvent): void {
        const drag = this.drag!, press = this.press!;
        const [, localX, localY] = ev.get_coords();
        const [, rootX, rootY] = ev.get_root_coords();
        drag.ghost?.move(Math.round(rootX - press.localX), Math.round(rootY - press.localY));
        const [, bx, by] = drag.widget.translate_coordinates(this.row, localX, localY);
        drag.pointer = [bx, by];
        this.retarget();
    }

    // Hitung ulang tujuan jatuh dari posisi penunjuk, dan pindahkan penandanya bila berubah.
    private retarget(): void {
        const drag = this.drag;
        if (!drag) return;
        const target = this.targetAt(drag.pointer[0], drag.pointer[1]);
        if (!target || (target.column === drag.target.column && target.index === drag.target.index)) return;
        drag.target = target;

        const col = this.columns[target.column];
        const others = col.cards.filter(w => w !== drag.widget);
        const position = col.cardsBox.get_children().indexOf(others[target.index]);
        const old = drag.placeholder.get_parent();
        if (old instanceof Gtk.Container) old.remove(drag.placeholder);
        col.cardsBox.pack_start(drag.placeholder, false, false, 0);
        drag.placeholder.show();
        col.cardsBox.reorder_child(drag.placeholder, position < 0 ? -1 : position);
    }

    // Daftar yang melingkupi penunjuk (atau yang terdekat), dan posisi kartu di dalamnya.
    targetAt(bx: number, by: number): Position | null {
        if (!this.columns.length) return null;
        let best = 0, bestDistance = Infinity;
        this.columns.forEach((col, c) => {
            const [, x] = col.box.translate_coordinates(this.row, 0, 0);
            const width = col.box.get_allocated_width();
            const distance = bx < x ? x - bx : bx > x + width ? bx - (x + width) : 0;
            if (distance < bestDistance) { best = c; bestDistance = distance; }
        });
        const others = this.columns[best].cards.filter(w => w !== this.drag?.widget);
        const centers = others.map(w => w.translate_coordinates(this.row, 0, w.get_allocated_height() / 2)[2]);
        return { column: best, index: dropIndex(centers, by) };
    }

    private finishDrag(): void {
        const drag = this.drag!;
        this.endDrag();
        const { from, target } = drag;
        if (target.column < 0 || (target.column === from.column && target.index === from.index)) return;
        this.commit(moveCard(this.board, from, target));
    }

    private cancelDrag(): void {
        if (this.drag) this.endDrag();
    }

    private endDrag(): void {
        const drag = this.drag!;
        this.drag = null;
        GLib.source_remove(drag.timer);
        drag.ghost?.destroy();
        const parent = drag.placeholder.get_parent();
        if (parent instanceof Gtk.Container) parent.remove(drag.placeholder);
        drag.placeholder.destroy();
        drag.widget.set_opacity(1);
    }

    // Menyeret dekat tepi menggulir papan (kiri/kanan) atau daftar tujuan (atas/bawah).
    autoscroll(): boolean {
        const drag = this.drag;
        if (!drag) return GLib.SOURCE_REMOVE;
        const [bx, by] = drag.pointer;

        const [, wx] = this.row.translate_coordinates(this.widget, bx, by);
        const hadj = this.widget.get_hadjustment();
        const before = hadj.get_value();
        if (wx < EDGE) hadj.set_value(before - SCROLL_SPEED);
        else if (wx > this.widget.get_allocated_width() - EDGE) hadj.set_value(before + SCROLL_SPEED);
        drag.pointer = [bx + (hadj.get_value() - before), by];   // penunjuk diam di layar, papan yang bergeser

        const col = this.columns[Math.max(0, drag.target.column)];
        if (col) {
            const [, , sy] = this.row.translate_coordinates(col.scroller, bx, by);
            const vadj = col.scroller.get_vadjustment();
            if (sy < EDGE) vadj.set_value(vadj.get_value() - SCROLL_SPEED);
            else if (sy > col.scroller.get_allocated_height() - EDGE) vadj.set_value(vadj.get_value() + SCROLL_SPEED);
        }
        this.retarget();
        return GLib.SOURCE_CONTINUE;
    }

    // ---------- Untuk tes dan pemanggil ----------

    cardTexts(column: number): string[] {
        return this.board.columns[column]?.cards.map(c => c.text) ?? [];
    }
}
