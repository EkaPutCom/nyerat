// Menampilkan gambar ![alt](url) langsung di editor.
//
// Gambar TIDAK dimasukkan ke dalam buffer teks (misalnya lewat GtkTextChildAnchor),
// karena itu akan menambah karakter ke dokumen dan riwayat undo. Sebagai gantinya:
//
//   1. Di bawah baris yang memuat gambar disediakan ruang kosong dengan tag
//      ber-`pixels_below_lines` setinggi gambarnya.
//   2. Widget gambar ditempelkan di atas ruang kosong itu dengan
//      add_overlay(). Posisinya dalam koordinat buffer, jadi ikut
//      bergulir bersama teks.
//   3. Setiap kali tata letak berubah (teks diedit, jendela diubah ukurannya,
//      gambar selesai dimuat), posisi widget dihitung ulang dari
//      get_line_yrange() barisnya.
//
// Gambar dimuat secara async dan disimpan di cache per URI, jadi mengetik tidak
// memuat ulang gambar yang sama.

import Gtk from 'gi://Gtk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import type { ImageRef } from './highlighter.js';
import { setTagGroup, type Range } from './tagsync.js';
import { OverlaySlots } from './overlays.js';
import { iterAtLine, onClick, removeChildren, textureFromPixbuf } from '../gtkutil.js';
import { _, fmt } from '../i18n.js';

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

// Hasil mencari gambar untuk diperbesar (imageAt).
export type ImageLookup =
    | { ok: true; pixbuf: GdkPixbuf.Pixbuf; title: string }
    | { ok: false; reason: string };

// Satu blok per baris yang memuat gambar.
export interface Block {
    line: number;
    key: string;           // daftar URI + alt, untuk mencocokkan blok yang sama
    items: BlockItem[];
    box: Gtk.Box;          // slot overlay (lihat overlays.ts)
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
    private readonly slots: OverlaySlots;

    constructor(view: Gtk.TextView) {
        this.view = view;
        this.buffer = view.buffer;
        this.slots = new OverlaySlots(view);

        // Tata letak berubah (tinggi dokumen atau ukuran jendela, terlihat dari adjustment
        // vertikal) → posisi widget perlu dihitung ulang.
        view.connect('notify::vadjustment', () => this.watchAdjustment());
        this.watchAdjustment();
    }

    // Editor ditutup: hentikan pekerjaan tertunda (lihat MarkdownView.destroy()).
    destroy(): void {
        this.destroyed = true;
        this.slots.destroy();
        for (const block of this.blocks) block.destroyed = true;
    }

    private watchAdjustment(): void {
        const adj = this.view.get_vadjustment();
        if (!adj || adj === this.adjustment) return;
        this.adjustment = adj;
        adj.connect('changed', () => this.queueRelayout());
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
        if (!item) return { ok: false, reason: _('Tidak ada gambar di baris ini') };
        if (item.entry?.status === 'ok' && item.entry.pixbuf) {
            const name = item.uri.split('/').pop() ?? item.uri;
            return { ok: true, pixbuf: item.entry.pixbuf, title: item.alt || GLib.uri_unescape_string(name, null) || name };
        }
        return { ok: false, reason: item.entry?.status === 'error' ? _('Gambar tidak bisa dimuat') : _('Gambar belum selesai dimuat') };
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
        content.add_css_class('image-block');
        const box = this.slots.acquire();
        box.append(content);
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
        box.set_visible(this.enabled);
        return block;
    }

    private destroyBlock(block: Block): void {
        block.destroyed = true;
        this.slots.release(block.box);
    }

    // Bangun ulang isi blok sesuai status pemuatan dan lebar kolom saat ini.
    private render(block: Block): void {
        removeChildren(block.content);
        let height = 0;
        for (const item of block.items) {
            let widget: Gtk.Widget;
            if (item.entry?.status === 'ok' && item.entry.pixbuf) {
                const pb = item.entry.pixbuf;
                const scale = Math.min(1, this.maxWidth / pb.get_width(), MAX_HEIGHT / pb.get_height());
                const w = Math.max(1, Math.round(pb.get_width() * scale));
                const h = Math.max(1, Math.round(pb.get_height() * scale));
                const scaled = (scale < 1 ? pb.scale_simple(w, h, GdkPixbuf.InterpType.BILINEAR) : null) ?? pb;
                // Gtk.Image di GTK 4 berukuran ikon; Picture tampil seukuran gambarnya.
                widget = Gtk.Picture.new_for_paintable(textureFromPixbuf(scaled));
                (widget as Gtk.Picture).set_can_shrink(false);
                widget.set_tooltip_text(fmt(_('{name}\nKlik ganda untuk memperbesar'), { name: item.alt || item.uri }));
                height += h;
            } else {
                const text = item.entry?.status === 'error'
                    ? fmt(_('⚠ Gambar tidak bisa dimuat: {name}'), { name: item.alt || GLib.uri_unescape_string(item.uri, null) || item.uri })
                    : fmt(_('Memuat gambar {name}…'), { name: item.alt });
                // Tanpa wrap: widget di dalam TextView hanya diberi lebar minimum,
                // sehingga label yang dibungkus akan terpotong per kata.
                widget = new Gtk.Label({ label: text, xalign: 0 });
                widget.add_css_class('image-note');
                if (item.entry?.error) widget.set_tooltip_text(item.entry.error);
                height += 24;
            }
            // Setiap gambar punya penerima kliknya sendiri, supaya klik ganda tahu gambar mana
            // yang dimaksud jika satu baris memuat beberapa gambar.
            widget.set_halign(Gtk.Align.START);
            const index = block.items.indexOf(item);
            onClick(widget, count => {
                this.press(block.line, index, count === 2);
                return true;
            });
            block.content.append(widget);
        }
        height += SPACING * Math.max(0, block.items.length - 1);
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
            const s = iterAtLine(this.buffer, block.line);
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
            const [lineY, lineHeight] = this.view.get_line_yrange(iterAtLine(this.buffer, block.line));
            const y = lineY + lineHeight - block.height - GAP;
            // Hanya pindahkan jika berubah, supaya tidak memicu resize berulang.
            if (x === block.x && y === block.y) continue;
            block.x = x;
            block.y = y;
            this.slots.place(block.box, x, y);
        }
    }
}
