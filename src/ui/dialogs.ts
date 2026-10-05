// Dialog standar: pilih file, konfirmasi simpan, pesan error, tentang.
// Semua dialog bersifat modal dan blocking (main loop bersarang lewat runModal(), pengganti
// gtk_dialog_run() yang dihapus GTK 4), jadi hasilnya bisa langsung dikembalikan.

import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import { onKeyPress, runModal } from '../gtkutil.js';
import { APP_NAME, APP_VERSION } from '../config.js';
import { AGENT_NAME, composeCard, DUE_INPUT, splitCard } from '../markdown/kanban.js';
import type { HarnessAsk, HarnessReply } from '../agent/harness.js';

type FilterSetup = [label: string, setup: (filter: Gtk.FileFilter) => void];

export const FILTERS = {
    markdown: ['Markdown', f => ['*.md', '*.markdown', '*.mdown', '*.txt'].forEach(p => f.add_pattern(p))],
    image: ['Gambar', f => f.add_mime_type('image/*')],
    html: ['HTML', f => f.add_pattern('*.html')],
    all: ['Semua file', f => f.add_pattern('*')],
} satisfies Record<string, FilterSetup>;

export type FilterName = keyof typeof FILTERS;

export interface ChooseFileOptions {
    title: string;
    save?: boolean;
    selectFolder?: boolean;     // pilih folder, bukan file
    filters?: FilterName[];
    name?: string | null;       // nama file usulan (dialog simpan)
    folder?: string | null;     // folder awal
}

// Mengembalikan path yang dipilih, atau null jika dibatalkan.
export function chooseFile(parent: Gtk.Window, { title, save = false, selectFolder = false, filters = [], name = null, folder = null }: ChooseFileOptions): string | null {
    const dialog = new Gtk.FileDialog({ title, modal: true });
    if (filters.length) {
        const list = new Gio.ListStore({ item_type: Gtk.FileFilter.$gtype });
        for (const key of filters) {
            const [label, setup]: FilterSetup = FILTERS[key];
            const filter = new Gtk.FileFilter();
            filter.set_name(label);
            setup(filter);
            list.append(filter);
        }
        dialog.set_filters(list);
        dialog.set_default_filter(list.get_item(0) as Gtk.FileFilter);
    }
    if (folder) dialog.set_initial_folder(Gio.File.new_for_path(folder));
    if (name) dialog.set_initial_name(name);
    // Dialog simpan GTK 4 (dan portal) sudah menanyakan sebelum menimpa file.
    return runModal<string | null>(finish => {
        const done = (pick: () => Gio.File | null) => {
            try {
                finish(pick()?.get_path() ?? null);
            } catch {
                finish(null);   // dibatalkan (Gtk.DialogError.DISMISSED) atau gagal
            }
        };
        if (selectFolder) dialog.select_folder(parent, null, (_d, res) => done(() => dialog.select_folder_finish(res)));
        else if (save) dialog.save(parent, null, (_d, res) => done(() => dialog.save_finish(res)));
        else dialog.open(parent, null, (_d, res) => done(() => dialog.open_finish(res)));
    });
}

// Jendela modal berisi `content` dan sebaris tombol di bawahnya; mengembalikan indeks tombol
// yang ditekan, atau `cancel` jika ditutup (Escape atau tombol jendela). Tombol `preferred`
// menjadi tombol bawaan (Enter di kolom isian dengan activates_default). `accept(i)` = false
// membiarkan jendela tetap terbuka (misalnya isian tidak valid).
//
// Bukan Gtk.AlertDialog dan tanpa destroy_with_parent: keduanya menghubungkan dialog ke sinyal
// "destroy" jendela induk, dan saat proses keluar GJS bisa memfinalisasi induk lebih dulu
// sehingga muncul GLib-GObject-CRITICAL. Induk juga dilepas (transient_for null) begitu selesai.
function modalWindow(parent: Gtk.Window | null, title: string, width: number, content: Gtk.Widget, buttons: string[],
    cancel: number, preferred: number, accept: (index: number) => boolean = () => true, resizable = true): number {
    const win = new Gtk.Window({ title, transient_for: parent, modal: true, default_width: width, resizable });
    const actions = new Gtk.Box({ spacing: 8, halign: Gtk.Align.END });
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, margin_top: 16, margin_bottom: 12, margin_start: 16, margin_end: 16 });
    box.append(content);
    box.append(actions);
    win.set_child(box);
    onKeyPress(win, keyval => {
        if (keyval !== Gdk.KEY_Escape) return false;
        win.close();
        return true;
    });
    const answer = runModal<number>(finish => {
        buttons.forEach((label, i) => {
            const button = new Gtk.Button({ label });
            if (i === preferred) {
                button.add_css_class('suggested-action');
                win.set_default_widget(button);
            }
            button.connect('clicked', () => { if (accept(i)) finish(i); });
            actions.append(button);
        });
        win.connect('close-request', () => {
            finish(cancel);
            return false;
        });
        win.present();
        // Fokus awal di tombol bawaan, kecuali isian sudah merebutnya.
        if (!(win.get_focus() instanceof Gtk.Text)) win.get_default_widget()?.grab_focus();
    });
    win.set_transient_for(null);
    win.destroy();
    return answer;
}

