// Panel Asisten di sisi kanan: chat dengan model (DeepSeek) yang tahu isi naskah.
// Panel tidak tahu cara mengambil naskah; jendela memberikannya lewat `host`. Penyusunan konteks
// ada di agent/context.ts, dan pemanggilan modelnya lewat Provider (agent/provider.ts).
//
//   ┌ ASISTEN                 ⌫ ⚙ ┐
//   │ (pesan, terbaru di bawah)    │
//   │ Konteks · ≈12 rb token ▾     │
//   │ [ketik pertanyaan…     ] [➤] │
//   └──────────────────────────────┘

import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { systemKeyStore, type KeySource, type KeyStore } from '../agent/apikey.js';
import { buildContext, DEFAULT_BUDGET, findMentions, type BuiltContext, type ContextOptions, type SourceFile } from '../agent/context.js';
import { deleteChat, listChats, loadChat, nowStamp, saveChat, titleFrom } from '../agent/chatstore.js';
import { DEEPSEEK_MODELS, DeepSeek } from '../agent/deepseek.js';
import type { Provider, Usage } from '../agent/provider.js';
import { ChatSession, type ProposalResult, type ToolStep } from '../agent/session.js';
import { diffPreview, describeChange, type Change } from '../agent/changes.js';
import { chatMarkup } from '../markdown/chatmarkup.js';
import { escapeMarkup, type MarkupColors } from '../markdown/pango.js';
import type { Palette } from './theme.js';
import { childrenOf, onKeyPress, pack } from '../gtkutil.js';

// Yang perlu diketahui panel dari jendela.
export interface ChatHost {
    active(): { name: string; text: string; cursorLine: number } | null;   // dokumen terbuka (isi buffer, bukan disk)
    selection(): string;
    files(): SourceFile[];                                                  // berkas lain di folder proyek
    // Terapkan perubahan yang sudah disetujui pengguna. Mengembalikan pesan galat, atau null bila berhasil.
    applyChange?(change: Change): string | null;
    root(): string | null;                                                  // folder naskah; tempat riwayat percakapan disimpan
}

const SOURCE_TEXT: Record<KeySource, string> = {
    env: 'Memakai key dari variabel lingkungan DEEPSEEK_API_KEY.',
    keyring: 'Key tersimpan di keyring sistem.',
    file: 'Key tersimpan di ~/.config/nyerat/deepseek.key (keyring tidak tersedia).',
};

const SUGGESTIONS = [
    'Ringkas dokumen ini dalam beberapa poin',
    'Adakah bagian yang tidak konsisten dengan berkas lain?',
    'Beri masukan untuk bagian yang sedang saya tulis',
];

const KIND_LABEL = { map: 'Peta', active: 'Dokumen', selection: 'Pilihan', mention: 'Lampiran', excerpt: 'Potongan' } as const;

const fmtTokens = (n: number): string => n >= 1000 ? `${(n / 1000).toFixed(1).replace('.', ',')} rb` : `${n}`;

const usageText = (u: Usage, toolCalls: number, applied = 0): string =>
    `${fmtTokens(u.prompt)} masuk${u.cached ? ` (${fmtTokens(u.cached)} dari cache)` : ''} · ${fmtTokens(u.completion)} keluar${toolCalls ? ` · ${toolCalls} penelusuran` : ''}${applied ? ` · ${applied} perubahan diterapkan` : ''}`;

interface Bubble {
    label: Gtk.Label;
    text: string;
    markdown: boolean;
}

export class ChatPanel {
    readonly widget: Gtk.Box;
    readonly input: Gtk.TextView;
    readonly sendButton: Gtk.Button;
    readonly messages: Gtk.Box;
    readonly scroller: Gtk.ScrolledWindow;
    readonly contextButton: Gtk.MenuButton;
    readonly settingsButton: Gtk.MenuButton;
    readonly historyButton: Gtk.MenuButton;
    readonly saveCheck: Gtk.CheckButton;
    readonly keyEntry: Gtk.Entry;
    readonly keyStatus: Gtk.Label;
    readonly session = new ChatSession();

