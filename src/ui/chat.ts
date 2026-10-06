// Panel Asisten di sisi kanan: chat dengan model (DeepSeek) yang tahu isi naskah.
// Panel tidak tahu cara mengambil naskah; jendela memberikannya lewat `host`. Penyusunan konteks
// ada di agent/context.ts, dan pemanggilan modelnya lewat Provider (agent/provider.ts).
//
//   ┌ ASISTEN                 ⌫ ⚙ ┐
//   │ (pesan, terbaru di bawah)    │
//   │ Konteks · ≈12 rb token ▾     │
//   │ [ketik pertanyaan…     ] [➤] │
//   └──────────────────────────────┘

import { journalText } from '../agent/journal.js';
import { workText } from '../agent/work.js';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import { systemKeyStore, type KeySource, type KeyStore } from '../agent/apikey.js';
import { buildContext, DEFAULT_BUDGET, findMentions, type BuiltContext, type ContextOptions, type SourceFile } from '../agent/context.js';
import { deleteChat, listChats, loadChat, nowStamp, saveChat, titleFrom } from '../agent/chatstore.js';
import { DEEPSEEK_MODELS, DeepSeek } from '../agent/deepseek.js';
import type { Provider, Usage } from '../agent/provider.js';
import { ChatSession, type ProposalResult, type ToolStep } from '../agent/session.js';
import { diffPreview, describeChange, invertChange, type Change } from '../agent/changes.js';
import type { GitAnswer, GitRequest } from '../agent/gittools.js';
import { ProposalViewer } from './proposalviewer.js';
import { LogViewer } from './logviewer.js';
import { chatMarkup } from '../markdown/chatmarkup.js';
import { escapeMarkup, type MarkupColors } from '../markdown/pango.js';
import type { Palette } from './theme.js';
import { childrenOf, onKeyPress, pack, uiTemplate } from '../gtkutil.js';
import template from './chat.ui?raw';

// Yang perlu diketahui panel dari jendela.
export interface ChatHost {
    active(): { name: string; text: string; cursorLine: number } | null;   // dokumen terbuka (isi buffer, bukan disk)
    selection(): string;
    files(fresh?: boolean): SourceFile[];                                                  // berkas lain di folder proyek
    // Terapkan perubahan yang sudah disetujui pengguna. Mengembalikan pesan galat, atau null bila berhasil.
    applyChange?(change: Change): string | null;
    applyBatch?(changes: Change[]): string | null;
    window?(): Gtk.Window | null;                                           // induk jendela tinjau usulan
    git?(request: GitRequest): Promise<GitAnswer>;                          // alat riwayat Git baca-saja di folder kerja
    root(): string | null;                                                  // folder naskah; tempat riwayat percakapan disimpan
}

const SOURCE_TEXT: Record<KeySource, string> = {
    env: 'Memakai key dari variabel lingkungan DEEPSEEK_API_KEY.',
    keyring: 'Key tersimpan di keyring sistem.',
    file: 'Key tersimpan di ~/.config/nyerat/deepseek.key (keyring tidak tersedia).',
};