// Pesan singkat dengan beberapa tombol.
function alert(parent: Gtk.Window | null, message: string, detail: string | null, buttons: string[], cancel: number, preferred: number): number {
    const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
    const heading = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 48 });
    heading.set_markup(`<b>${GLib.markup_escape_text(message, -1)}</b>`);
    content.append(heading);
    if (detail) content.append(new Gtk.Label({ label: detail, xalign: 0, wrap: true, max_width_chars: 48 }));
    return modalWindow(parent, '', 380, content, buttons, cancel, preferred, () => true, false);
}

// Mengembalikan 'save', 'discard', atau 'cancel'.
export function askSaveChanges(parent: Gtk.Window, documentName: string): 'save' | 'discard' | 'cancel' {
    const answer = alert(parent, `Simpan perubahan pada “${documentName}”?`, 'Perubahan akan hilang jika tidak disimpan.',
        ['Jangan Simpan', 'Batal', 'Simpan'], 1, 2);
    return answer === 2 ? 'save' : answer === 0 ? 'discard' : 'cancel';
}

export function showError(parent: Gtk.Window | null, message: string): void {
    alert(parent, message, null, ['Tutup'], 0, 0);
}

export function showAbout(parent: Gtk.Window): void {
    const dialog = new Gtk.AboutDialog({
        transient_for: parent, modal: true, program_name: APP_NAME, version: APP_VERSION,
        logo_icon_name: 'accessories-text-editor',
        comments: 'Personal workbench AI agent untuk catatan, dokumen, riset, dan rencana, dengan GTK 4 dan GJS.',
    });
    dialog.present();
}

// Jendela formulir modal: isi di atas, tombol Batal/`accept` di bawah. `validate` dipanggil
// saat tombol utama ditekan; false = jendela tetap terbuka. true = diterima.
function formDialog(parent: Gtk.Window | null, title: string, width: number, content: Gtk.Widget, accept: string, validate: () => boolean = () => true): boolean {
    return modalWindow(parent, title, width, content, ['Batal', accept], 0, 1, i => i === 0 || validate()) === 1;
}

// ---------- Dialog untuk papan kanban ----------

export interface CardDraft {
    text: string;
    notes: string[];
}

