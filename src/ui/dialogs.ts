// Dialog standar: pilih file, konfirmasi simpan, pesan error, tentang.
// Dialog memakai libadwaita (Adw.Dialog, Adw.AlertDialog), bersifat modal, dan mengembalikan Promise
// yang selesai saat dijawab (modal() di gtkutil.ts). Tidak ada main loop bersarang: pemanggil
// melanjutkan lewat after()/await, sehingga handler lain tidak berjalan di tengah-tengahnya.

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import { attachWikiCompleter } from '../editor/wikicomplete.js';
import { childrenOf, modal, onKeyPress } from '../gtkutil.js';
import { APP_ID, APP_NAME, APP_VERSION } from '../config.js';
import { composeItem, itemMeta } from '../markdown/inbox.js';
import { AGENT_NAME, composeCard, DUE_INPUT, splitCard, withDueDate } from '../markdown/kanban.js';
import type { HarnessAsk, HarnessReply } from '../agent/harness.js';
import { _, fmt } from '../i18n.js';

type FilterSetup = [label: string, setup: (filter: Gtk.FileFilter) => void];

export const FILTERS = {
    markdown: [_('Markdown'), f => ['*.md', '*.markdown', '*.mdown', '*.txt'].forEach(p => f.add_pattern(p))],
    image: [_('Gambar'), f => f.add_mime_type('image/*')],
    html: [_('HTML'), f => f.add_pattern('*.html')],
    all: [_('Semua file'), f => f.add_pattern('*')],
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
export function chooseFile(parent: Gtk.Window, { title, save = false, selectFolder = false, filters = [], name = null, folder = null }: ChooseFileOptions): Promise<string | null> {
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
    return modal<string | null>(finish => {
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

// Jendela tempat dialog ditampilkan: induk yang diberikan, atau jendela terlihat pertama.
// Adw.Dialog selalu menempel pada satu jendela; tanpa jendela sama sekali tak ada yang bisa ditampilkan.
function hostWindow(parent: Gtk.Window | null): Gtk.Window | null {
    return parent ?? (Gtk.Window.list_toplevels().find(t => t instanceof Gtk.Window && t.get_visible()) as Gtk.Window | undefined) ?? null;
}

// Dialog yang sedang tampil dengan judul `title` (untuk tangkapan layar dan tes), atau null.
// Adw.Dialog bukan jendela sendiri, jadi tidak muncul di Gtk.Window.list_toplevels().
export function findDialog(title: string): Adw.Dialog | null {
    for (const top of Gtk.Window.list_toplevels()) {
        if (!(top instanceof Adw.ApplicationWindow)) continue;
        const dialog = top.get_visible_dialog();
        if (dialog instanceof Adw.Dialog && dialog.title === title) return dialog;
    }
    return null;
}

// Semua Gtk.Entry di bawah `widget`.
function entriesIn(widget: Gtk.Widget): Gtk.Entry[] {
    return childrenOf(widget).flatMap(child => child instanceof Gtk.Entry ? [child] : entriesIn(child));
}

// Dialog modal (Adw.Dialog) berisi `content` dan sebaris tombol di bawahnya; mengembalikan indeks tombol
// yang ditekan, atau `cancel` jika ditutup (Escape). Tombol `preferred` menjadi tombol bawaan
// (Enter di kolom isian dengan activates_default). `accept(i)` = false membiarkan dialog tetap
// terbuka (misalnya isian tidak valid). Tanpa jendela induk: dianggap dibatalkan.
//
// Dialog menempel pada jendela induk dan ditutup dengan force_close() begitu selesai, sehingga
// tidak ada yang tertinggal saat proses keluar.
async function modalWindow(parent: Gtk.Window | null, title: string, width: number, content: Gtk.Widget, buttons: string[],
    cancel: number, preferred: number, accept: (index: number) => boolean = () => true): Promise<number> {
    const host = hostWindow(parent);
    if (!host) return cancel;
    const dialog = new Adw.Dialog({ title, content_width: width });
    const actions = new Gtk.Box({ spacing: 8, halign: Gtk.Align.END });
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, margin_top: 16, margin_bottom: 12, margin_start: 16, margin_end: 16 });
    box.append(content);
    box.append(actions);
    const view = new Adw.ToolbarView({ content: box });
    view.add_top_bar(new Adw.HeaderBar());
    dialog.set_child(view);
    const answer = await modal<number>(finish => {
        buttons.forEach((label, i) => {
            const button = new Gtk.Button({ label });
            if (i === preferred) {
                button.add_css_class('suggested-action');
                dialog.set_default_widget(button);
            }
            button.connect('clicked', () => { if (accept(i)) finish(i); });
            actions.append(button);
        });
        // Enter di isian menekan tombol bawaan. Adw.Dialog meneruskan Enter ke default-widget hanya
        // lewat jalurnya sendiri; ini membuat perilakunya sama untuk setiap isian.
        for (const entry of entriesIn(content)) {
            if (entry.activates_default) entry.connect('activate', () => (dialog.get_default_widget() as Gtk.Button | null)?.emit('clicked'));
        }
        dialog.connect('closed', () => finish(cancel));
        dialog.present(host);
        // Fokus awal di tombol bawaan, kecuali isian sudah merebutnya.
        if (!(dialog.get_focus() instanceof Gtk.Text)) dialog.get_default_widget()?.grab_focus();
    });
    dialog.force_close();
    return answer;
}

// Pesan singkat dengan beberapa tombol (Adw.AlertDialog). `destructive` = indeks tombol yang
// berbahaya (merah); tombol `preferred` yang lain disorot sebagai saran.
function alert(parent: Gtk.Window | null, message: string, detail: string | null, buttons: string[], cancel: number, preferred: number, destructive = -1): Promise<number> {
    const host = hostWindow(parent);
    if (!host) return Promise.resolve(cancel);
    const dialog = new Adw.AlertDialog({ heading: message, body: detail ?? '' });
    buttons.forEach((label, i) => {
        dialog.add_response(String(i), label);
        if (i === destructive) dialog.set_response_appearance(String(i), Adw.ResponseAppearance.DESTRUCTIVE);
        else if (i === preferred && buttons.length > 1) dialog.set_response_appearance(String(i), Adw.ResponseAppearance.SUGGESTED);
    });
    dialog.set_default_response(String(preferred));
    dialog.set_close_response(String(cancel));
    return modal<number>(finish => {
        dialog.connect('response', (_d, id) => finish(Number(id)));
        dialog.present(host);
    });
}

export async function askSaveChanges(parent: Gtk.Window, documentName: string): Promise<'save' | 'discard' | 'cancel'> {
    const answer = await alert(parent, fmt(_('Simpan perubahan pada “{name}”?'), { name: documentName }), _('Perubahan akan hilang jika tidak disimpan.'),
        [_('Jangan Simpan'), _('Batal'), _('Simpan')], 1, 2, 0);
    return answer === 2 ? 'save' : answer === 0 ? 'discard' : 'cancel';
}

export async function showError(parent: Gtk.Window | null, message: string): Promise<void> {
    await alert(parent, message, null, [_('Tutup')], 0, 0);
}

export function showAbout(parent: Gtk.Window): void {
    const dialog = new Adw.AboutDialog({
        application_name: APP_NAME, version: APP_VERSION, application_icon: APP_ID,
        developer_name: 'Eka Putra', license_type: Gtk.License.MIT_X11,
        comments: _('Personal workbench for humans and AI agents, dibuat dengan GTK 4, libadwaita, dan GJS.'),
        website: 'https://nyerat.ekaput.com/', support_url: 'https://nyerat.ekaput.com/docs/',
        developers: ['Eka Putra'], copyright: '© 2026 Eka Putra',
        // Penerjemah: ganti dengan nama Anda (satu per baris), mis. "Nama <surel>".
        translator_credits: _('translator-credits'),
    });
    dialog.present(parent);
}

// Jendela formulir modal: isi di atas, tombol Batal/`accept` di bawah. `validate` dipanggil
// saat tombol utama ditekan; false = jendela tetap terbuka. true = diterima.
async function formDialog(parent: Gtk.Window | null, title: string, width: number, content: Gtk.Widget, accept: string, validate: () => boolean = () => true): Promise<boolean> {
    return await modalWindow(parent, title, width, content, [_('Batal'), accept], 0, 1, i => i === 0 || validate()) === 1;
}

// ---------- Dialog untuk papan kanban ----------

export interface CardDraft {
    text: string;
    notes: string[];
}

// Kolom tenggat: teks (tetap bisa diketik, mis. dengan jam) dan tombol kalender di sebelahnya.
// Kalender dibuka pada tanggal di kolom (atau hari ini); memilih tanggal mengisi kolom lalu menutup kalender.
export interface DueField {
    widget: Gtk.Widget;
    entry: Gtk.Entry;
    button: Gtk.MenuButton;
    calendar: Gtk.Calendar;
}

export function dueField(text: string): DueField {
    const entry = new Gtk.Entry({ text, activates_default: true, hexpand: true, placeholder_text: _('YYYY-MM-DD') });
    entry.connect('changed', () => entry.remove_css_class('error'));
    const calendar = new Gtk.Calendar();
    const today = new Gtk.Button({ label: _('Hari ini'), hexpand: true });
    const clear = new Gtk.Button({ label: _('Kosongkan'), hexpand: true });
    const actions = new Gtk.Box({ spacing: 6 });
    actions.append(today);
    actions.append(clear);
    const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
    content.append(calendar);
    content.append(actions);
    const popover = new Gtk.Popover({ child: content });
    const button = new Gtk.MenuButton({ icon_name: 'x-office-calendar-symbolic', tooltip_text: _('Pilih tanggal'), popover });

    // Saat membuka, kalender menunjuk tanggal di kolom; `syncing` mencegah pilihan itu menulis balik ke kolom.
    let syncing = false;
    popover.connect('show', () => {
        const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(entry.text.trim());
        const date = match ? GLib.DateTime.new_local(+match[1], +match[2], +match[3], 0, 0, 0) : null;
        syncing = true;
        calendar.select_day(date ?? GLib.DateTime.new_now_local());
        syncing = false;
    });
    const pick = (date: GLib.DateTime) => {
        entry.text = withDueDate(entry.text, date.format('%Y-%m-%d')!);
        popover.popdown();
    };
    calendar.connect('day-selected', () => { if (!syncing) pick(calendar.get_date()); });
    today.connect('clicked', () => pick(GLib.DateTime.new_now_local()));
    clear.connect('clicked', () => { entry.text = ''; popover.popdown(); });

    const widget = new Gtk.Box({ spacing: 0 });
    widget.add_css_class('linked');
    widget.append(entry);
    widget.append(button);
    return { widget, entry, button, calendar };
}

// Dialog sunting kartu: judul (satu baris) dan catatan (banyak baris).
// Mengembalikan isi baru, atau null jika dibatalkan.
// listNotes: berkas Markdown di folder kerja, untuk saran saat mengetik [[ di catatan.
export async function editCardDialog(parent: Gtk.Window | null, card: CardDraft, heading = _('Sunting Kartu'), listNotes?: () => string[]): Promise<CardDraft | null> {
    const parts = splitCard(card.text);
    const title = new Gtk.Entry({ text: parts.title, activates_default: true, hexpand: true });
    const tags = new Gtk.Entry({ text: parts.tags.join(' '), activates_default: true, hexpand: true, placeholder_text: _('tag1 tag2') });
    const dueInput = dueField(parts.due);
    const due = dueInput.entry;
    const agent = new Gtk.Entry({ text: parts.agent ?? '', activates_default: true, hexpand: true, placeholder_text: _('mis. pi (kosong = tidak ditugaskan)') });
    agent.connect('changed', () => agent.remove_css_class('error'));
    const notes = new Gtk.TextView({ wrap_mode: Gtk.WrapMode.WORD_CHAR, left_margin: 6, right_margin: 6, top_margin: 6, bottom_margin: 6 });
    notes.buffer.set_text(card.notes.join('\n'), -1);
    const frame = new Gtk.ScrolledWindow({ min_content_height: 140, has_frame: true, hexpand: true, vexpand: true });
    frame.set_child(notes);
    const completer = listNotes ? attachWikiCompleter(notes, listNotes) : null;

    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, vexpand: true });
    box.append(new Gtk.Label({ label: _('Judul'), xalign: 0 }));
    box.append(title);
    box.append(new Gtk.Label({ label: _('Tag (pisahkan dengan spasi)'), xalign: 0 }));
    box.append(tags);
    box.append(new Gtk.Label({ label: _('Tenggat'), xalign: 0 }));
    box.append(dueInput.widget);
    box.append(new Gtk.Label({ label: _('Dikerjakan oleh'), xalign: 0 }));
    box.append(agent);
    box.append(new Gtk.Label({ label: listNotes ? _('Catatan · [[Nama]] menautkan catatan lain sebagai konteks agent') : _('Catatan'), xalign: 0, wrap: true }));
    box.append(frame);

    // Ctrl+Enter menyimpan dari kolom catatan (Enter biasa membuat baris baru).
    onKeyPress(notes, (keyval, state) => {
        if ((keyval !== Gdk.KEY_Return && keyval !== Gdk.KEY_KP_Enter) || !(state & Gdk.ModifierType.CONTROL_MASK)) return false;
        (notes.get_ancestor(Adw.Dialog.$gtype) as Adw.Dialog | null)?.get_default_widget()?.activate();
        return true;
    }, Gtk.PropagationPhase.CAPTURE);

    // Tenggat harus kosong atau berformat tanggal; selain itu dialog tetap terbuka.
    const accepted = await formDialog(parent, heading, 440, box, _('Simpan'), () => {
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
    completer?.destroy();
    if (!accepted) return null;
    const [start, end] = notes.buffer.get_bounds();
    return {
        text: composeCard({ title: title.text, tags: tags.text.split(/[\s,]+/), due: due.text, agent: agent.text }),
        notes: notes.buffer.get_text(start, end, true).replace(/\s+$/, '').split('\n').filter((l, i, all) => all.length > 1 || l !== ''),
    };
}

// Sunting catatan inbox: judul, tag, dan catatan. `item.text` null = catatan baru.
export async function editNoteDialog(parent: Gtk.Window | null, item: CardDraft, heading = _('Sunting Catatan'), listNotes?: () => string[]): Promise<CardDraft | null> {
    const meta = itemMeta(item.text);
    const title = new Gtk.Entry({ text: meta.title, activates_default: true, hexpand: true, placeholder_text: _('Ide, tautan, atau catatan cepat') });
    const tags = new Gtk.Entry({ text: meta.tags.join(' '), activates_default: true, hexpand: true, placeholder_text: _('tag1 tag2') });
    const notes = new Gtk.TextView({ wrap_mode: Gtk.WrapMode.WORD_CHAR, left_margin: 6, right_margin: 6, top_margin: 6, bottom_margin: 6 });
    notes.buffer.set_text(item.notes.join('\n'), -1);
    const frame = new Gtk.ScrolledWindow({ min_content_height: 140, has_frame: true, hexpand: true, vexpand: true });
    frame.set_child(notes);
    const completer = listNotes ? attachWikiCompleter(notes, listNotes) : null;

    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, vexpand: true });
    box.append(new Gtk.Label({ label: _('Judul'), xalign: 0 }));
    box.append(title);
    box.append(new Gtk.Label({ label: _('Tag (pisahkan dengan spasi)'), xalign: 0 }));
    box.append(tags);
    box.append(new Gtk.Label({ label: _('Catatan'), xalign: 0 }));
    box.append(frame);

    // Ctrl+Enter menyimpan dari kolom catatan (Enter biasa membuat baris baru).
    onKeyPress(notes, (keyval, state) => {
        if ((keyval !== Gdk.KEY_Return && keyval !== Gdk.KEY_KP_Enter) || !(state & Gdk.ModifierType.CONTROL_MASK)) return false;
        (notes.get_ancestor(Adw.Dialog.$gtype) as Adw.Dialog | null)?.get_default_widget()?.activate();
        return true;
    }, Gtk.PropagationPhase.CAPTURE);

    const accepted = await formDialog(parent, heading, 440, box, _('Simpan'), () => {
        if (title.text.trim()) return true;
        title.add_css_class('error');
        title.grab_focus();
        return false;
    });
    completer?.destroy();
    if (!accepted) return null;
    const [start, end] = notes.buffer.get_bounds();
    return {
        text: composeItem(title.text, tags.text.split(/[\s,]+/), item.text),
        notes: notes.buffer.get_text(start, end, true).replace(/\s+$/, '').split('\n').filter((l, i, all) => all.length > 1 || l !== ''),
    };
}