const SUGGESTIONS = [
    'Ringkas dokumen ini dalam beberapa poin',
    'Apa saja yang belum selesai atau belum sinkron di folder ini?',
    'Susun rencana langkah berikutnya dari catatan saya',
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

export class ChatPanel extends Gtk.Box {
    static {
        GObject.registerClass({
            GTypeName: 'NyeratChatPanel',
            Template: uiTemplate(template),
            Children: [
                'input', 'sendButton', 'messages', 'scroller', 'contextButton', 'settingsButton', 'historyButton',
                'saveCheck', 'keyEntry', 'keyStatus', 'modelCombo', 'thinkingCheck', 'contextList', 'chatList',
            ],
            InternalChildren: [
                'clearButton', 'logButton', 'historyPopover', 'settingsPopover', 'contextPopover', 'saveKeyButton', 'forgetKeyButton',
                'contextDocument', 'contextSelection', 'contextProject',
            ],
        }, this);
    }
    // Widget yang dideklarasikan di chat.ui.
    declare readonly input: Gtk.TextView;
    declare readonly sendButton: Gtk.Button;
    declare readonly messages: Gtk.Box;
    declare readonly scroller: Gtk.ScrolledWindow;
    declare readonly contextButton: Gtk.MenuButton;
    declare readonly settingsButton: Gtk.MenuButton;
    declare readonly historyButton: Gtk.MenuButton;
    declare readonly saveCheck: Gtk.CheckButton;
    declare readonly keyEntry: Gtk.Entry;
    declare readonly keyStatus: Gtk.Label;
    declare readonly modelCombo: Gtk.ComboBoxText;
    declare readonly thinkingCheck: Gtk.CheckButton;
    declare private readonly contextList: Gtk.Box;
    declare private readonly chatList: Gtk.Box;
    declare private readonly _clearButton: Gtk.Button;
    declare private readonly _logButton: Gtk.Button;
    declare private readonly _historyPopover: Gtk.Popover;
    declare private readonly _settingsPopover: Gtk.Popover;
    declare private readonly _contextPopover: Gtk.Popover;
    declare private readonly _saveKeyButton: Gtk.Button;
    declare private readonly _forgetKeyButton: Gtk.Button;
    declare private readonly _contextDocument: Gtk.CheckButton;
    declare private readonly _contextSelection: Gtk.CheckButton;
    declare private readonly _contextProject: Gtk.CheckButton;

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
    private generation = 0;
    logViewer: LogViewer | null = null;   // jendela pemantau log agent, bila terbuka
    private cancellable: Gio.Cancellable | null = null;
    private renderTimer = 0;
    private dark = false;
    private cardsBox: Gtk.Box | null = null;   // tempat kartu usulan giliran yang sedang berjalan
    viewer: ProposalViewer | null = null;   // jendela tinjau usulan yang sedang menunggu keputusan
    private stickIdle = 0;
    private stick = true;            // tetap menempel di bawah selama pengguna tidak menggulir ke atas
    private summaryTimer = 0;
    // Percakapan yang sedang tampil di disk: berkasnya (null = belum ditulis), folder asalnya, dan judulnya.
    private chatPath: string | null = null;
    private chatRoot: string | null = null;
    private chatTitle = '';
    private chatCreated = '';
    private readonly stepLabels = new Map<string, Gtk.Label>();   // id panggilan alat → baris langkahnya

    constructor() {
        super();
        this._clearButton.connect('clicked', () => this.reset());
        this._logButton.connect('clicked', () => this.showLog());
        this._historyPopover.connect('show', () => this.refreshChatList());

        // Pengaturan: API key dan model.
        this._settingsPopover.connect('show', () => void this.refreshKeyStatus());
        this._saveKeyButton.connect('clicked', () => void this.saveKey());
        this.keyEntry.connect('activate', () => void this.saveKey());
        this._forgetKeyButton.connect('clicked', () => void this.forgetKey());
        for (const m of DEEPSEEK_MODELS) this.modelCombo.append(m, m);
        this.modelCombo.connect('changed', () => {
            const id = this.modelCombo.get_active_id();
            if (!id || id === this.model) return;
            this.model = id;
            this.onModelChanged(id);
        });
        this.thinkingCheck.connect('toggled', () => {
            this.session.thinking = this.thinkingCheck.active;
            this.onThinkingChanged(this.thinkingCheck.active);
        });
        this.saveCheck.active = this.saveChats;
        this.saveCheck.connect('toggled', () => {
            this.saveChats = this.saveCheck.active;
            this.onSaveChanged(this.saveChats);
        });

        // Pesan
        this.empty = this.buildEmptyState();
        this.messages.append(this.empty);
        const vadj = this.scroller.get_vadjustment();
        // Menggulir di dalam sinyal "changed" (dipancarkan saat alokasi tata letak) mengubah nilainya, tetapi viewport tidak
        // menerapkannya: isi tampil terpotong beberapa baris dengan footer tak terlihat. Karena itu digulirkan di idle berikutnya.
        vadj.connect('changed', () => {
            if (!this.stick || this.stickIdle) return;
            this.stickIdle = GLib.idle_add(GLib.PRIORITY_HIGH_IDLE, () => {
                this.stickIdle = 0;
                if (this.stick) vadj.set_value(vadj.get_upper() - vadj.get_page_size());
                return GLib.SOURCE_REMOVE;
            });
        });
        vadj.connect('value-changed', () => { this.stick = vadj.get_upper() - vadj.get_page_size() - vadj.get_value() < 24; });

        // Konteks: pilihan apa yang dikirim.
        const checks: [Gtk.CheckButton, keyof ContextOptions][] = [
            [this._contextDocument, 'activeDocument'], [this._contextSelection, 'selection'], [this._contextProject, 'project'],
        ];
        for (const [check, key] of checks) {
            check.active = this.options[key];
            check.connect('toggled', () => { this.options[key] = check.active; this.updateContextPreview(); });
        }
        this._contextPopover.connect('show', () => this.updateContextPreview());

        // Masukan. Fase CAPTURE: sebelum TextView sendiri menyisipkan baris baru untuk Enter.
        onKeyPress(this.input, (keyval, state) => this.onInputKey(keyval, state), Gtk.PropagationPhase.CAPTURE);
        this.input.buffer.connect('changed', () => this.queueContextSummary());
        this.sendButton.connect('clicked', () => this.busy ? this.stop() : void this.send());
    }

    get widget(): Gtk.Widget {
        return this;
    }

    // Jendela ditutup: hentikan permintaan dan timer yang masih berjalan.
    destroy(): void {
        this.stop();
        this.logViewer?.window.destroy();
        if (this.renderTimer) GLib.source_remove(this.renderTimer);
        this.renderTimer = 0;
        if (this.summaryTimer) GLib.source_remove(this.summaryTimer);
        this.summaryTimer = 0;
        if (this.stickIdle) GLib.source_remove(this.stickIdle);
        this.stickIdle = 0;
    }

    get busy(): boolean {
        return this.cancellable !== null;
    }

    setPalette(palette: Palette): void {
        this.dark = palette.dark;
        this.viewer?.setDark(palette.dark);
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
        this.generation++;
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

    // Buka (atau fokuskan) jendela pemantau log agent.
    showLog(): void {
        if (this.logViewer?.window.get_realized()) { this.logViewer.show(); return; }
        this.logViewer = new LogViewer(this.host.window?.() ?? null, this.session.trace);
        this.logViewer.show();
    }

    // Isi kotak masukan lalu (opsional) langsung kirim; dipakai tombol saran dan tes.
    ask(text: string, send = true): Promise<void> {
        this.input.buffer.set_text(text, -1);
        return send ? this.send() : Promise.resolve();
    }

    async send(): Promise<void> {
        const question = this.input.buffer.text.trim();
        if (!question || this.busy) return;
        const generation = this.generation;
        const found = await this.keyStore.get();
        if (generation !== this.generation || this.busy) return;
        if (!found) {
            this.addNote('Belum ada API key DeepSeek. Buka pengaturan (ikon roda gigi), tempel key-nya, lalu kirim lagi.', true);
            this.settingsButton.get_popover()?.popup();
            return;
        }

        this.input.buffer.set_text('', -1);
        this.empty.hide();
        this.addUser(question);
        const answer = this.addAssistant();
        this.cardsBox = answer.cards;
        this.cancellable = new Gio.Cancellable();
        this.sendButton.set_icon_name('media-playback-stop-symbolic');
        this.sendButton.set_tooltip_text('Hentikan');
        this.stick = true;

        const requestRoot = this.host.root();
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
                currentFiles: () => {
                    if (requestRoot !== this.host.root()) throw Error('Folder kerja berubah selama permintaan');
                    const active = this.options.activeDocument ? this.host.active() : null;
                    return [...this.host.files(true).filter(f => f.name !== active?.name), ...(active ? [{ name: active.name, text: active.text }] : [])];
                },
                onState: () => {
                    if (generation !== this.generation) return;
                    this.persist();
                    if (this.session.work) { answer.work.set_text(workText(this.session.work)); answer.work.show(); }
                },
                onTool: step => this.showStep(answer.steps, step),
                onBatchProposal: this.host.applyBatch ? changes => requestRoot === this.host.root() ? this.propose(changes) : Promise.resolve({ applied: false, error: 'Folder kerja berubah selama permintaan' }) : undefined,
                onProposal: change => requestRoot === this.host.root() ? this.propose(change) : Promise.resolve({ applied: false, error: 'Folder kerja berubah selama permintaan' }),
                git: this.host.git ? request => requestRoot === this.host.root() ? this.host.git!(request) : Promise.resolve({ ok: false, message: 'Folder kerja berubah selama permintaan' }) : undefined,
            }, this.cancellable);
            if (generation !== this.generation) return;
            this.render(answer.bubble);
            if (result.cancelled) answer.footer.set_text(answer.bubble.text || result.toolCalls ? 'Dihentikan' : 'Dihentikan sebelum ada jawaban');
            else if (result.usage) answer.footer.set_text(usageText(result.usage, result.toolCalls, result.applied));
            answer.footer.set_visible(!!answer.footer.get_text());
            this.persist();
        } catch (e) {
            if (generation !== this.generation) return;
            if (this.session.work) this.session.work.status = 'failed';
            this.persist();
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
        if (!this.saveChats || !root || !history.length && !this.session.work && !this.session.events.length) return;
        if (root !== this.chatRoot) {
            // Pindah folder di tengah percakapan: lanjutannya ditulis sebagai berkas baru di folder yang baru.
            this.chatRoot = root;
            this.chatPath = null;
        }
        if (!this.chatPath) {
            this.chatCreated = nowStamp();
            this.chatTitle = titleFrom(history.find(t => t.role === 'user')?.content ?? this.session.work?.goal ?? this.session.events[0]?.question ?? '');
        }
        try {
            this.chatPath = saveChat(root, { title: this.chatTitle, model: this.model, created: this.chatCreated, turns: [...history], work: this.session.work, events: this.session.events }, this.chatPath);
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
        this.session.work = chat.work ?? null;
        this.session.events.push(...chat.events ?? []);
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
        if (this.session.events.length) {
            this.addNote(journalText(this.session.events));
            for (const event of this.session.events.filter(e => e.changes.length).slice(-20)) {
                const row = new Gtk.Box({ spacing: 6, halign: Gtk.Align.START });
                const review = new Gtk.Button({ label: `Lihat diff · ${event.changes.length} berkas`, tooltip_text: event.changes.map(c => c.file).join('\n') });
                review.connect('clicked', () => new ProposalViewer(this.host.window?.() ?? null, event.changes, this.dark, () => 'Riwayat hanya dapat dibaca', true).show());
                row.append(review);
                if (event.status === 'applied' && this.host.applyBatch) row.append(this.undoButton(event.changes, null));
                this.messages.append(row);
            }
        }
        if (this.session.work) {
            this.addNote(workText(this.session.work), false, 'chat-work');
            if (this.session.work.status !== 'complete') {
                const resume = new Gtk.Button({ label: 'Lanjutkan pekerjaan', halign: Gtk.Align.START });
                resume.connect('clicked', () => { resume.set_sensitive(false); void this.ask('Lanjutkan pekerjaan yang tersimpan. Baca isi aktual, periksa journal, dan jangan ulangi perubahan yang sudah diterapkan.'); });
                this.messages.append(resume);
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
        const work = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 44, selectable: true, visible: false });
        work.add_css_class('chat-work');
        const steps = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, visible: false });
        // Kartu usulan perubahan agent: di antara langkah penelusuran dan jawaban, sesuai urutan kejadiannya.
        const cards = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, visible: false });
        const thinkingLabel = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 40, selectable: true });
        thinkingLabel.add_css_class('chat-thinking');
        const thinking = new Gtk.Expander({ label: 'Proses berpikir', visible: false });
        thinking.set_child(thinkingLabel);
        const footer = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 44, selectable: true, visible: false, use_markup: true });
        footer.add_css_class('side-meta');
        const row = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
        row.append(meta);
        row.append(work);
        row.append(steps);
        row.append(cards);
        row.append(thinking);
        row.append(bubble.label);
        row.append(footer);
        meta.hide();
        thinking.hide();
        footer.hide();
        this.messages.append(row);
        return { bubble, meta, work, steps, cards, thinking, thinkingLabel, footer };
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

    // Usulan perubahan: jendela tinjau (seperti diff riwayat Git) terbuka otomatis; di panel tertinggal kartu
    // ringkas dengan status dan tombol untuk membukanya lagi. Berkas tidak disentuh sebelum Terapkan; menutup
    // jendela, Tolak, atau menghentikan giliran sama dengan menolak.
    private propose(change: Change | Change[]): Promise<ProposalResult> {
        const proposalRoot = this.host.root();
        const changes = Array.isArray(change) ? change : [change];
        const description = Array.isArray(change) ? `Paket perubahan · ${changes.length} berkas` : describeChange(change);
        const reasonText = changes.map(c => `${c.file}: ${c.reason}`).join('\n');
        const card = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
        card.add_css_class('chat-proposal');
        const title = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 44, use_markup: true, selectable: true });
        title.set_markup(`<b>${escapeMarkup(description)}</b>`);
        card.append(title);
        if (reasonText.trim()) {
            const reason = new Gtk.Label({ label: reasonText.trim(), xalign: 0, wrap: true, max_width_chars: 44, selectable: true });
            reason.add_css_class('side-meta');
            card.append(reason);
        }
        const diff = changes.map(c => diffPreview(c.before, c.after)).reduce((a, b) => ({ added: a.added + b.added, removed: a.removed + b.removed }), { added: 0, removed: 0 });
        const status = new Gtk.Label({ label: `+${diff.added} −${diff.removed} · menunggu keputusan Anda`, xalign: 0, wrap: true, max_width_chars: 44 });
        status.add_css_class('side-meta');
        const review = new Gtk.Button({ label: 'Tinjau perubahan', halign: Gtk.Align.START });
        review.add_css_class('suggested-action');
        card.append(status);
        card.append(review);
        this.empty.hide();
        (this.cardsBox ?? this.messages).append(card);
        this.cardsBox?.show();
        this.stick = true;

        return new Promise<ProposalResult>(resolve => {
            let done = false;
            const finish = (result: ProposalResult, text: string, error = false) => {
                if (done) return;
                done = true;
                this.viewer = null;
                review.hide();
                status.set_text(text);
                status.remove_css_class('side-meta');
                status.remove_css_class('chat-error');
                status.add_css_class(error ? 'chat-error' : 'side-meta');
                resolve(result);
            };
            const open = () => {
                if (done) return;
                if (this.viewer) { this.viewer.show(); return; }
                const viewer = new ProposalViewer(this.host.window?.() ?? null, change, this.dark,
                    c => proposalRoot !== this.host.root() ? 'Folder kerja berubah sejak usulan dibuat' : Array.isArray(c) ? this.host.applyBatch ? this.host.applyBatch(c) : 'penerapan paket tidak tersedia' : this.host.applyChange ? this.host.applyChange(c) : 'penerapan tidak tersedia');
                viewer.onDecision = applied => {
                    const note = viewer.note ? { note: viewer.note } : {};
                    if (applied && viewer.accepted) {
                        const kept = viewer.accepted.map(i => changes[i]);
                        finish({ applied: true, accepted: viewer.accepted, ...note }, `Diterapkan ${kept.length} dari ${changes.length} berkas.`);
                        if (this.host.applyBatch) card.append(this.undoButton(kept, status));
                    } else if (applied) {
                        finish({ applied: true, ...note }, 'Diterapkan.');
                        if (this.host.applyBatch) card.append(this.undoButton(changes, status));
                    } else if (viewer.error) finish({ applied: false, error: viewer.error, ...note }, `Gagal diterapkan: ${viewer.error}`, true);
                    else finish({ applied: false, ...note }, viewer.note ? `Ditolak: ${viewer.note}` : 'Ditolak.');
                };
                this.viewer = viewer;
                viewer.show();
            };
            review.connect('clicked', open);
            this.cancellable?.connect(() => {
                const viewer = this.viewer;
                finish({ applied: false }, 'Dibatalkan.');
                viewer?.close();
            });
            open();
        });
    }

    // Tombol Urungkan untuk perubahan agent yang sudah diterapkan: menerapkan kebalikannya lewat preflight yang sama,
    // jadi gagal (tanpa menimpa apa pun) bila berkasnya sudah disunting lagi sejak itu. Journal mencatatnya supaya
    // agent tahu perubahan itu tidak berlaku lagi.
    private undoButton(changes: Change[], status: Gtk.Label | null): Gtk.Button {
        const button = new Gtk.Button({ label: 'Urungkan', halign: Gtk.Align.START, tooltip_text: 'Kembalikan berkas ke isi sebelum perubahan ini' });
        button.connect('clicked', () => {
            if (this.busy) { this.addNote('Tunggu agent selesai sebelum mengurungkan perubahan.', true); return; }
            const root = this.host.root();
            const error = this.host.applyBatch ? this.host.applyBatch([...changes].reverse().map(invertChange)) : 'penerapan tidak tersedia';
            if (error) { this.addNote(`Tidak dapat diurungkan: ${error}`, true); return; }
            button.hide();
            status?.set_text('Diurungkan.');
            for (const event of this.session.events) {
                if (event.status !== 'applied' || !event.changes.some(c => changes.includes(c))) continue;
                event.status = 'reverted';
                event.summary = 'Diurungkan pengguna dari panel; berkas kembali ke isi sebelumnya.';
            }
            const work = this.session.work;
            if (work) { delete work.verification; if (work.status === 'complete') work.status = 'paused'; }
            if (root === this.host.root()) this.persist();
        });
        return button;
    }

    private addNote(text: string, error = false, cssClass = 'side-meta'): void {
        const l = new Gtk.Label({ label: text, xalign: 0, wrap: true, max_width_chars: 40, selectable: true });
        l.add_css_class(error ? 'chat-error' : cssClass);
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
