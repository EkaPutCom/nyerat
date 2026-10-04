// Menampilkan gambar ![alt](url) langsung di editor.
//
// Gambar TIDAK dimasukkan ke dalam buffer teks (misalnya lewat GtkTextChildAnchor),
// karena itu akan menambah karakter ke dokumen dan riwayat undo. Sebagai gantinya:
//
//   1. Di bawah baris yang memuat gambar disediakan ruang kosong dengan tag
//      ber-`pixels_below_lines` setinggi gambarnya.
//   2. Widget gambar ditempelkan di atas ruang kosong itu dengan
//      add_child_in_window(). Posisinya dalam koordinat buffer, jadi ikut
//      bergulir bersama teks.
//   3. Setiap kali tata letak berubah (teks diedit, jendela diubah ukurannya,
//      gambar selesai dimuat), posisi widget dihitung ulang dari
//      get_line_yrange() barisnya.
//
// Gambar dimuat secara async dan disimpan di cache per URI, jadi mengetik tidak
// memuat ulang gambar yang sama.

import Gtk from 'gi://Gtk?version=3.0';
import Gdk from 'gi://Gdk?version=3.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import type { ImageRef } from './highlighter.js';
import { setTagGroup, type Range } from './tagsync.js';

const MAX_HEIGHT = 480;  // tinggi maksimum gambar, dalam piksel
const GAP = 12;          // jarak di atas dan bawah gambar
const SPACING = 8;       // jarak antar gambar dalam satu baris

// ---------- Memuat gambar ----------

// URL di Markdown → URI GIO. Path relatif dihitung dari folder dokumen.
export function resolveImageUri(url: string, baseDir: string): string {
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
    const path = GLib.path_is_absolute(url) ? url : GLib.build_filenamev([baseDir, decodeURI(url)]);
    return Gio.File.new_for_path(path).get_uri();
}

interface CacheEntry {
    status: 'loading' | 'ok' | 'error';
    pixbuf: GdkPixbuf.Pixbuf | null;
    error: string | null;
    waiters: ((entry: CacheEntry) => void)[];
}

// Satu gambar di dalam blok.
interface BlockItem {
    uri: string;
    alt: string;
    entry: CacheEntry | null;
}

// Bagian dari Gdk.Event yang dipakai penanganan klik (memudahkan tes membuat event tiruan).
export type ClickEvent = Pick<Gdk.Event, 'get_button' | 'get_event_type'>;

// Hasil mencari gambar untuk diperbesar (imageAt).
export type ImageLookup =
    | { ok: true; pixbuf: GdkPixbuf.Pixbuf; title: string }
    | { ok: false; reason: string };

// Satu blok per baris yang memuat gambar.
export interface Block {
    line: number;
    key: string;           // daftar URI + alt, untuk mencocokkan blok yang sama
    items: BlockItem[];
    box: Gtk.EventBox;
    content: Gtk.Box;
    height: number;
    x: number;
    y: number;
    destroyed: boolean;
}

const cache = new Map<string, CacheEntry>();

// Muat gambar secara async; callback dipanggil dengan entri cache saat selesai.
function loadImage(uri: string, callback: (entry: CacheEntry) => void): void {
    let entry = cache.get(uri);
    if (entry) {
        if (entry.status === 'loading') entry.waiters.push(callback);
        else callback(entry);
        return;
    }
    const fresh: CacheEntry = { status: 'loading', pixbuf: null, error: null, waiters: [callback] };
    cache.set(uri, fresh);
    const file = Gio.File.new_for_uri(uri);
    file.load_contents_async(null, (_source, result) => {
        try {
            const [, bytes] = file.load_contents_finish(result);
            const stream = Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(bytes));
            const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(stream, null);
            fresh.pixbuf = pixbuf.apply_embedded_orientation() ?? pixbuf;  // foto ponsel yang diputar
            fresh.status = 'ok';
        } catch (e) {
            fresh.status = 'error';
            fresh.error = e instanceof Error ? e.message : String(e);
        }
        for (const waiter of fresh.waiters) waiter(fresh);
        fresh.waiters = [];
    });
}

// ---------- Lapisan gambar ----------

export class ImageLayer {
    readonly view: Gtk.TextView;
    readonly buffer: Gtk.TextBuffer;
    enabled = true;
    maxWidth = 700;
    blocks: Block[] = [];

    getBaseDir: () => string = () => GLib.get_home_dir();
    onActivate: (line: number) => void = () => {};  // gambar diklik sekali
    onZoom: (line: number, index: number) => void = () => {};  // gambar diklik dua kali

    private gapTags = new Map<number, Gtk.TextTag>();   // tinggi → tag
    private relayoutQueued = false;
    private destroyed = false;
    private adjustment: Gtk.Adjustment | null = null;

