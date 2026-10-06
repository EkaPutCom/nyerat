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
// Menyeret memakai penunjuk sendiri (Gtk.GestureDrag: tekan → gerak → lepas pada kartu),
// bukan drag-and-drop bawaan GTK, supaya perilakunya terkendali dan bisa diuji dengan
// memanggil onCardPress/onCardMotion/onCardRelease langsung: kartu bayangan (gambar kartu
// di lapisan Overlay di atas papan) mengikuti penunjuk, dan penanda tujuan menunjukkan di
// mana kartu akan jatuh.

import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import {
    addCard, addColumn, cardMeta, deleteCard, deleteColumn, dropIndex, dueStatus, moveCard, moveColumn,
    newBoard, renameColumn, toggleDone, updateCard, type Board, type Card, type Position,
} from '../markdown/kanban.js';
import { cellMarkup, escapeMarkup, NOTE_URI, type MarkupColors } from '../markdown/pango.js';
import { parseWikiLink, wikiLinksIn, type WikiLink } from '../markdown/wikilink.js';
import { confirmDialog, editCardDialog, promptDialog, type CardDraft } from './dialogs.js';
import type { Palette } from './theme.js';
import { childrenOf, onClick, onKeyPress, pack, removeChildren } from '../gtkutil.js';
import { popupMenu, separator, type MenuEntry } from './menu.js';

