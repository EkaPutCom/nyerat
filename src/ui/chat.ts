// Panel Asisten di sisi kanan: chat dengan model (DeepSeek) yang tahu isi naskah.
// Panel tidak tahu cara mengambil naskah; jendela memberikannya lewat `host`. Penyusunan konteks
// ada di agent/context.ts, dan pemanggilan modelnya lewat Provider (agent/provider.ts).
//
//   ┌ ASISTEN                 ⌫ ⚙ ┐
//   │ (pesan, terbaru di bawah)    │
//   │ Konteks · ≈12 rb token ▾     │
//   │ [ketik pertanyaan…     ] [➤] │
//   └──────────────────────────────┘

import Gtk from 'gi://Gtk?version=3.0';
import Gdk from 'gi://Gdk?version=3.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { systemKeyStore, type KeySource, type KeyStore } from '../agent/apikey.js';
import { buildContext, DEFAULT_BUDGET, findMentions, type BuiltContext, type ContextOptions, type SourceFile } from '../agent/context.js';
import { deleteChat, listChats, loadChat, nowStamp, saveChat, titleFrom } from '../agent/chatstore.js';
import { DEEPSEEK_MODELS, DeepSeek } from '../agent/deepseek.js';
import type { Provider, Usage } from '../agent/provider.js';
import { ChatSession, type ToolStep } from '../agent/session.js';
import { chatMarkup } from '../markdown/chatmarkup.js';
import { escapeMarkup, type MarkupColors } from '../markdown/pango.js';
import type { Palette } from './theme.js';

