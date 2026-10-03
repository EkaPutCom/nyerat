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
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const MAX_HEIGHT = 480;  // tinggi maksimum gambar, dalam piksel
const GAP = 12;          // jarak di atas dan bawah gambar
const SPACING = 8;       // jarak antar gambar dalam satu baris

// ---------- Memuat gambar ----------

// URL di Markdown → URI GIO. Path relatif dihitung dari folder dokumen.
export function resolveImageUri(url, baseDir) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
    const path = GLib.path_is_absolute(url) ? url : GLib.build_filenamev([baseDir, decodeURI(url)]);
    return Gio.File.new_for_path(path).get_uri();
}

// uri → { status: 'loading' | 'ok' | 'error', pixbuf, error, waiters }
const cache = new Map();

// Muat gambar secara async; callback dipanggil dengan entri cache saat selesai.
function loadImage(uri, callback) {
    let entry = cache.get(uri);
    if (entry) {
        if (entry.status === 'loading') entry.waiters.push(callback);
        else callback(entry);
        return;
    }
    entry = { status: 'loading', pixbuf: null, error: null, waiters: [callback] };
    cache.set(uri, entry);
    Gio.File.new_for_uri(uri).load_contents_async(null, (file, result) => {
        try {
            const [, bytes] = file.load_contents_finish(result);
            const stream = Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(bytes));
            const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(stream, null);
            entry.pixbuf = pixbuf.apply_embedded_orientation() ?? pixbuf;  // foto ponsel yang diputar
            entry.status = 'ok';
        } catch (e) {
            entry.status = 'error';
            entry.error = e.message;
        }
        for (const waiter of entry.waiters) waiter(entry);
        entry.waiters = [];
    });
}

// ---------- Lapisan gambar ----------

export class ImageLayer {
    constructor(view) {
        this.view = view;
        this.buffer = view.buffer;
        this.enabled = true;
        this.maxWidth = 700;

        this.getBaseDir = () => GLib.get_home_dir();
        this.onActivate = () => {};  // gambar diklik; dipanggil dengan nomor baris

        // Satu "blok" per baris yang memuat gambar:
        // { line, key, items: [{ uri, alt, widget }], box, height, x, y, destroyed }
        this.blocks = [];
        this._gapTags = new Map();   // tinggi → GtkTextTag
        this._relayoutQueued = false;

        // Tata letak berubah → posisi widget perlu dihitung ulang.
        view.connect('size-allocate', () => this.queueRelayout());
        view.connect('notify::vadjustment', () => this._watchAdjustment());
        this._watchAdjustment();
    }

    _watchAdjustment() {
        const adj = this.view.get_vadjustment();
        if (!adj || adj === this._adjustment) return;
        this._adjustment = adj;
        adj.connect('changed', () => this.queueRelayout());
    }

    // images: [{ line, url, alt }] dari highlighter.js
    update(images) {
        const baseDir = this.getBaseDir();
        const byLine = new Map();
        for (const img of images) {
            if (!byLine.has(img.line)) byLine.set(img.line, []);
            byLine.get(img.line).push({ uri: resolveImageUri(img.url, baseDir), alt: img.alt });
        }

        // Pakai ulang blok yang isinya sama, walaupun barisnya bergeser (misalnya
        // karena ada baris baru di atasnya). Cocokkan berdasarkan daftar URI.
        const unused = [...this.blocks];
        const next = [];
        for (const [line, items] of byLine) {
            const key = items.map(i => `${i.uri}\n${i.alt}`).join('\n\n');
            const k = unused.findIndex(b => b.key === key);
            if (k >= 0) {
                const block = unused.splice(k, 1)[0];
                block.line = line;
                next.push(block);
            } else {
                next.push(this._createBlock(line, key, items));
            }
        }
        for (const block of unused) this._destroyBlock(block);
        this.blocks = next;
        this._applyGaps();
        this.queueRelayout();
    }