    constructor(view: Gtk.TextView) {
        this.view = view;
        this.buffer = view.buffer;
        view.connect('destroy', () => { this.destroyed = true; });

        // Tata letak berubah → posisi widget perlu dihitung ulang.
        view.connect('size-allocate', () => this.queueRelayout());
        view.connect('notify::vadjustment', () => this.watchAdjustment());
        this.watchAdjustment();
    }

    private watchAdjustment(): void {
        const adj = this.view.get_vadjustment();
        if (!adj || adj === this.adjustment) return;
        this.adjustment = adj;
        adj.connect('changed', () => this.queueRelayout());
    }

    // Tombol mouse ditekan pada gambar ke-`index` di baris `line`. Hanya tombol kiri yang
    // ditangani; klik ganda datang sebagai peristiwa DOUBLE_BUTTON_PRESS dari GDK.
    onItemPress(line: number, index: number, event: ClickEvent): boolean {
        if (event.get_button()[1] !== 1) return false;
        this.press(line, index, event.get_event_type() === Gdk.EventType.DOUBLE_BUTTON_PRESS);
        return true;
    }

    // Gambar di baris `line` diklik. Satu klik: kursor ke barisnya (sintaksnya muncul);
    // klik ganda: perbesar gambar itu.
    press(line: number, index: number, doubleClick: boolean): void {
        if (doubleClick) this.onZoom(line, index);
        else this.onActivate(line);
    }

    // Gambar ke-`index` di baris `line` dalam ukuran penuh (bukan yang diperkecil untuk tampilan).
    imageAt(line: number, index = 0): ImageLookup {
        const item = this.blocks.find(b => b.line === line)?.items[index];
        if (!item) return { ok: false, reason: 'Tidak ada gambar di baris ini' };
        if (item.entry?.status === 'ok' && item.entry.pixbuf) {
            const name = item.uri.split('/').pop() ?? item.uri;
            return { ok: true, pixbuf: item.entry.pixbuf, title: item.alt || GLib.uri_unescape_string(name, null) || name };
        }
        return { ok: false, reason: item.entry?.status === 'error' ? 'Gambar tidak bisa dimuat' : 'Gambar belum selesai dimuat' };
    }

    // images dari highlighter.ts
    update(images: ImageRef[]): void {
        const baseDir = this.getBaseDir();
        const byLine = new Map<number, { uri: string; alt: string }[]>();
        for (const img of images) {
            if (!byLine.has(img.line)) byLine.set(img.line, []);
            byLine.get(img.line)!.push({ uri: resolveImageUri(img.url, baseDir), alt: img.alt });
        }

        // Pakai ulang blok yang isinya sama, walaupun barisnya bergeser (misalnya
        // karena ada baris baru di atasnya). Cocokkan berdasarkan daftar URI.
        const unused = [...this.blocks];
        const next: Block[] = [];
        for (const [line, items] of byLine) {
            const key = items.map(i => `${i.uri}\n${i.alt}`).join('\n\n');
            const k = unused.findIndex(b => b.key === key);
            if (k >= 0) {
                const block = unused.splice(k, 1)[0];
                block.line = line;
                next.push(block);
            } else {
                next.push(this.createBlock(line, key, items));
            }
        }
        for (const block of unused) this.destroyBlock(block);
        this.blocks = next;
        this.applyGaps();
        this.queueRelayout();
    }

    setEnabled(enabled: boolean): void {
        if (enabled === this.enabled) return;
        this.enabled = enabled;
        for (const block of this.blocks) block.box.set_visible(enabled);
        this.applyGaps();
        this.queueRelayout();
    }

    // Lebar kolom teks berubah → skala ulang semua gambar.
    setMaxWidth(width: number): void {
        width = Math.max(100, Math.floor(width));
        if (width === this.maxWidth) return;
        this.maxWidth = width;
        for (const block of this.blocks) this.render(block);
        this.applyGaps();
        this.queueRelayout();
    }

    // ---------- Widget ----------