// Dialog sunting kartu: judul (satu baris) dan catatan (banyak baris).
// Mengembalikan isi baru, atau null jika dibatalkan.
export function editCardDialog(parent: Gtk.Window | null, card: CardDraft, heading = 'Sunting Kartu'): CardDraft | null {
    const parts = splitCard(card.text);
    const title = new Gtk.Entry({ text: parts.title, activates_default: true, hexpand: true });
    const tags = new Gtk.Entry({ text: parts.tags.join(' '), activates_default: true, hexpand: true, placeholder_text: 'tag1 tag2' });
    const due = new Gtk.Entry({ text: parts.due, activates_default: true, hexpand: true, placeholder_text: 'YYYY-MM-DD' });
    due.connect('changed', () => due.remove_css_class('error'));
    const agent = new Gtk.Entry({ text: parts.agent ?? '', activates_default: true, hexpand: true, placeholder_text: 'mis. pi (kosong = tidak ditugaskan)' });
    agent.connect('changed', () => agent.remove_css_class('error'));
    const notes = new Gtk.TextView({ wrap_mode: Gtk.WrapMode.WORD_CHAR, left_margin: 6, right_margin: 6, top_margin: 6, bottom_margin: 6 });
    notes.buffer.set_text(card.notes.join('\n'), -1);
    const frame = new Gtk.ScrolledWindow({ min_content_height: 140, has_frame: true, hexpand: true, vexpand: true });
    frame.set_child(notes);

    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, vexpand: true });
    box.append(new Gtk.Label({ label: 'Judul', xalign: 0 }));
    box.append(title);
    box.append(new Gtk.Label({ label: 'Tag (pisahkan dengan spasi)', xalign: 0 }));
    box.append(tags);
    box.append(new Gtk.Label({ label: 'Tenggat', xalign: 0 }));
    box.append(due);
    box.append(new Gtk.Label({ label: 'Dikerjakan oleh', xalign: 0 }));
    box.append(agent);
    box.append(new Gtk.Label({ label: 'Catatan', xalign: 0 }));
    box.append(frame);

    // Ctrl+Enter menyimpan dari kolom catatan (Enter biasa membuat baris baru).
    onKeyPress(notes, (keyval, state) => {
        if ((keyval !== Gdk.KEY_Return && keyval !== Gdk.KEY_KP_Enter) || !(state & Gdk.ModifierType.CONTROL_MASK)) return false;
        (notes.get_root() as Gtk.Window | null)?.get_default_widget()?.activate();
        return true;
    }, Gtk.PropagationPhase.CAPTURE);

    // Tenggat harus kosong atau berformat tanggal; selain itu dialog tetap terbuka.
    const accepted = formDialog(parent, heading, 440, box, 'Simpan', () => {
        const name = agent.text.trim().replace(/^@+/, '').toLowerCase();
        if (name && !AGENT_NAME.test(name)) {
            agent.add_css_class('error');
            agent.grab_focus();
            return false;
        }
        if (!due.text.trim() || DUE_INPUT.test(due.text.trim())) return true;
        due.add_css_class('error');
        due.grab_focus();
        return false;
    });
    if (!accepted) return null;
    const [start, end] = notes.buffer.get_bounds();
    return {
        text: composeCard({ title: title.text, tags: tags.text.split(/[\s,]+/), due: due.text, agent: agent.text }),
        notes: notes.buffer.get_text(start, end, true).replace(/\s+$/, '').split('\n').filter((l, i, all) => all.length > 1 || l !== ''),
    };
}

// Meminta satu baris teks. null jika dibatalkan.
export function promptDialog(parent: Gtk.Window | null, options: { title: string; label: string; value?: string }): string | null {
    const entry = new Gtk.Entry({ text: options.value ?? '', activates_default: true });
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 });
    box.append(new Gtk.Label({ label: options.label, xalign: 0 }));
    box.append(entry);
    const accepted = formDialog(parent, options.title, 360, box, 'OK');
    const value = entry.text.trim();
    return accepted && value ? value : null;
}

export function confirmDialog(parent: Gtk.Window | null, message: string, detail?: string): boolean {
    return alert(parent, message, detail ?? null, ['Batal', 'Hapus'], 0, 1) === 1;
}

// ---------- Dialog harness eksternal ----------

// Teks panjang (pertanyaan atau jawaban terakhir harness) yang bisa dipilih dan digulir.
function quoted(text: string, maxHeight = 240): Gtk.Widget {
    // Bisa diseleksi dengan mouse untuk disalin, tetapi tidak menerima fokus keyboard: label fokus pertama memilih
    // seluruh teksnya dan merebut fokus dari kotak jawaban.
    const label = new Gtk.Label({ label: text, xalign: 0, yalign: 0, wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR, selectable: true, focusable: false, max_width_chars: 60 });
    const scroller = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, propagate_natural_height: true, max_content_height: maxHeight, has_frame: true });
    label.margin_start = label.margin_end = label.margin_top = label.margin_bottom = 8;
    scroller.set_child(label);
    return scroller;
}