// Meminta satu baris teks. null jika dibatalkan. accept = label tombol setuju (kata kerja), bawaan "OK".
export async function promptDialog(parent: Gtk.Window | null, options: { title: string; label: string; value?: string; accept?: string }): Promise<string | null> {
    const entry = new Gtk.Entry({ text: options.value ?? '', activates_default: true });
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 });
    box.append(new Gtk.Label({ label: options.label, xalign: 0 }));
    box.append(entry);
    const accepted = await formDialog(parent, options.title, 360, box, options.accept ?? _('OK'));
    const value = entry.text.trim();
    return accepted && value ? value : null;
}

export async function confirmDialog(parent: Gtk.Window | null, message: string, detail?: string): Promise<boolean> {
    return await alert(parent, message, detail ?? null, [_('Batal'), _('Hapus')], 0, 1, 1) === 1;
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
export async function harnessAskDialog(parent: Gtk.Window | null, ask: HarnessAsk, agent: string): Promise<HarnessReply | null> {
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
        box.append(new Gtk.Label({ label: ask.kind === 'question' ? _('Jawaban Anda') : _('Isi'), xalign: 0 }));
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
        const hint = new Gtk.Label({ label: fmt(_('{agent} memakai jawaban bawaannya bila tidak dijawab dalam {seconds} detik.'), { agent, seconds: Math.round(ask.timeout / 1000) }), xalign: 0, wrap: true });
        hint.add_css_class('dim-label');
        box.append(hint);
    }

    // modalWindow memfokuskan tombol bawaan setelah jendela tampil; kotak isian direbut kembali sesudahnya.
    if (focus) GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { focus!.grab_focus(); return GLib.SOURCE_REMOVE; });
    const title = fmt(_('Jawab {agent}'), { agent });
    if (ask.kind === 'confirm') {
        const i = await modalWindow(parent, title, 460, box, [_('Nanti'), _('Tolak'), _('Izinkan')], 0, 2);
        return i === 0 ? null : { confirmed: i === 2 };
    }
    const skip = ask.kind === 'question' ? _('Akhiri tanpa membalas') : _('Lewati');
    const send = ask.kind === 'select' ? _('Pilih') : _('Kirim');
    const i = await modalWindow(parent, title, 520, box, [_('Nanti'), skip, send], 0, 2, k => k !== 2 || !!value().trim() || ask.kind === 'editor');
    return i === 0 ? null : i === 1 ? { cancelled: true } : { value: value() };
}

// Teks bebas untuk harness (arahan saat bekerja, balasan setelah selesai). context = jawaban terakhir harness.
export async function harnessTextDialog(parent: Gtk.Window | null, options: { title: string; label: string; context?: string }): Promise<string | null> {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, vexpand: true });
    if (options.context) {
        box.append(new Gtk.Label({ label: _('Jawaban terakhir'), xalign: 0 }));
        box.append(quoted(options.context));
    }
    box.append(new Gtk.Label({ label: options.label, xalign: 0 }));
    const area = textArea();
    box.append(area.widget);
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { area.view.grab_focus(); return GLib.SOURCE_REMOVE; });
    const accepted = await modalWindow(parent, options.title, 520, box, [_('Batal'), _('Kirim')], 0, 1, i => i === 0 || !!area.text().trim()) === 1;
    return accepted ? area.text().trim() : null;
}