    private createBlock(line: number, key: string, items: { uri: string; alt: string }[]): Block {
        const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: SPACING });
        const box = new Gtk.EventBox({ visible_window: false });
        box.add(content);
        box.get_style_context().add_class('image-block');
        const block: Block = { line, key, items: [], box, content, height: 0, x: -1, y: -1, destroyed: false };

        for (const { uri, alt } of items) {
            const item: BlockItem = { uri, alt, entry: null };
            block.items.push(item);
            loadImage(uri, entry => {
                if (block.destroyed) return;
                item.entry = entry;
                this.render(block);
                this.applyGaps();
                this.queueRelayout();
            });
        }
        this.render(block);
        this.view.add_child_in_window(box, Gtk.TextWindowType.TEXT, 0, 0);
        box.show_all();
        box.set_visible(this.enabled);
        return block;
    }

    private destroyBlock(block: Block): void {
        block.destroyed = true;
        block.box.destroy();
    }

    // Bangun ulang isi blok sesuai status pemuatan dan lebar kolom saat ini.
    private render(block: Block): void {
        for (const child of block.content.get_children()) child.destroy();
        let height = 0;
        for (const item of block.items) {
            let widget: Gtk.Widget;
            if (item.entry?.status === 'ok' && item.entry.pixbuf) {
                const pb = item.entry.pixbuf;
                const scale = Math.min(1, this.maxWidth / pb.get_width(), MAX_HEIGHT / pb.get_height());
                const w = Math.max(1, Math.round(pb.get_width() * scale));
                const h = Math.max(1, Math.round(pb.get_height() * scale));
                const scaled = (scale < 1 ? pb.scale_simple(w, h, GdkPixbuf.InterpType.BILINEAR) : null) ?? pb;
                widget = Gtk.Image.new_from_pixbuf(scaled);
                widget.set_tooltip_text(`${item.alt || item.uri}\nKlik ganda untuk memperbesar`);
                height += h;
            } else {
                const text = item.entry?.status === 'error'
                    ? `⚠ Gambar tidak bisa dimuat: ${item.alt || GLib.uri_unescape_string(item.uri, null) || item.uri}`
                    : `Memuat gambar ${item.alt}…`;
                // Tanpa wrap: widget di dalam TextView hanya diberi lebar minimum,
                // sehingga label yang dibungkus akan terpotong per kata.
                widget = new Gtk.Label({ label: text, xalign: 0 });
                widget.get_style_context().add_class('image-note');
                if (item.entry?.error) widget.set_tooltip_text(item.entry.error);
                height += 24;
            }
            // Setiap gambar punya penerima kliknya sendiri, supaya klik ganda tahu gambar mana
            // yang dimaksud jika satu baris memuat beberapa gambar.
            const clickable = new Gtk.EventBox({ visible_window: false, halign: Gtk.Align.START });
            clickable.add(widget);
            const index = block.items.indexOf(item);
            clickable.connect('button-press-event', (_w, ev) => this.onItemPress(block.line, index, ev as unknown as Gdk.Event));
            block.content.add(clickable);
        }
        height += SPACING * Math.max(0, block.items.length - 1);
        block.content.show_all();
        block.height = height;
    }

    // ---------- Ruang kosong di bawah baris ----------

    private gapTag(height: number): Gtk.TextTag {
        let tag = this.gapTags.get(height);
        if (!tag) {
            tag = new Gtk.TextTag({ name: `image-gap-${height}`, pixels_below_lines: height });
            this.buffer.get_tag_table().add(tag);
            this.gapTags.set(height, tag);
        }
        return tag;
    }

    private applyGaps(): void {
        const gaps = new Map<Gtk.TextTag, Range[]>();
        for (const block of this.enabled ? this.blocks : []) {
            if (block.line >= this.buffer.get_line_count()) continue;
            const s = this.buffer.get_iter_at_line(block.line);
            const e = s.copy();
            if (!e.ends_line()) e.forward_to_line_end();
            // Tag paragraf harus menempel di karakter pertama baris.
            if (s.equal(e)) continue;
            const gap = this.gapTag(block.height + 2 * GAP);
            if (!gaps.has(gap)) gaps.set(gap, []);
            gaps.get(gap)!.push([s.get_offset(), e.get_offset()]);
        }
        setTagGroup(this.buffer, this.gapTags.values(), gaps);
    }

    // ---------- Posisi widget ----------

    queueRelayout(): void {
        if (this.destroyed || this.relayoutQueued) return;
        this.relayoutQueued = true;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.relayoutQueued = false;
            if (!this.destroyed) this.relayout();   // tab bisa ditutup sebelum idle berjalan
            return GLib.SOURCE_REMOVE;
        });
    }

    relayout(): void {
        if (!this.enabled) return;
        const x = this.view.get_left_margin();
        for (const block of this.blocks) {
            if (block.destroyed || block.line >= this.buffer.get_line_count()) continue;
            const [lineY, lineHeight] = this.view.get_line_yrange(this.buffer.get_iter_at_line(block.line));
            const y = lineY + lineHeight - block.height - GAP;
            // Hanya pindahkan jika berubah, supaya tidak memicu resize berulang.
            if (x === block.x && y === block.y) continue;
            block.x = x;
            block.y = y;
            this.view.move_child(block.box, x, y);
        }
    }
}