const COLUMN_WIDTH = 290;
const DRAG_THRESHOLD = 6;     // piksel penunjuk bergerak sebelum klik dianggap menyeret
const EDGE = 48;              // jarak dari tepi (piksel) yang memicu gulir otomatis saat menyeret
const SCROLL_SPEED = 14;
const TAG_COLORS = 8;
const RUN_ICON: Record<CardRunStatus, string> = { queued: '◌', working: '●', waiting: '⏸', done: '✓', failed: '✕', stopped: '■' };
const RUN_LABEL: Record<CardRunStatus, string> = { queued: 'antre', working: 'bekerja', waiting: 'menunggu jawaban', done: 'selesai', failed: 'gagal', stopped: 'dihentikan' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

// Dialog bisa diganti (misalnya di tes) karena dialog asli menahan program sampai ditutup.
export interface BoardDialogs {
    editCard(parent: Gtk.Window | null, card: CardDraft, title?: string, listNotes?: () => string[]): CardDraft | null;
    prompt(parent: Gtk.Window | null, options: { title: string; label: string; value?: string }): string | null;
    confirm(parent: Gtk.Window | null, message: string, detail?: string): boolean;
}

// Penugasan kartu ke harness eksternal (diisi jendela). Kartu dikenali dari teksnya.
export type CardRunStatus = 'queued' | 'working' | 'waiting' | 'done' | 'failed' | 'stopped';
export interface BoardHarness {
    status(card: Card): CardRunStatus | null;
    menu(card: Card, at: Position): MenuEntry[];
}

export interface ColumnView {
    box: Gtk.Box;
    scroller: Gtk.ScrolledWindow;
    cardsBox: Gtk.Box;
    cards: Gtk.Box[];
    footer: Gtk.Button;
}

// Posisi penunjuk selalu dalam koordinat kartu yang ditekan.
interface PressState {
    column: number;
    index: number;
    widget: Gtk.Box;
    localX: number;
    localY: number;
}

interface DragState {
    from: Position;
    widget: Gtk.Box;
    ghost: Gtk.Picture;
    placeholder: Gtk.Box;
    target: Position;
    pointer: [number, number];   // posisi penunjuk di koordinat papan
    timer: number;
}

type Adding = { kind: 'list' } | null;

export class KanbanBoard {
    readonly widget: Gtk.Overlay;
    readonly scroller: Gtk.ScrolledWindow;
    private readonly ghostLayer: Gtk.Fixed;   // tempat kartu bayangan saat menyeret
    columns: ColumnView[] = [];
    onChange: (board: Board) => void = () => {};
    dialogs: BoardDialogs = { editCard: editCardDialog, prompt: promptDialog, confirm: confirmDialog };
    today: () => string = () => GLib.DateTime.new_now_local().format('%Y-%m-%d') ?? '';
    harness: BoardHarness | null = null;
    // [[catatan]] di kartu diklik, dan daftar berkas untuk saran [[ di dialog kartu (diisi jendela).
    onOpenNote: (link: WikiLink) => void = () => {};
    listNotes: (() => string[]) | null = null;

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
        this.row.add_css_class('kanban-row');
        this.scroller = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.AUTOMATIC, vscrollbar_policy: Gtk.PolicyType.NEVER, hexpand: true, vexpand: true, can_focus: false });
        this.scroller.add_css_class('kanban-board');
        this.scroller.set_child(this.row);
        // Lapisan kartu bayangan tidak menerima klik, jadi penunjuk tetap sampai ke papan.
        this.ghostLayer = new Gtk.Fixed({ can_target: false });
        this.widget = new Gtk.Overlay({ child: this.scroller });
        this.widget.add_overlay(this.ghostLayer);
    }

    // ---------- Model ----------

    getBoard(): Board {
        return this.board;
    }

    // Ganti papan (misalnya dokumen dibuka atau undo) tanpa memanggil onChange.
    setBoard(board: Board): void {
        this.board = board;
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
        const top = this.widget.get_root();
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
        const h = this.scroller.get_hadjustment().get_value();
        const v = this.columns.map(c => c.scroller.get_vadjustment().get_value());
        removeChildren(this.row);

        this.columns = this.board.columns.map((_, c) => this.buildColumn(c));
        for (const col of this.columns) this.row.append(col.box);
        this.row.append(this.buildAddList());

        // Posisi gulir baru berlaku setelah tata letak.
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.scroller.get_hadjustment().set_value(h);
            this.columns.forEach((col, c) => col.scroller.get_vadjustment().set_value(v[c] ?? 0));
            this.focusAddEntry();
            return GLib.SOURCE_REMOVE;
        });
    }

    private buildColumn(c: number): ColumnView {
        const column = this.board.columns[c];
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, width_request: COLUMN_WIDTH, vexpand: true });
        box.add_css_class('kanban-column');

        // Judul: klik ganda untuk mengganti nama.
        const title = new Gtk.Label({ label: column.title, xalign: 0, ellipsize: Pango.EllipsizeMode.END, hexpand: true });
        title.add_css_class('kanban-column-title');
        const titleBox = new Gtk.Box();
        titleBox.append(title);
        titleBox.set_tooltip_text('Klik ganda untuk mengganti nama');
        onClick(titleBox, count => {
            if (count !== 2) return false;
            this.renameColumnPrompt(c);
            return true;
        });
        const count = new Gtk.Label({ label: String(column.cards.length) });
        count.add_css_class('kanban-count');
        const more = new Gtk.Button({ label: '⋯', has_frame: false, tooltip_text: 'Menu daftar' });
        more.connect('clicked', () => popupMenu(more, this.columnMenu(c)));
        const header = new Gtk.Box({ spacing: 6 });
        pack(header, titleBox, true);
        header.append(count);
        header.append(more);
        box.append(header);

        const cardsBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 });
        const scroller = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vscrollbar_policy: Gtk.PolicyType.AUTOMATIC, vexpand: true });
        scroller.set_child(cardsBox);
        const cards = column.cards.map((_, i) => this.buildCard(c, i));
        for (const card of cards) cardsBox.append(card);
        pack(box, scroller, true);

        const footer = this.buildAddCard(c);
        box.append(footer);
        return { box, scroller, cardsBox, cards, footer };
    }

    private buildCard(c: number, i: number): Gtk.Box {
        const card = this.board.columns[c].cards[i];
        const meta = cardMeta(card.text);

        const widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        widget.add_css_class('kanban-card');
        if (card.done) widget.add_css_class('kanban-card-done');

        const check = new Gtk.CheckButton({ active: card.done === true, valign: Gtk.Align.START, tooltip_text: 'Tandai selesai' });
        check.connect('toggled', () => this.commit(toggleDone(this.board, { column: c, index: i })));
        const label = new Gtk.Label({ use_markup: true, xalign: 0, wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR, hexpand: true, width_chars: 10 });
        label.add_css_class('kanban-card-text');
        const markup = cellMarkup(meta.title, this.colors, true);
        label.set_markup(card.done ? `<s>${markup}</s>` : markup);
        label.connect('activate-link', (_l, uri: string) => this.activateNote(uri));
        const top = new Gtk.Box({ spacing: 8 });
        top.append(check);
        pack(top, label, true);

        const inner = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
        inner.append(top);
        // Tautan di catatan kartu tidak terlihat di judul, jadi ditampilkan sebagai chip yang bisa diklik.
        const inTitle = new Set(wikiLinksIn(card.text).map(l => l.target.toLowerCase()));
        const noteLinks = card.notes.length ? wikiLinksIn(card.notes.join('\n')).filter(l => !inTitle.has(l.target.toLowerCase())) : [];
        const badges = this.buildBadges(card.notes.length > 0, meta.tags, meta.due, meta.agent, this.harness?.status(card) ?? null);
        if (badges) inner.append(badges);
        // Satu baris per tautan supaya tautan yang banyak tidak melebarkan kartu.
        const linkBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 });
        if (noteLinks.length) inner.append(linkBox);
        for (const link of noteLinks) {
            const ref = `${link.target}${link.heading ? `#${link.heading}` : ''}`;
            const label = new Gtk.Label({ xalign: 0, ellipsize: Pango.EllipsizeMode.END, tooltip_text: `Buka catatan ${ref} (ikut menjadi konteks agent)` });
            label.add_css_class('kanban-note-link');
            label.set_markup(`<a href="${escapeMarkup(NOTE_URI + encodeURIComponent(ref))}">↗ ${escapeMarkup(link.alias || ref)}</a>`);
            label.connect('activate-link', (_l, uri: string) => this.activateNote(uri));
            linkBox.append(label);
        }
        widget.append(inner);

        // Tekan-geser-lepas dengan tombol kiri. Kotak centang menangani kliknya sendiri lebih
        // dulu (anak didahulukan), jadi mencentang tidak membuka dialog sunting.
        const drag = new Gtk.GestureDrag({ button: 1 });
        let startX = 0, startY = 0;
        drag.connect('drag-begin', (_g, x, y) => {
            startX = x;
            startY = y;
            this.onCardPress(c, i, widget, x, y);
        });
        drag.connect('drag-update', (_g, dx, dy) => this.onCardMotion(startX + dx, startY + dy));
        drag.connect('drag-end', () => this.onCardRelease());
        widget.add_controller(drag);
        onClick(widget, (_n, x, y) => {
            popupMenu(widget, this.cardMenu(c, i), x, y);
            return true;
        }, 3);
        return widget;
    }

    private buildBadges(hasNotes: boolean, tags: string[], due: string | null, agent: string | null = null, status: CardRunStatus | null = null): Gtk.Box | null {
        if (!hasNotes && !tags.length && !due && !agent) return null;
        const row = new Gtk.Box({ spacing: 4 });
        const chip = (text: string, ...classes: string[]) => {
            const label = new Gtk.Label({ label: text });
            for (const cls of ['kanban-chip', ...classes]) label.add_css_class(cls);
            row.append(label);
            return label;
        };
        if (agent) {
            const label = chip(`${status ? RUN_ICON[status] : '◇'} ${agent}${status ? ` · ${RUN_LABEL[status]}` : ''}`, 'kanban-agent', `kanban-agent-${status ?? 'idle'}`);
            label.set_tooltip_text(status === 'waiting' ? `${agent} menunggu jawaban Anda: klik kanan kartu → Jawab ${agent}…` : status ? `${agent}: ${RUN_LABEL[status]} (klik kanan kartu untuk log)` : `Ditugaskan ke ${agent}; klik kanan kartu → Kerjakan dengan ${agent}`);
        }
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
        onKeyPress(entry, keyval => {
            if (keyval !== Gdk.KEY_Escape) return false;
            cancel();
            return true;
        });
        const ok = new Gtk.Button({ label: 'Tambah' });
        ok.connect('clicked', () => { if (entry.text.trim()) add(entry.text); });
        const close = new Gtk.Button({ label: '✕', has_frame: false, tooltip_text: 'Batal (Esc)' });
        close.connect('clicked', cancel);
        const box = new Gtk.Box({ spacing: 4 });
        pack(box, entry, true);
        box.append(ok);
        box.append(close);
        return { box, entry };
    }

    private buildAddCard(c: number): Gtk.Button {
        const button = new Gtk.Button({ label: '+ Tambah kartu', has_frame: false, halign: Gtk.Align.FILL });
        (button.get_child() as Gtk.Label).xalign = 0;
        button.add_css_class('kanban-add');
        button.connect('clicked', () => this.showAddCard(c));
        return button;
    }

    private buildAddList(): Gtk.Box {
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, width_request: COLUMN_WIDTH, valign: Gtk.Align.START });
        box.add_css_class('kanban-add-list');
        const button = new Gtk.Button({ label: '+ Tambah daftar', has_frame: false });
        button.connect('clicked', () => this.showAddList());
        const { box: entryBox, entry } = this.entryRow('Nama daftar…', text => this.commit(addColumn(this.board, text)), () => this.hideAdd());
        entry.set_name('kanban-entry-list');
        const stack = new Gtk.Stack();
        stack.add_named(button, 'button');
        stack.add_named(entryBox, 'entry');
        stack.visible_child_name = this.adding?.kind === 'list' ? 'entry' : 'button';
        box.append(stack);
        return box;
    }

    // Kartu baru diisi lewat dialog yang sama dengan sunting kartu.
    showAddCard(column: number): void {
        const draft = this.dialogs.editCard(this.parent, { text: '', notes: [] }, 'Tambah Kartu', this.listNotes ?? undefined);
        if (!draft?.text) return;
        const index = this.board.columns[column]?.cards.length ?? 0;
        const added = addCard(this.board, column, draft.text);
        this.commit(updateCard(added, { column, index }, { notes: draft.notes }));
    }

    showAddList(): void {
        this.adding = { kind: 'list' };
        this.queueRender();
    }

    hideAdd(): void {
        this.adding = null;
        this.queueRender();
    }

    // Isian nama daftar yang sedang terbuka diberi fokus setelah digambar ulang.
    private focusAddEntry(): void {
        if (this.adding?.kind === 'list') this.findByName(this.row, 'kanban-entry-list')?.grab_focus();
    }

    private findByName(root: Gtk.Widget, name: string): Gtk.Widget | null {
        if (root.get_name() === name) return root;
        for (const child of childrenOf(root)) {
            const found = this.findByName(child, name);
            if (found) return found;
        }
        return null;
    }

    // ---------- Sunting ----------

    editCard(column: number, index: number): void {
        const card = this.board.columns[column]?.cards[index];
        if (!card) return;
        const result = this.dialogs.editCard(this.parent, { text: card.text, notes: card.notes }, undefined, this.listNotes ?? undefined);
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

    cardMenu(column: number, index: number): MenuEntry[] {
        const col = this.board.columns[column];
        const card = col.cards[index];
        const at = { column, index };
        const move = this.board.columns
            .map((target, t): MenuEntry | null => t === column ? null
                : { label: target.title, run: () => this.commit(moveCard(this.board, at, { column: t, index: Infinity })) })
            .filter((e): e is MenuEntry => e !== null);
        return [
            { label: 'Sunting…', run: () => this.editCard(column, index) },
            { label: card.done ? 'Tandai Belum Selesai' : 'Tandai Selesai', run: () => this.commit(toggleDone(this.board, at)) },
            { label: 'Pindahkan ke', enabled: this.board.columns.length > 1, submenu: move },
            { label: 'Naik', enabled: index > 0, run: () => this.commit(moveCard(this.board, at, { column, index: index - 1 })) },
            { label: 'Turun', enabled: index < col.cards.length - 1, run: () => this.commit(moveCard(this.board, at, { column, index: index + 1 })) },
            ...(this.harness ? [separator(), ...this.harness.menu(card, at)] : []),
            separator(),
            { label: 'Hapus', run: () => this.commit(deleteCard(this.board, at)) },
        ];
    }

    columnMenu(column: number): MenuEntry[] {
        return [
            { label: 'Ganti Nama…', run: () => this.renameColumnPrompt(column) },
            { label: 'Geser ke Kiri', enabled: column > 0, run: () => this.commit(moveColumn(this.board, column, column - 1)) },
            { label: 'Geser ke Kanan', enabled: column < this.board.columns.length - 1, run: () => this.commit(moveColumn(this.board, column, column + 1)) },
            separator(),
            { label: 'Hapus Daftar…', run: () => this.deleteColumnConfirm(column) },
        ];
    }

    // ---------- Klik dan seret ----------

    // Tautan [[catatan]] di kartu diklik. Penekanan kartu dibatalkan supaya lepasnya tidak membuka dialog sunting.
    activateNote(uri: string): boolean {
        if (!uri.startsWith(NOTE_URI)) return false;
        this.press = null;
        this.onOpenNote(parseWikiLink(decodeURIComponent(uri.slice(NOTE_URI.length))));
        return true;
    }

    // Tombol kiri ditekan di (x, y), koordinat kartu `widget`.
    onCardPress(column: number, index: number, widget: Gtk.Box, x: number, y: number): boolean {
        this.press = { column, index, widget, localX: x, localY: y };
        return true;
    }

    // Penunjuk bergerak ke (x, y), koordinat kartu yang ditekan.
    onCardMotion(x: number, y: number): boolean {
        const press = this.press;
        if (!press) return false;
        if (!this.drag) {
            if (Math.hypot(x - press.localX, y - press.localY) < DRAG_THRESHOLD) return true;
            this.startDrag(press);
        }
        this.updateDrag(x, y);
        return true;
    }

    onCardRelease(): boolean {
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
        const height = widget.get_allocated_height();

        // Kartu bayangan: gambar diam kartu saat ini (sebelum dibuat pudar), di lapisan Overlay.
        const image = new Gtk.WidgetPaintable({ widget }).get_current_image();
        const ghost = new Gtk.Picture({ paintable: image, can_shrink: false, opacity: 0.9 });
        this.ghostLayer.put(ghost, 0, 0);
        const placeholder = new Gtk.Box({ height_request: height });
        placeholder.add_css_class('kanban-placeholder');
        widget.set_opacity(0.35);

        this.drag = {
            from: { column: press.column, index: press.index }, widget, ghost, placeholder,
            target: { column: -1, index: -1 }, pointer: [0, 0],
            timer: GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => this.autoscroll()),
        };
    }

    private updateDrag(localX: number, localY: number): void {
        const drag = this.drag!, press = this.press!;
        const [, gx, gy] = drag.widget.translate_coordinates(this.widget, localX - press.localX, localY - press.localY);
        this.ghostLayer.move(drag.ghost, Math.round(gx), Math.round(gy));
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
        const before = others[target.index];
        const old = drag.placeholder.get_parent();
        if (old instanceof Gtk.Box) old.remove(drag.placeholder);
        // Sisipkan tepat sebelum kartu tujuan (atau di akhir daftar).
        if (before) col.cardsBox.insert_child_after(drag.placeholder, before.get_prev_sibling());
        else col.cardsBox.append(drag.placeholder);
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
        this.ghostLayer.remove(drag.ghost);
        const parent = drag.placeholder.get_parent();
        if (parent instanceof Gtk.Box) parent.remove(drag.placeholder);
        drag.widget.set_opacity(1);
    }

    // Menyeret dekat tepi menggulir papan (kiri/kanan) atau daftar tujuan (atas/bawah).
    autoscroll(): boolean {
        const drag = this.drag;
        if (!drag) return GLib.SOURCE_REMOVE;
        const [bx, by] = drag.pointer;

        const [, wx] = this.row.translate_coordinates(this.scroller, bx, by);
        const hadj = this.scroller.get_hadjustment();
        const before = hadj.get_value();
        if (wx < EDGE) hadj.set_value(before - SCROLL_SPEED);
        else if (wx > this.scroller.get_allocated_width() - EDGE) hadj.set_value(before + SCROLL_SPEED);
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