    host: ChatHost = { active: () => null, selection: () => '', files: () => [], root: () => null };
    // Diganti di tes dengan penyedia palsu.
    makeProvider: (key: string) => Provider = key => new DeepSeek(key);
    keyStore: KeyStore = systemKeyStore;
    model = DEEPSEEK_MODELS[0];   // model dikirim apa adanya ke API; setModel() menormalkannya
    onModelChanged: (model: string) => void = () => {};
    onThinkingChanged: (thinking: boolean) => void = () => {};
    onSaveChanged: (save: boolean) => void = () => {};
    saveChats = true;   // simpan tiap giliran ke <folder>/.nyerat/chats
    options: ContextOptions = { activeDocument: true, selection: true, project: true };
    budget = DEFAULT_BUDGET;

    private colors: MarkupColors = { code: '#c7254e', codeBg: '#f3f4f4', link: '#4183c4', mark: '#fff3a3' };
    private readonly bubbles: Bubble[] = [];
    readonly empty: Gtk.Box;           // petunjuk awal; tampil selama percakapan kosong
    private readonly contextList: Gtk.Box;
    readonly modelCombo: Gtk.ComboBoxText;
    readonly thinkingCheck: Gtk.CheckButton;
    private cancellable: Gio.Cancellable | null = null;
    private renderTimer = 0;
    private stick = true;            // tetap menempel di bawah selama pengguna tidak menggulir ke atas
    private summaryTimer = 0;
    // Percakapan yang sedang tampil di disk: berkasnya (null = belum ditulis), folder asalnya, dan judulnya.
    private chatPath: string | null = null;
    private chatRoot: string | null = null;
    private chatTitle = '';
    private chatCreated = '';
    private readonly chatList: Gtk.Box;
    private readonly stepLabels = new Map<string, Gtk.Label>();   // id panggilan alat → baris langkahnya