    setEnabled(enabled) {
        if (enabled === this.enabled) return;
        this.enabled = enabled;
        for (const block of this.blocks) block.box.set_visible(enabled);
        this._applyGaps();
        this.queueRelayout();
    }

    // Lebar kolom teks berubah → skala ulang semua gambar.
    setMaxWidth(width) {
        width = Math.max(100, Math.floor(width));
        if (width === this.maxWidth) return;
        this.maxWidth = width;
        for (const block of this.blocks) this._render(block);
        this._applyGaps();
        this.queueRelayout();
    }

    // ---------- Widget ----------

    _createBlock(line, key, items) {
        const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: SPACING });
        const box = new Gtk.EventBox({ visible_window: false });
        box.add(content);
        box.get_style_context().add_class('image-block');
        const block = { line, key, items: [], box, content, height: 0, x: -1, y: -1, destroyed: false };

        box.connect('button-press-event', () => {
            this.onActivate(block.line);
            return true;
        });

        for (const { uri, alt } of items) {
            const item = { uri, alt, entry: null, widget: null };
            block.items.push(item);
            loadImage(uri, entry => {
                if (block.destroyed) return;
                item.entry = entry;
                this._render(block);
                this._applyGaps();
                this.queueRelayout();
            });
        }
        this._render(block);
        this.view.add_child_in_window(box, Gtk.TextWindowType.TEXT, 0, 0);
        box.show_all();
        box.set_visible(this.enabled);
        return block;
    }

    _destroyBlock(block) {
        block.destroyed = true;
        block.box.destroy();
    }

    // Bangun ulang isi blok sesuai status pemuatan dan lebar kolom saat ini.
    _render(block) {
        for (const child of block.content.get_children()) child.destroy();
        let height = 0;
        for (const item of block.items) {
            let widget;
            if (item.entry?.status === 'ok') {
                const pb = item.entry.pixbuf;
                const scale = Math.min(1, this.maxWidth / pb.get_width(), MAX_HEIGHT / pb.get_height());
                const w = Math.max(1, Math.round(pb.get_width() * scale));
                const h = Math.max(1, Math.round(pb.get_height() * scale));
                const scaled = scale < 1 ? pb.scale_simple(w, h, GdkPixbuf.InterpType.BILINEAR) : pb;
                widget = Gtk.Image.new_from_pixbuf(scaled);
                widget.set_tooltip_text(item.alt || item.uri);
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
            widget.halign = Gtk.Align.START;
            block.content.add(widget);
        }
        height += SPACING * Math.max(0, block.items.length - 1);
        block.content.show_all();
        block.height = height;
    }

    // ---------- Ruang kosong di bawah baris ----------

    _gapTag(height) {
        let tag = this._gapTags.get(height);
        if (!tag) {
            tag = new Gtk.TextTag({ name: `image-gap-${height}`, pixels_below_lines: height });
            this.buffer.get_tag_table().add(tag);
            this._gapTags.set(height, tag);
        }
        return tag;
    }

    _applyGaps() {
        const [start, end] = this.buffer.get_bounds();
        for (const tag of this._gapTags.values()) this.buffer.remove_tag(tag, start, end);
        if (!this.enabled) return;
        for (const block of this.blocks) {
            if (block.line >= this.buffer.get_line_count()) continue;
            const s = this.buffer.get_iter_at_line(block.line);
            const e = s.copy();
            if (!e.ends_line()) e.forward_to_line_end();
            // Tag paragraf harus menempel di karakter pertama baris.
            if (s.equal(e)) continue;
            this.buffer.apply_tag(this._gapTag(block.height + 2 * GAP), s, e);
        }
    }

    // ---------- Posisi widget ----------

    queueRelayout() {
        if (this._relayoutQueued) return;
        this._relayoutQueued = true;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._relayoutQueued = false;
            this.relayout();
            return GLib.SOURCE_REMOVE;
        });
    }

    relayout() {
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