function textArea(prefill = ''): { widget: Gtk.Widget; text: () => string; view: Gtk.TextView } {
    const view = new Gtk.TextView({ wrap_mode: Gtk.WrapMode.WORD_CHAR, left_margin: 6, right_margin: 6, top_margin: 6, bottom_margin: 6 });
    view.buffer.set_text(prefill, -1);
    const frame = new Gtk.ScrolledWindow({ min_content_height: 90, has_frame: true, hexpand: true, vexpand: true });
    frame.set_child(view);
    const text = () => { const [a, b] = view.buffer.get_bounds(); return view.buffer.get_text(a, b, true); };
    return { widget: frame, text, view };
}

// Jawab permintaan harness. null = "Nanti" (harness tetap menunggu).
export function harnessAskDialog(parent: Gtk.Window | null, ask: HarnessAsk, agent: string): HarnessReply | null {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, vexpand: true });
    const heading = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 60 });
    heading.set_markup(`<b>${GLib.markup_escape_text(ask.title, -1)}</b>`);
    box.append(heading);
    if (ask.message && ask.kind !== 'input') box.append(quoted(ask.message, ask.kind === 'question' ? 320 : 160));

    let value: () => string = () => '';
    let options: Gtk.CheckButton[] = [];
    let focus: Gtk.Widget | null = null;
    if (ask.kind === 'question' || ask.kind === 'editor') {
        const area = textArea(ask.prefill);
        box.append(new Gtk.Label({ label: ask.kind === 'question' ? 'Jawaban Anda' : 'Isi', xalign: 0 }));
        box.append(area.widget);
        value = area.text;
        focus = area.view;
    } else if (ask.kind === 'input') {
        const entry = new Gtk.Entry({ placeholder_text: ask.message, activates_default: true, hexpand: true });
        box.append(entry);
        value = () => entry.text;
        focus = entry;
    } else if (ask.kind === 'select') {
        options = ask.options.map((label, i) => new Gtk.CheckButton({ label, active: i === 0 }));
        options.forEach((o, i) => { if (i) o.set_group(options[0]); box.append(o); });
        value = () => ask.options[options.findIndex(o => o.active)] ?? '';
    }
    if (ask.timeout) {
        const hint = new Gtk.Label({ label: `${agent} memakai jawaban bawaannya bila tidak dijawab dalam ${Math.round(ask.timeout / 1000)} detik.`, xalign: 0, wrap: true });
        hint.add_css_class('dim-label');
        box.append(hint);
    }

    // modalWindow memfokuskan tombol bawaan setelah jendela tampil; kotak isian direbut kembali sesudahnya.
    if (focus) GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { focus!.grab_focus(); return GLib.SOURCE_REMOVE; });
    const title = `Jawab ${agent}`;
    if (ask.kind === 'confirm') {
        const i = modalWindow(parent, title, 460, box, ['Nanti', 'Tolak', 'Izinkan'], 0, 2);
        return i === 0 ? null : { confirmed: i === 2 };
    }
    const skip = ask.kind === 'question' ? 'Akhiri tanpa membalas' : 'Lewati';
    const send = ask.kind === 'select' ? 'Pilih' : 'Kirim';
    const i = modalWindow(parent, title, 520, box, ['Nanti', skip, send], 0, 2, k => k !== 2 || !!value().trim() || ask.kind === 'editor');
    return i === 0 ? null : i === 1 ? { cancelled: true } : { value: value() };
}

// Teks bebas untuk harness (arahan saat bekerja, balasan setelah selesai). context = jawaban terakhir harness.
export function harnessTextDialog(parent: Gtk.Window | null, options: { title: string; label: string; context?: string }): string | null {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, vexpand: true });
    if (options.context) {
        box.append(new Gtk.Label({ label: 'Jawaban terakhir', xalign: 0 }));
        box.append(quoted(options.context));
    }
    box.append(new Gtk.Label({ label: options.label, xalign: 0 }));
    const area = textArea();
    box.append(area.widget);
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { area.view.grab_focus(); return GLib.SOURCE_REMOVE; });
    const accepted = modalWindow(parent, options.title, 520, box, ['Batal', 'Kirim'], 0, 1, i => i === 0 || !!area.text().trim()) === 1;
    return accepted ? area.text().trim() : null;
}