    constructor() {
        const title = new Gtk.Label({ label: 'ASISTEN', xalign: 0, margin_start: 16 });
        title.add_css_class('side-title');
        const clear = Gtk.Button.new_from_icon_name('edit-clear-all-symbolic');
        clear.set_has_frame(false);
        clear.set_tooltip_text('Percakapan baru');
        clear.connect('clicked', () => this.reset());
        this.chatList = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
        const listScroll = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, min_content_width: 300, max_content_height: 280, propagate_natural_height: true });
        listScroll.set_child(this.chatList);
        const listBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12 });
        listBox.add_css_class('chat-pop');
        listBox.set_size_request(320, -1);
        listBox.append(this.label('Percakapan sebelumnya'));
        listBox.append(listScroll);
        const listPopover = new Gtk.Popover();
        listPopover.set_child(listBox);
        this.historyButton = new Gtk.MenuButton({ has_frame: false, tooltip_text: 'Percakapan sebelumnya', popover: listPopover, icon_name: 'document-open-recent-symbolic' });
        listPopover.connect('show', () => this.refreshChatList());
        this.settingsButton = new Gtk.MenuButton({ has_frame: false, tooltip_text: 'Pengaturan asisten', icon_name: 'emblem-system-symbolic' });
        const header = new Gtk.Box({ margin_top: 4, margin_bottom: 8, margin_end: 6 });
        pack(header, title, true);
        header.append(clear);
        header.append(this.historyButton);
        header.append(this.settingsButton);

        // Pengaturan: API key dan model.
        this.keyEntry = new Gtk.Entry({ visibility: false, placeholder_text: 'sk-…', width_chars: 28 });
        this.keyEntry.set_input_purpose(Gtk.InputPurpose.PASSWORD);
        this.keyStatus = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 36 });
        this.keyStatus.add_css_class('side-meta');
        const save = new Gtk.Button({ label: 'Simpan' });
        save.connect('clicked', () => void this.saveKey());
        this.keyEntry.connect('activate', () => void this.saveKey());
        const forget = new Gtk.Button({ label: 'Hapus' });
        forget.connect('clicked', () => void this.forgetKey());
        const keyRow = new Gtk.Box({ spacing: 6 });
        pack(keyRow, this.keyEntry, true);
        keyRow.append(save);
        keyRow.append(forget);
        this.modelCombo = new Gtk.ComboBoxText();
        for (const m of DEEPSEEK_MODELS) this.modelCombo.append(m, m);
        this.modelCombo.connect('changed', () => {
            const id = this.modelCombo.get_active_id();
            if (!id || id === this.model) return;
            this.model = id;
            this.onModelChanged(id);
        });
        this.thinkingCheck = new Gtk.CheckButton({ label: 'Berpikir mendalam', tooltip_text: 'Model menalar lebih lama sebelum menjawab: biasanya lebih teliti, tetapi lebih lambat dan lebih mahal' });
        this.thinkingCheck.connect('toggled', () => {
            this.session.thinking = this.thinkingCheck.active;
            this.onThinkingChanged(this.thinkingCheck.active);
        });
        this.saveCheck = new Gtk.CheckButton({
            label: 'Simpan riwayat percakapan di folder', active: this.saveChats,
            tooltip_text: 'Tiap percakapan ditulis sebagai berkas Markdown di <folder kerja>/.nyerat/chats. Isinya memuat kutipan dokumen; folder .nyerat tidak ikut Git kecuali Anda menghapus .nyerat/.gitignore',
        });
        this.saveCheck.connect('toggled', () => {
            this.saveChats = this.saveCheck.active;
            this.onSaveChanged(this.saveChats);
        });
        const privacy = new Gtk.Label({
            label: 'Dokumen yang disertakan sebagai konteks (atur lewat tombol Konteks) dikirim ke server DeepSeek setiap kali Anda bertanya.',
            xalign: 0, wrap: true, max_width_chars: 36,
        });
        privacy.add_css_class('side-meta');
        const settings = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12 });
        settings.add_css_class('chat-pop');
        settings.append(this.label('API key DeepSeek'));
        settings.append(keyRow);
        settings.append(this.keyStatus);
        settings.append(this.label('Model'));
        settings.append(this.modelCombo);
        settings.append(this.thinkingCheck);
        settings.append(this.saveCheck);
        settings.append(privacy);
        const settingsPopover = new Gtk.Popover();
        settingsPopover.set_child(settings);
        this.settingsButton.set_popover(settingsPopover);
        settingsPopover.connect('show', () => void this.refreshKeyStatus());

        // Pesan
        this.messages = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10, margin_bottom: 12, margin_start: 12, margin_end: 12, margin_top: 4 });
        this.empty = this.buildEmptyState();
        this.messages.append(this.empty);
        // EXTERNAL, bukan NEVER: NEVER meneruskan lebar natural isi (teks panjang tanpa spasi) ke induk dan melebarkan panel.
        this.scroller = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.EXTERNAL, vexpand: true });
        this.scroller.set_child(this.messages);
        const vadj = this.scroller.get_vadjustment();
        vadj.connect('changed', () => { if (this.stick) vadj.set_value(vadj.get_upper() - vadj.get_page_size()); });
        vadj.connect('value-changed', () => { this.stick = vadj.get_upper() - vadj.get_page_size() - vadj.get_value() < 24; });

        // Konteks: ringkasan + popover pengaturan apa yang dikirim.
        this.contextList = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
        const contextBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12 });
        contextBox.add_css_class('chat-pop');
        contextBox.append(this.label('Yang dikirim ke model'));
        const checks: [string, string, keyof ContextOptions][] = [
            ['Dokumen yang sedang dibuka', 'Isi lengkap dokumen aktif (bila terlalu panjang: bagian di sekitar kursor)', 'activeDocument'],
            ['Teks yang dipilih', 'Kalimat yang sedang disorot di editor', 'selection'],
            ['Berkas lain di folder', 'Peta proyek, potongan relevan, berkas yang di-@mention, dan izin bagi asisten untuk mencari dan membaca dokumen sendiri', 'project'],
        ];
        for (const [text, tip, key] of checks) {
            const check = new Gtk.CheckButton({ label: text, active: this.options[key], tooltip_text: tip });
            check.connect('toggled', () => { this.options[key] = check.active; this.updateContextPreview(); });
            contextBox.append(check);
        }
        contextBox.append(new Gtk.Separator());
        contextBox.append(this.contextList);
        const hint = new Gtk.Label({ label: 'Opsional: ketik @namaberkas di pesan untuk langsung melampirkan berkas utuh. Asisten juga dapat mencari dan membaca berkas lain sendiri.', xalign: 0, wrap: true, max_width_chars: 36 });
        hint.add_css_class('side-meta');
        contextBox.append(hint);
        const contextPopover = new Gtk.Popover();
        contextPopover.set_child(contextBox);
        this.contextButton = new Gtk.MenuButton({ popover: contextPopover, has_frame: false, direction: Gtk.ArrowType.UP, halign: Gtk.Align.START, margin_start: 8 });
        contextPopover.connect('show', () => this.updateContextPreview());

        // Masukan
        this.input = new Gtk.TextView({ wrap_mode: Gtk.WrapMode.WORD_CHAR, top_margin: 6, bottom_margin: 6, left_margin: 8, right_margin: 8 });
        this.input.add_css_class('chat-input');
        // Fase CAPTURE: sebelum TextView sendiri menyisipkan baris baru untuk Enter.
        onKeyPress(this.input, (keyval, state) => this.onInputKey(keyval, state), Gtk.PropagationPhase.CAPTURE);
        this.input.buffer.connect('changed', () => this.queueContextSummary());
        const inputScroll = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.EXTERNAL, min_content_height: 64, max_content_height: 160, propagate_natural_height: true, has_frame: true });
        inputScroll.set_child(this.input);
        this.sendButton = Gtk.Button.new_from_icon_name('go-up-symbolic');
        this.sendButton.set_tooltip_text('Kirim (Enter)');
        this.sendButton.set_valign(Gtk.Align.END);
        this.sendButton.connect('clicked', () => this.busy ? this.stop() : void this.send());
        const inputRow = new Gtk.Box({ spacing: 6, margin_bottom: 8, margin_start: 8, margin_end: 8, margin_top: 2 });
        pack(inputRow, inputScroll, true);
        inputRow.append(this.sendButton);

        this.widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, width_request: 360 });
        this.widget.add_css_class('sidebar');
        this.widget.add_css_class('chat');
        this.widget.append(header);
        pack(this.widget, this.scroller, true);
        this.widget.append(this.contextButton);
        this.widget.append(inputRow);
    }

    // Jendela ditutup: hentikan permintaan dan timer yang masih berjalan.
    destroy(): void {
        this.stop();
        if (this.renderTimer) GLib.source_remove(this.renderTimer);
        this.renderTimer = 0;
        if (this.summaryTimer) GLib.source_remove(this.summaryTimer);
        this.summaryTimer = 0;
    }

    get busy(): boolean {
        return this.cancellable !== null;
    }

    setPalette(palette: Palette): void {
        this.colors = { code: palette.codeFg, codeBg: palette.codeBg, link: palette.accent, mark: palette.markBg };
        for (const b of this.bubbles) this.render(b);
    }

    // Nama model lama atau tak dikenal (mis. dari pengaturan versi sebelumnya) diganti model bawaan.
    setModel(model: string): void {
        this.model = DEEPSEEK_MODELS.includes(model) ? model : DEEPSEEK_MODELS[0];
        this.modelCombo.set_active_id(this.model);
    }

    setThinking(thinking: boolean): void {
        this.thinkingCheck.set_active(thinking);
        this.session.thinking = thinking;
    }

    setSaveChats(save: boolean): void {
        this.saveCheck.set_active(save);
        this.saveChats = save;
    }

    focusInput(): void {
        this.input.grab_focus();
    }

    // ---------- Percakapan ----------

    reset(): void {
        this.stop();
        this.session.clear();
        this.chatPath = null;
        this.stepLabels.clear();   // labelnya ikut dibuang di bawah; id alat yang sama tidak boleh memakainya lagi
        this.bubbles.length = 0;
        for (const child of childrenOf(this.messages)) if (child !== this.empty) this.messages.remove(child);
        this.empty.show();
        this.updateContextSummary();
    }

    stop(): void {
        this.cancellable?.cancel();
    }

    // Isi kotak masukan lalu (opsional) langsung kirim; dipakai tombol saran dan tes.
    ask(text: string, send = true): Promise<void> {
        this.input.buffer.set_text(text, -1);
        return send ? this.send() : Promise.resolve();
    }

    async send(): Promise<void> {
        const question = this.input.buffer.text.trim();
        if (!question || this.busy) return;
        const found = await this.keyStore.get();
        if (!found) {
            this.addNote('Belum ada API key DeepSeek. Buka pengaturan (ikon roda gigi), tempel key-nya, lalu kirim lagi.', true);
            this.settingsButton.get_popover()?.popup();
            return;
        }

        this.input.buffer.set_text('', -1);
        this.empty.hide();
        this.addUser(question);
        const answer = this.addAssistant();
        this.cancellable = new Gio.Cancellable();
        this.sendButton.set_icon_name('media-playback-stop-symbolic');
        this.sendButton.set_tooltip_text('Hentikan');
        this.stick = true;

        let reasoning = '';
        try {
            const result = await this.session.ask(this.turnInput(question), this.makeProvider(found.key), this.model, {
                onContext: built => {
                    this.setContextSummary(built);
                    answer.meta.set_text(this.describe(built));
                    answer.meta.show();
                },
                onText: delta => { answer.bubble.text += delta; this.queueRender(answer.bubble); },
                onReasoning: delta => {
                    reasoning += delta;
                    answer.thinking.show();
                    answer.thinkingLabel.set_text(reasoning.trim());
                },
                onTool: step => this.showStep(answer.steps, step),
                onProposal: change => this.propose(change),
            }, this.cancellable);
            this.render(answer.bubble);
            if (result.cancelled) answer.footer.set_text(answer.bubble.text || result.toolCalls ? 'Dihentikan' : 'Dihentikan sebelum ada jawaban');
            else if (result.usage) answer.footer.set_text(usageText(result.usage, result.toolCalls, result.applied));
            answer.footer.set_visible(!!answer.footer.get_text());
            this.persist();
        } catch (e) {
            this.render(answer.bubble);
            answer.footer.set_markup(`<span foreground="#c9372c">${escapeMarkup(e instanceof Error ? e.message : String(e))}</span>`);
            answer.footer.show();
            if (!answer.bubble.text) answer.bubble.label.hide();
        } finally {
            this.cancellable = null;
            this.sendButton.set_icon_name('go-up-symbolic');
            this.sendButton.set_tooltip_text('Kirim (Enter)');
            this.updateContextSummary();
        }
    }

    // ---------- Riwayat di disk ----------

    // Tulis percakapan ke <folder>/.nyerat/chats setelah tiap giliran. Tanpa folder, atau saat dimatikan, tidak menulis apa-apa.
    private persist(): void {
        const root = this.host.root();
        const history = this.session.history;
        if (!this.saveChats || !root || !history.length) return;
        if (root !== this.chatRoot) {
            // Pindah folder di tengah percakapan: lanjutannya ditulis sebagai berkas baru di folder yang baru.
            this.chatRoot = root;
            this.chatPath = null;
        }
        if (!this.chatPath) {
            this.chatCreated = nowStamp();
            this.chatTitle = titleFrom(history.find(t => t.role === 'user')?.content ?? '');
        }
        try {
            this.chatPath = saveChat(root, { title: this.chatTitle, model: this.model, created: this.chatCreated, turns: [...history] }, this.chatPath);
        } catch (e) {
            this.addNote(`Riwayat percakapan tidak tersimpan: ${e instanceof Error ? e.message : e}`, true);
        }
    }

    // Tampilkan percakapan tersimpan dan lanjutkan dari sana: giliran berikutnya ditambahkan ke berkas yang sama.
    openChat(path: string): boolean {
        const chat = loadChat(path);
        if (!chat) {
            this.addNote('Berkas percakapan tidak bisa dibaca.', true);
            return false;
        }
        this.reset();
        this.session.restore(chat.turns);
        this.chatPath = path;
        this.chatRoot = this.host.root();
        this.chatTitle = chat.title;
        this.chatCreated = chat.created;
        this.empty.hide();
        for (const turn of chat.turns) {
            if (turn.role === 'user') {
                this.addUser(turn.content);
            } else {
                const answer = this.addAssistant();
                answer.bubble.text = turn.content;
                this.render(answer.bubble);
            }
        }
        this.stick = true;
        this.updateContextSummary();
        return true;
    }

    private refreshChatList(): void {
        for (const child of childrenOf(this.chatList)) this.chatList.remove(child);
        const note = (text: string) => {
            const l = new Gtk.Label({ label: text, xalign: 0, wrap: true, max_width_chars: 36 });
            l.add_css_class('side-meta');
            l.show();
            this.chatList.append(l);
        };
        const root = this.host.root();
        if (!root) return note('Buka folder kerja untuk menyimpan dan membuka riwayat percakapan.');
        const chats = listChats(root);
        if (!chats.length) return note('Belum ada percakapan tersimpan di folder ini.');
        const popover = this.historyButton.get_popover();
        for (const chat of chats) {
            const row = new Gtk.Box({ spacing: 2 });
            const open = new Gtk.Button({ has_frame: false, tooltip_text: `${chat.created.replace('T', ' ')} · ${chat.turns / 2 | 0} tanya-jawab` });
            const text = new Gtk.Label({ label: chat.title, xalign: 0, ellipsize: 3, max_width_chars: 30 });
            const date = new Gtk.Label({ label: chat.created.slice(0, 10), xalign: 0 });
            date.add_css_class('side-meta');
            const column = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
            column.append(text);
            column.append(date);
            open.set_child(column);
            open.connect('clicked', () => {
                popover?.popdown();
                this.openChat(chat.path);
            });
            const remove = Gtk.Button.new_from_icon_name('user-trash-symbolic');
            remove.set_has_frame(false);
            remove.set_tooltip_text('Buang ke Tempat Sampah');
            remove.connect('clicked', () => {
                try {
                    deleteChat(chat.path);
                } catch (e) {
                    this.addNote(e instanceof Error ? e.message : String(e), true);
                }
                if (chat.path === this.chatPath) this.chatPath = null;
                this.refreshChatList();
            });
            pack(row, open, true);
            row.append(remove);
            this.chatList.append(row);
        }
    }

    // ---------- Konteks ----------

    private turnInput(question: string) {
        return {
            question,
            active: this.host.active(),
            selection: this.host.selection(),
            files: this.host.files(),
            mentions: findMentions(question),
            options: { ...this.options },
            budget: this.budget,
        };
    }

    // Membangun konteks untuk teks yang sedang diketik, tanpa mengirim apa pun.
    previewContext(): BuiltContext {
        return buildContext({ ...this.turnInput(this.input.buffer.text), recent: this.session.questions });
    }

    // Ringkasan satu baris tentang apa yang dikirim: dokumen, pilihan, lampiran, dan jumlah potongan per berkas.
    private describe(built: BuiltContext): string {
        const parts = [`≈${fmtTokens(built.tokens)} token`];
        const excerpts = new Map<string, number>();
        for (const item of built.items) {
            if (item.kind === 'excerpt') {
                const file = item.label.split(' › ')[0];
                excerpts.set(file, (excerpts.get(file) ?? 0) + 1);
            } else if (item.kind !== 'map') {
                parts.push(item.label);
            }
        }
        for (const [file, n] of excerpts) parts.push(`${n} potongan dari ${file}`);
        if (built.unknownMentions.length) parts.push(`tidak ditemukan: ${built.unknownMentions.map(m => `@${m}`).join(', ')}`);
        return `Konteks: ${parts.join(' · ')}`;
    }

    private setContextSummary(built: BuiltContext): void {
        // Tanpa panah sendiri: MenuButton GTK 4 berlabel sudah menampilkan panah arah popover-nya.
        this.contextButton.set_label(`Konteks · ≈${fmtTokens(built.tokens)} token`);
    }

    // Membangun konteks menyentuh seluruh proyek, jadi ringkasan hanya diperbarui saat panel terlihat
    // dan setelah pengetikan berhenti sebentar.
    queueContextSummary(): void {
        if (this.summaryTimer || this.busy || !this.widget.get_mapped()) return;
        this.summaryTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 400, () => {
            this.summaryTimer = 0;
            this.updateContextSummary();
            return GLib.SOURCE_REMOVE;
        });
    }

    updateContextSummary(): void {
        if (this.busy) return;
        this.setContextSummary(this.previewContext());
    }

    private updateContextPreview(): void {
        for (const child of childrenOf(this.contextList)) this.contextList.remove(child);
        const built = this.previewContext();
        const add = (text: string, dim = false) => {
            const l = new Gtk.Label({ label: text, xalign: 0, wrap: true, max_width_chars: 40, ellipsize: 3 });
            if (dim) l.add_css_class('side-meta');
            l.show();
            this.contextList.append(l);
        };
        if (!built.items.length) add('Tidak ada konteks dokumen yang dikirim.', true);
        for (const item of built.items) add(`${KIND_LABEL[item.kind]}: ${item.label} · ${fmtTokens(item.tokens)}`);
        add(`Total ≈${fmtTokens(built.tokens)} token dari anggaran ${fmtTokens(this.budget)}`, true);
        for (const m of built.unknownMentions) add(`Berkas @${m} tidak ditemukan di folder proyek.`, true);
        this.setContextSummary(built);
    }

    // ---------- API key ----------

    private async refreshKeyStatus(): Promise<void> {
        const found = await this.keyStore.get();
        this.keyStatus.set_text(found ? SOURCE_TEXT[found.source] : 'Belum ada key. Buat di platform.deepseek.com.');
    }

    private async saveKey(): Promise<void> {
        const key = this.keyEntry.text.trim();
        if (!key) return;
        try {
            const source = await this.keyStore.set(key);
            this.keyEntry.set_text('');
            this.keyStatus.set_text(SOURCE_TEXT[source]);
        } catch (e) {
            this.keyStatus.set_text(`Gagal menyimpan: ${e instanceof Error ? e.message : e}`);
        }
    }

    private async forgetKey(): Promise<void> {
        await this.keyStore.clear();
        await this.refreshKeyStatus();
    }

    // ---------- Pesan ----------

    private label(text: string): Gtk.Label {
        const l = new Gtk.Label({ label: text, xalign: 0 });
        l.add_css_class('side-title');
        return l;
    }

    private buildEmptyState(): Gtk.Box {
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, margin_top: 8 });
        const intro = new Gtk.Label({
            label: 'Tanyakan atau minta bantuan apa saja soal pekerjaan Anda. Asisten membaca dokumen yang terbuka dan potongan relevan dari berkas lain di folder.',
            xalign: 0, wrap: true, max_width_chars: 38,
        });
        intro.add_css_class('side-meta');
        box.append(intro);
        for (const text of SUGGESTIONS) {
            const button = new Gtk.Button({ label: text, halign: Gtk.Align.START });
            (button.get_child() as Gtk.Label).set_wrap(true);
            (button.get_child() as Gtk.Label).set_xalign(0);
            (button.get_child() as Gtk.Label).set_max_width_chars(34);
            button.connect('clicked', () => { this.input.buffer.set_text(text, -1); this.input.grab_focus(); });
            box.append(button);
        }
        return box;
    }

    private bubble(markdown: boolean, cls: string): Bubble {
        const label = new Gtk.Label({ xalign: 0, yalign: 0, wrap: true, wrap_mode: 2, selectable: true, max_width_chars: 40, use_markup: true });
        label.add_css_class(cls);
        const bubble = { label, text: '', markdown };
        this.bubbles.push(bubble);
        return bubble;
    }

    private render(b: Bubble): void {
        b.label.set_markup(b.markdown ? chatMarkup(b.text, this.colors) : escapeMarkup(b.text));
    }

    // Pembaruan beruntun saat jawaban mengalir digabung; markup diurai ulang paling sering ±15 kali per detik.
    private queueRender(b: Bubble): void {
        if (this.renderTimer) return;
        this.renderTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 65, () => {
            this.renderTimer = 0;
            this.render(b);
            return GLib.SOURCE_REMOVE;
        });
    }

    private addUser(text: string): void {
        const b = this.bubble(false, 'chat-user');
        b.text = text;
        this.render(b);
        const row = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, margin_start: 28 });
        row.add_css_class('chat-user-box');
        row.append(b.label);
        this.messages.append(row);
    }

    private addAssistant() {
        const bubble = this.bubble(true, 'chat-assistant');
        const meta = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 44, visible: false });
        meta.add_css_class('side-meta');
        const steps = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, visible: false });
        const thinkingLabel = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 40, selectable: true });
        thinkingLabel.add_css_class('chat-thinking');
        const thinking = new Gtk.Expander({ label: 'Proses berpikir', visible: false });
        thinking.set_child(thinkingLabel);
        const footer = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 44, selectable: true, visible: false, use_markup: true });
        footer.add_css_class('side-meta');
        const row = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
        row.append(meta);
        row.append(steps);
        row.append(thinking);
        row.append(bubble.label);
        row.append(footer);
        meta.hide();
        thinking.hide();
        footer.hide();
        this.messages.append(row);
        return { bubble, meta, steps, thinking, thinkingLabel, footer };
    }

    // Satu baris per penelusuran asisten: "Mencari “surat”…" lalu, setelah selesai, "… → 5 potongan".
    // Dipanggil dua kali per alat (mulai dan selesai) dengan id yang sama.
    private showStep(box: Gtk.Box, step: ToolStep): void {
        let label = this.stepLabels.get(step.id);
        if (!label) {
            label = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 44, selectable: true });
            label.add_css_class('chat-step');
            this.stepLabels.set(step.id, label);
            box.append(label);
        }
        label.set_text(step.summary ? `${step.label} → ${step.summary}` : `${step.label}…`);
        label.show();
        box.show();
    }

    // Kartu persetujuan: selisih yang diusulkan agent, dengan tombol Terapkan dan Tolak. Berkas tidak disentuh
    // sebelum Terapkan ditekan; menghentikan giliran (tombol Hentikan) sama dengan menolak.
    private propose(change: Change): Promise<ProposalResult> {
        const card = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
        card.add_css_class('chat-proposal');
        const title = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 44, use_markup: true, selectable: true });
        title.set_markup(`<b>${escapeMarkup(describeChange(change))}</b>`);
        card.append(title);
        if (change.reason.trim()) {
            const reason = new Gtk.Label({ label: change.reason.trim(), xalign: 0, wrap: true, max_width_chars: 44, selectable: true });
            reason.add_css_class('side-meta');
            card.append(reason);
        }

        const diff = diffPreview(change.before, change.after);
        const color = { '+': '#2a8a4a', '-': '#c9372c', ' ': '', '…': '' } as const;
        const markup = diff.lines.map(l => l.sign === '…'
            ? `<span alpha="60%">… ${escapeMarkup(l.text)}</span>`
            : `<span${color[l.sign] ? ` foreground="${color[l.sign]}"` : ''}>${l.sign} ${escapeMarkup(l.text)}</span>`).join('\n');
        const body = new Gtk.Label({ xalign: 0, yalign: 0, use_markup: true, selectable: true, wrap: true, wrap_mode: 2, max_width_chars: 48 });
        body.add_css_class('chat-diff');
        body.set_markup(markup);
        const scroll = new Gtk.ScrolledWindow({ min_content_height: 40, max_content_height: 240, propagate_natural_height: true, hscrollbar_policy: Gtk.PolicyType.NEVER });
        scroll.set_child(body);
        card.append(scroll);

        const status = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 44, visible: false });
        status.add_css_class('side-meta');
        const apply = new Gtk.Button({ label: `Terapkan (+${diff.added} −${diff.removed})` });
        apply.add_css_class('suggested-action');
        const reject = new Gtk.Button({ label: 'Tolak' });
        const buttons = new Gtk.Box({ spacing: 6 });
        buttons.append(apply);
        buttons.append(reject);
        card.append(buttons);
        card.append(status);
        this.empty.hide();
        this.messages.append(card);
        this.stick = true;

        return new Promise<ProposalResult>(resolve => {
            let done = false;
            const finish = (result: ProposalResult, text: string, error = false) => {
                if (done) return;
                done = true;
                buttons.hide();
                status.set_text(text);
                status.remove_css_class('side-meta');
                status.add_css_class(error ? 'chat-error' : 'side-meta');
                status.show();
                resolve(result);
            };
            apply.connect('clicked', () => {
                const error = this.host.applyChange ? this.host.applyChange(change) : 'penerapan tidak tersedia';
                if (error) finish({ applied: false, error }, `Gagal diterapkan: ${error}`, true);
                else finish({ applied: true }, 'Diterapkan. Perubahan di editor bisa dibatalkan dengan Ctrl+Z.');
            });
            reject.connect('clicked', () => finish({ applied: false }, 'Ditolak.'));
            this.cancellable?.connect(() => finish({ applied: false }, 'Dibatalkan.'));
        });
    }

    private addNote(text: string, error = false): void {
        const l = new Gtk.Label({ label: text, xalign: 0, wrap: true, max_width_chars: 40, selectable: true });
        l.add_css_class(error ? 'chat-error' : 'side-meta');
        l.show();
        this.empty.hide();
        this.messages.append(l);
    }

    // Enter mengirim; Shift+Enter baris baru.
    onInputKey(keyval: number, state: number): boolean {
        if ((keyval !== Gdk.KEY_Return && keyval !== Gdk.KEY_KP_Enter) || state & Gdk.ModifierType.SHIFT_MASK) return false;
        if (!this.busy) void this.send();
        return true;
    }
}