// Yang perlu diketahui panel dari jendela.
export interface ChatHost {
    active(): { name: string; text: string; cursorLine: number } | null;   // dokumen terbuka (isi buffer, bukan disk)
    selection(): string;
    files(): SourceFile[];                                                  // berkas lain di folder proyek
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

const usageText = (u: Usage, toolCalls: number): string =>
    `${fmtTokens(u.prompt)} masuk${u.cached ? ` (${fmtTokens(u.cached)} dari cache)` : ''} · ${fmtTokens(u.completion)} keluar${toolCalls ? ` · ${toolCalls} penelusuran` : ''}`;

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
        title.get_style_context().add_class('side-title');
        const clear = Gtk.Button.new_from_icon_name('edit-clear-all-symbolic', Gtk.IconSize.MENU);
        clear.set_relief(Gtk.ReliefStyle.NONE);
        clear.set_tooltip_text('Percakapan baru');
        clear.connect('clicked', () => this.reset());
        this.chatList = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
        const listScroll = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, min_content_width: 300, max_content_height: 280, propagate_natural_height: true });
        listScroll.add(this.chatList);
        const listBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, margin: 12 });
        listBox.get_style_context().add_class('chat-pop');
        listBox.set_size_request(320, -1);
        listBox.pack_start(this.label('Percakapan sebelumnya'), false, false, 0);
        listBox.pack_start(listScroll, false, false, 0);
        const listPopover = new Gtk.Popover();
        listPopover.add(listBox);
        listBox.show_all();
        this.historyButton = new Gtk.MenuButton({ relief: Gtk.ReliefStyle.NONE, tooltip_text: 'Percakapan sebelumnya', popover: listPopover });
        this.historyButton.set_image(Gtk.Image.new_from_icon_name('document-open-recent-symbolic', Gtk.IconSize.MENU));
        listPopover.connect('show', () => this.refreshChatList());
        this.settingsButton = new Gtk.MenuButton({ relief: Gtk.ReliefStyle.NONE, tooltip_text: 'Pengaturan asisten' });
        this.settingsButton.set_image(Gtk.Image.new_from_icon_name('emblem-system-symbolic', Gtk.IconSize.MENU));
        const header = new Gtk.Box({ margin_top: 4, margin_bottom: 8, margin_end: 6 });
        header.pack_start(title, true, true, 0);
        header.pack_start(clear, false, false, 0);
        header.pack_start(this.historyButton, false, false, 0);
        header.pack_start(this.settingsButton, false, false, 0);

        // Pengaturan: API key dan model.
        this.keyEntry = new Gtk.Entry({ visibility: false, placeholder_text: 'sk-…', width_chars: 28 });
        this.keyEntry.set_input_purpose(Gtk.InputPurpose.PASSWORD);
        this.keyStatus = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 36 });
        this.keyStatus.get_style_context().add_class('side-meta');
        const save = new Gtk.Button({ label: 'Simpan' });
        save.connect('clicked', () => void this.saveKey());
        this.keyEntry.connect('activate', () => void this.saveKey());
        const forget = new Gtk.Button({ label: 'Hapus' });
        forget.connect('clicked', () => void this.forgetKey());
        const keyRow = new Gtk.Box({ spacing: 6 });
        keyRow.pack_start(this.keyEntry, true, true, 0);
        keyRow.pack_start(save, false, false, 0);
        keyRow.pack_start(forget, false, false, 0);
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
            tooltip_text: 'Tiap percakapan ditulis sebagai berkas Markdown di <folder naskah>/.nyerat/chats. Isinya memuat kutipan naskah; folder .nyerat tidak ikut Git kecuali Anda menghapus .nyerat/.gitignore',
        });
        this.saveCheck.connect('toggled', () => {
            this.saveChats = this.saveCheck.active;
            this.onSaveChanged(this.saveChats);
        });
        const privacy = new Gtk.Label({
            label: 'Naskah yang disertakan sebagai konteks (atur lewat tombol Konteks) dikirim ke server DeepSeek setiap kali Anda bertanya.',
            xalign: 0, wrap: true, max_width_chars: 36,
        });
        privacy.get_style_context().add_class('side-meta');
        const settings = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, margin: 12 });
        settings.get_style_context().add_class('chat-pop');
        settings.pack_start(this.label('API key DeepSeek'), false, false, 0);
        settings.pack_start(keyRow, false, false, 0);
        settings.pack_start(this.keyStatus, false, false, 0);
        settings.pack_start(this.label('Model'), false, false, 0);
        settings.pack_start(this.modelCombo, false, false, 0);
        settings.pack_start(this.thinkingCheck, false, false, 0);
        settings.pack_start(this.saveCheck, false, false, 0);
        settings.pack_start(privacy, false, false, 0);
        const settingsPopover = new Gtk.Popover();
        settingsPopover.add(settings);
        settings.show_all();
        this.settingsButton.set_popover(settingsPopover);
        settingsPopover.connect('show', () => void this.refreshKeyStatus());

        // Pesan
        this.messages = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10, margin: 12, margin_top: 4 });
        this.empty = this.buildEmptyState();
        this.messages.pack_start(this.empty, false, false, 0);
        // EXTERNAL, bukan NEVER: NEVER meneruskan lebar natural isi (teks panjang tanpa spasi) ke induk dan melebarkan panel.
        this.scroller = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.EXTERNAL, vexpand: true });
        this.scroller.add(this.messages);
        const vadj = this.scroller.get_vadjustment();
        vadj.connect('changed', () => { if (this.stick) vadj.set_value(vadj.get_upper() - vadj.get_page_size()); });
        vadj.connect('value-changed', () => { this.stick = vadj.get_upper() - vadj.get_page_size() - vadj.get_value() < 24; });

        // Konteks: ringkasan + popover pengaturan apa yang dikirim.
        this.contextList = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
        const contextBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, margin: 12 });
        contextBox.get_style_context().add_class('chat-pop');
        contextBox.pack_start(this.label('Yang dikirim ke model'), false, false, 0);
        const checks: [string, string, keyof ContextOptions][] = [
            ['Dokumen yang sedang dibuka', 'Isi lengkap dokumen aktif (bila terlalu panjang: bagian di sekitar kursor)', 'activeDocument'],
            ['Teks yang dipilih', 'Kalimat yang sedang disorot di editor', 'selection'],
            ['Berkas lain di folder', 'Peta proyek, potongan relevan, berkas yang di-@mention, dan izin bagi asisten untuk mencari dan membaca naskah sendiri', 'project'],
        ];
        for (const [text, tip, key] of checks) {
            const check = new Gtk.CheckButton({ label: text, active: this.options[key], tooltip_text: tip });
            check.connect('toggled', () => { this.options[key] = check.active; this.updateContextPreview(); });
            contextBox.pack_start(check, false, false, 0);
        }
        contextBox.pack_start(new Gtk.Separator(), false, false, 4);
        contextBox.pack_start(this.contextList, false, false, 0);
        const hint = new Gtk.Label({ label: 'Opsional: ketik @namaberkas di pesan untuk langsung melampirkan berkas utuh. Asisten juga dapat mencari dan membaca berkas lain sendiri.', xalign: 0, wrap: true, max_width_chars: 36 });
        hint.get_style_context().add_class('side-meta');
        contextBox.pack_start(hint, false, false, 4);
        contextBox.show_all();
        const contextPopover = new Gtk.Popover();
        contextPopover.add(contextBox);
        this.contextButton = new Gtk.MenuButton({ popover: contextPopover, relief: Gtk.ReliefStyle.NONE, direction: Gtk.ArrowType.UP, halign: Gtk.Align.START, margin_start: 8 });
        contextPopover.connect('show', () => this.updateContextPreview());

        // Masukan
        this.input = new Gtk.TextView({ wrap_mode: Gtk.WrapMode.WORD_CHAR, top_margin: 6, bottom_margin: 6, left_margin: 8, right_margin: 8 });
        this.input.get_style_context().add_class('chat-input');
        // Tipe @girs memberi EventKey; di runtime objek ini punya get_keyval()/get_state() milik Gdk.Event.
        this.input.connect('key-press-event', (_v, event) => this.onInputKey(event as unknown as Gdk.Event));
        this.input.buffer.connect('changed', () => this.queueContextSummary());
        const inputScroll = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.EXTERNAL, min_content_height: 64, max_content_height: 160, propagate_natural_height: true, shadow_type: Gtk.ShadowType.IN });
        inputScroll.add(this.input);
        this.sendButton = Gtk.Button.new_from_icon_name('go-up-symbolic', Gtk.IconSize.BUTTON);
        this.sendButton.set_tooltip_text('Kirim (Enter)');
        this.sendButton.set_valign(Gtk.Align.END);
        this.sendButton.connect('clicked', () => this.busy ? this.stop() : void this.send());
        const inputRow = new Gtk.Box({ spacing: 6, margin: 8, margin_top: 2 });
        inputRow.pack_start(inputScroll, true, true, 0);
        inputRow.pack_start(this.sendButton, false, false, 0);

        this.widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, width_request: 360 });
        this.widget.get_style_context().add_class('sidebar');
        this.widget.get_style_context().add_class('chat');
        this.widget.pack_start(header, false, false, 0);
        this.widget.pack_start(this.scroller, true, true, 0);
        this.widget.pack_start(this.contextButton, false, false, 0);
        this.widget.pack_start(inputRow, false, false, 0);
        this.widget.show_all();
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
        for (const child of this.messages.get_children()) if (child !== this.empty) this.messages.remove(child);
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
        this.sendButton.set_image(Gtk.Image.new_from_icon_name('media-playback-stop-symbolic', Gtk.IconSize.BUTTON));
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
            }, this.cancellable);
            this.render(answer.bubble);
            if (result.cancelled) answer.footer.set_text(answer.bubble.text || result.toolCalls ? 'Dihentikan' : 'Dihentikan sebelum ada jawaban');
            else if (result.usage) answer.footer.set_text(usageText(result.usage, result.toolCalls));
            answer.footer.set_visible(!!answer.footer.get_text());
            this.persist();
        } catch (e) {
            this.render(answer.bubble);
            answer.footer.set_markup(`<span foreground="#c9372c">${escapeMarkup(e instanceof Error ? e.message : String(e))}</span>`);
            answer.footer.show();
            if (!answer.bubble.text) answer.bubble.label.hide();
        } finally {
            this.cancellable = null;
            this.sendButton.set_image(Gtk.Image.new_from_icon_name('go-up-symbolic', Gtk.IconSize.BUTTON));
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
        for (const child of this.chatList.get_children()) this.chatList.remove(child);
        const note = (text: string) => {
            const l = new Gtk.Label({ label: text, xalign: 0, wrap: true, max_width_chars: 36 });
            l.get_style_context().add_class('side-meta');
            l.show();
            this.chatList.pack_start(l, false, false, 0);
        };
        const root = this.host.root();
        if (!root) return note('Buka folder naskah untuk menyimpan dan membuka riwayat percakapan.');
        const chats = listChats(root);
        if (!chats.length) return note('Belum ada percakapan tersimpan di folder ini.');
        const popover = this.historyButton.get_popover();
        for (const chat of chats) {
            const row = new Gtk.Box({ spacing: 2 });
            const open = new Gtk.Button({ relief: Gtk.ReliefStyle.NONE, tooltip_text: `${chat.created.replace('T', ' ')} · ${chat.turns / 2 | 0} tanya-jawab` });
            const text = new Gtk.Label({ label: chat.title, xalign: 0, ellipsize: 3, max_width_chars: 30 });
            const date = new Gtk.Label({ label: chat.created.slice(0, 10), xalign: 0 });
            date.get_style_context().add_class('side-meta');
            const column = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
            column.pack_start(text, false, false, 0);
            column.pack_start(date, false, false, 0);
            open.add(column);
            open.connect('clicked', () => {
                popover?.popdown();
                this.openChat(chat.path);
            });
            const remove = Gtk.Button.new_from_icon_name('user-trash-symbolic', Gtk.IconSize.MENU);
            remove.set_relief(Gtk.ReliefStyle.NONE);
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
            row.pack_start(open, true, true, 0);
            row.pack_start(remove, false, false, 0);
            this.chatList.pack_start(row, false, false, 0);
        }
        this.chatList.show_all();
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
        this.contextButton.set_label(`Konteks · ≈${fmtTokens(built.tokens)} token ▴`);
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
        for (const child of this.contextList.get_children()) this.contextList.remove(child);
        const built = this.previewContext();
        const add = (text: string, dim = false) => {
            const l = new Gtk.Label({ label: text, xalign: 0, wrap: true, max_width_chars: 40, ellipsize: 3 });
            if (dim) l.get_style_context().add_class('side-meta');
            l.show();
            this.contextList.pack_start(l, false, false, 0);
        };
        if (!built.items.length) add('Tidak ada konteks naskah yang dikirim.', true);
        for (const item of built.items) add(`${KIND_LABEL[item.kind]}: ${item.label} · ${fmtTokens(item.tokens)}`);
        add(`Total ≈${fmtTokens(built.tokens)} token dari anggaran ${fmtTokens(this.budget)}`, true);
        for (const m of built.unknownMentions) add(`Berkas @${m} tidak ditemukan di folder proyek.`, true);
        this.setContextSummary(built);
        this.contextButton.get_popover()?.show_all();
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
        l.get_style_context().add_class('side-title');
        return l;
    }

    private buildEmptyState(): Gtk.Box {
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, margin_top: 8 });
        const intro = new Gtk.Label({
            label: 'Tanyakan apa saja tentang naskah Anda. Asisten membaca dokumen yang terbuka dan potongan relevan dari berkas lain di folder.',
            xalign: 0, wrap: true, max_width_chars: 38,
        });
        intro.get_style_context().add_class('side-meta');
        box.pack_start(intro, false, false, 0);
        for (const text of SUGGESTIONS) {
            const button = new Gtk.Button({ label: text, halign: Gtk.Align.START });
            (button.get_child() as Gtk.Label).set_line_wrap(true);
            (button.get_child() as Gtk.Label).set_xalign(0);
            (button.get_child() as Gtk.Label).set_max_width_chars(34);
            button.connect('clicked', () => { this.input.buffer.set_text(text, -1); this.input.grab_focus(); });
            box.pack_start(button, false, false, 0);
        }
        return box;
    }

    private bubble(markdown: boolean, cls: string): Bubble {
        const label = new Gtk.Label({ xalign: 0, yalign: 0, wrap: true, wrap_mode: 2, selectable: true, max_width_chars: 40, use_markup: true });
        label.get_style_context().add_class(cls);
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
        row.get_style_context().add_class('chat-user-box');
        row.pack_start(b.label, false, false, 0);
        row.show_all();
        this.messages.pack_start(row, false, false, 0);
    }

    private addAssistant() {
        const bubble = this.bubble(true, 'chat-assistant');
        const meta = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 44, no_show_all: true });
        meta.get_style_context().add_class('side-meta');
        const steps = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, no_show_all: true });
        const thinkingLabel = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 40, selectable: true });
        thinkingLabel.get_style_context().add_class('chat-thinking');
        const thinking = new Gtk.Expander({ label: 'Proses berpikir', no_show_all: true });
        thinking.add(thinkingLabel);
        const footer = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 44, selectable: true, no_show_all: true, use_markup: true });
        footer.get_style_context().add_class('side-meta');
        const row = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
        row.pack_start(meta, false, false, 0);
        row.pack_start(steps, false, false, 0);
        row.pack_start(thinking, false, false, 0);
        row.pack_start(bubble.label, false, false, 0);
        row.pack_start(footer, false, false, 0);
        row.show_all();
        meta.hide();
        thinking.hide();
        footer.hide();
        this.messages.pack_start(row, false, false, 0);
        return { bubble, meta, steps, thinking, thinkingLabel, footer };
    }

    // Satu baris per penelusuran asisten: "Mencari “surat”…" lalu, setelah selesai, "… → 5 potongan".
    // Dipanggil dua kali per alat (mulai dan selesai) dengan id yang sama.
    private showStep(box: Gtk.Box, step: ToolStep): void {
        let label = this.stepLabels.get(step.id);
        if (!label) {
            label = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 44, selectable: true });
            label.get_style_context().add_class('chat-step');
            this.stepLabels.set(step.id, label);
            box.pack_start(label, false, false, 0);
        }
        label.set_text(step.summary ? `${step.label} → ${step.summary}` : `${step.label}…`);
        label.show();
        box.show();
    }

    private addNote(text: string, error = false): void {
        const l = new Gtk.Label({ label: text, xalign: 0, wrap: true, max_width_chars: 40, selectable: true });
        l.get_style_context().add_class(error ? 'chat-error' : 'side-meta');
        l.show();
        this.empty.hide();
        this.messages.pack_start(l, false, false, 0);
    }

    // Enter mengirim; Shift+Enter baris baru.
    private onInputKey(event: Gdk.Event): boolean {
        const [, keyval] = event.get_keyval();
        const [, state] = event.get_state();
        if ((keyval !== Gdk.KEY_Return && keyval !== Gdk.KEY_KP_Enter) || state & Gdk.ModifierType.SHIFT_MASK) return false;
        if (!this.busy) void this.send();
        return true;
    }
}
