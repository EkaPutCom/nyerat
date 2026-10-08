// The Assistant panel on the right side: a chat with a model (DeepSeek) that knows the manuscript contents.
// The panel does not know how to get the manuscript; the window provides it through `host`. Context composition
// is in agent/context.ts, and calling the model goes through the Provider (agent/provider.ts).
//
//   ┌ ASSISTANT               ⌫ ⚙ ┐
//   │ (messages, newest below)     │
//   │ Context · ≈12k tokens ▾      │
//   │ [type a question…      ] [➤] │
//   └──────────────────────────────┘

import { journalText } from '../agent/journal.js';
import { WorkList } from './worklist.js';
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
import { _, fmt } from '../i18n.js';

// What the panel needs to know from the window.
export interface ChatHost {
    active(): { name: string; text: string; cursorLine: number } | null;   // the open document (buffer contents, not disk)
    selection(): string;
    files(fresh?: boolean): SourceFile[];                                                  // other files in the project folder
    // Apply a change the user has approved. Returns an error message, or null on success.
    applyChange?(change: Change): string | null;
    applyBatch?(changes: Change[]): string | null;
    window?(): Gtk.Window | null;                                           // parent of the proposal review window
    git?(request: GitRequest): Promise<GitAnswer>;                          // read-only Git history tools in the work folder
    root(): string | null;                                                  // the manuscript folder; where conversation history is saved
}

const SOURCE_TEXT: Record<KeySource, string> = {
    env: _('Using the key from the DEEPSEEK_API_KEY environment variable.'),
    keyring: _('The key is stored in the system keyring.'),
    file: _('The key is stored in ~/.config/nyerat/deepseek.key (keyring unavailable).'),
};

const SUGGESTIONS = [
    _('Summarize this document in a few points'),
    _('What is unfinished or out of sync in this folder?'),
    _('Draft a plan for the next steps from my notes'),
];

const KIND_LABEL = { map: _('Map'), active: _('Document'), selection: _('Selection'), mention: _('Attachment'), excerpt: _('Excerpt') };

const fmtTokens = (n: number): string => n >= 1000 ? `${(n / 1000).toFixed(1).replace('.', ',')} rb` : `${n}`;
const fmtTokens = (n: number): string => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
const usageText = (u: Usage, toolCalls: number, applied = 0): string => [
    fmt(u.cached ? _('{prompt} in ({cached} from cache)') : _('{prompt} in'), { prompt: fmtTokens(u.prompt), cached: fmtTokens(u.cached) }),
    fmt(_('{completion} out'), { completion: fmtTokens(u.completion) }),
    ...toolCalls ? [fmt(_('{count} lookups'), { count: toolCalls })] : [],
    ...applied ? [fmt(_('{count} changes applied'), { count: applied })] : [],
].join(' · ');

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
                'saveCheck', 'keyEntry', 'keyStatus', 'modelDrop', 'thinkingCheck', 'contextList', 'chatList',
            ],
            InternalChildren: [
                'clearButton', 'logButton', 'historyPopover', 'settingsPopover', 'contextPopover', 'saveKeyButton', 'forgetKeyButton',
                'contextDocument', 'contextSelection', 'contextProject',
            ],
        }, this);
    }
    // Widgets declared in chat.ui.
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
    declare readonly modelDrop: Gtk.DropDown;
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
    // Replaced in tests with a fake provider.
    makeProvider: (key: string) => Provider = key => new DeepSeek(key);
    keyStore: KeyStore = systemKeyStore;
    model = DEEPSEEK_MODELS[0];   // the model is sent to the API as is; setModel() normalizes it
    onModelChanged: (model: string) => void = () => {};
    onThinkingChanged: (thinking: boolean) => void = () => {};
    onSaveChanged: (save: boolean) => void = () => {};
    saveChats = true;   // save every turn to <folder>/.nyerat/chats
    options: ContextOptions = { activeDocument: true, selection: true, project: true };
    budget = DEFAULT_BUDGET;

    private colors: MarkupColors = { code: '#c7254e', codeBg: '#f3f4f4', link: '#1c71d8', mark: '#fff3a3' };
    private readonly bubbles: Bubble[] = [];
    readonly empty: Gtk.Box;           // initial hint; shown while the conversation is empty
    private generation = 0;
    logViewer: LogViewer | null = null;   // the agent log monitor window, if open
    private cancellable: Gio.Cancellable | null = null;
    private renderTimer = 0;
    private dark = false;
    private cardsBox: Gtk.Box | null = null;   // where the proposal cards of the running turn live
    viewer: ProposalViewer | null = null;   // the proposal review window waiting for a decision
    private stickIdle = 0;
    private stick = true;            // stay stuck to the bottom as long as the user has not scrolled up
    private summaryTimer = 0;
    // The conversation currently shown on disk: its file (null = not written yet), the folder it came from, and its title.
    private chatPath: string | null = null;
    private chatRoot: string | null = null;
    private chatTitle = '';
    private chatCreated = '';
    private readonly stepLabels = new Map<string, Gtk.Label>();   // tool call id → its step row

    constructor() {
        super();
        this._clearButton.connect('clicked', () => this.reset());
        this._logButton.connect('clicked', () => this.showLog());
        this._historyPopover.connect('show', () => this.refreshChatList());

        // Settings: API key and model.
        this._settingsPopover.connect('show', () => void this.refreshKeyStatus());
        this._saveKeyButton.connect('clicked', () => void this.saveKey());
        this.keyEntry.connect('activate', () => void this.saveKey());
        this._forgetKeyButton.connect('clicked', () => void this.forgetKey());
        this.modelDrop.set_model(Gtk.StringList.new(DEEPSEEK_MODELS));
        this.modelDrop.connect('notify::selected', () => {
            const id = DEEPSEEK_MODELS[this.modelDrop.get_selected()];
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

        // Messages
        this.empty = this.buildEmptyState();
        this.messages.append(this.empty);
        const vadj = this.scroller.get_vadjustment();
        // Scrolling inside the "changed" signal (emitted during layout allocation) changes its value, but the viewport does not
        // apply it: the contents show cut off by a few lines with an invisible footer. That is why it scrolls at the next idle.
        vadj.connect('changed', () => {
            if (!this.stick || this.stickIdle) return;
            this.stickIdle = GLib.idle_add(GLib.PRIORITY_HIGH_IDLE, () => {
                this.stickIdle = 0;
                if (this.stick) vadj.set_value(vadj.get_upper() - vadj.get_page_size());
                return GLib.SOURCE_REMOVE;
            });
        });
        vadj.connect('value-changed', () => { this.stick = vadj.get_upper() - vadj.get_page_size() - vadj.get_value() < 24; });

        // Context: which choices are sent.
        const checks: [Gtk.CheckButton, keyof ContextOptions][] = [
            [this._contextDocument, 'activeDocument'], [this._contextSelection, 'selection'], [this._contextProject, 'project'],
        ];
        for (const [check, key] of checks) {
            check.active = this.options[key];
            check.connect('toggled', () => { this.options[key] = check.active; this.updateContextPreview(); });
        }
        this._contextPopover.connect('show', () => this.updateContextPreview());

        // Input. CAPTURE phase: before the TextView itself inserts a new line for Enter.
        onKeyPress(this.input, (keyval, state) => this.onInputKey(keyval, state), Gtk.PropagationPhase.CAPTURE);
        this.input.buffer.connect('changed', () => { this.queueContextSummary(); this.updateSendButton(); });
        this.sendButton.connect('clicked', () => this.busy ? this.stop() : void this.send());
        this.updateSendButton();
        // The panel may already be open since the window was created (GSettings), without notify::show-sidebar: compute when shown.
        this.connect('map', () => this.updateContextSummary());
    }

    // Send: the primary button (suggested-action), disabled while the message box is empty. Stop: a plain button, always enabled.
    private updateSendButton(): void {
        const busy = this.busy;
        this.sendButton.set_icon_name(busy ? 'media-playback-stop-symbolic' : 'go-up-symbolic');
        this.sendButton.set_tooltip_text(busy ? _('Stop') : _('Send (Enter)'));
        this.sendButton.update_property([Gtk.AccessibleProperty.LABEL], [busy ? _('Stop') : _('Send')]);
        if (busy) this.sendButton.remove_css_class('suggested-action');
        else this.sendButton.add_css_class('suggested-action');
        this.sendButton.set_sensitive(busy || !!this.input.buffer.text.trim());
    }

    get widget(): Gtk.Widget {
        return this;
    }

    // Window closed: stop the requests and timers that are still running.
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

    // An old or unknown model name (e.g. from a settings version) is replaced with the default model.
    setModel(model: string): void {
        this.model = DEEPSEEK_MODELS.includes(model) ? model : DEEPSEEK_MODELS[0];
        this.modelDrop.set_selected(DEEPSEEK_MODELS.indexOf(this.model));
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

    // ---------- Conversation ----------

    reset(): void {
        this.generation++;
        this.stop();
        this.session.clear();
        this.chatPath = null;
        this.stepLabels.clear();   // the labels are discarded below; the same tool id must not reuse them
        this.bubbles.length = 0;
        for (const child of childrenOf(this.messages)) if (child !== this.empty) this.messages.remove(child);
        this.empty.show();
        this.updateContextSummary();
    }

    stop(): void {
        this.cancellable?.cancel();
    }

    // Open (or focus) the agent log monitor window.
    showLog(): void {
        if (this.logViewer?.window.get_realized()) { this.logViewer.show(); return; }
        this.logViewer = new LogViewer(this.host.window?.() ?? null, this.session.trace);
        this.logViewer.show();
    }

    // Fill the input box and (optionally) send right away; used by the suggestion buttons and tests.
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
            this.addNote('There is no DeepSeek API key yet. Open the settings (gear icon), paste the key, then send again.', true);
            this.settingsButton.get_popover()?.popup();
            return;
        }

        this.input.buffer.set_text('', -1);
        this.empty.hide();
        this.addUser(question);
        const answer = this.addAssistant();
        this.cardsBox = answer.cards;
        this.cancellable = new Gio.Cancellable();
        this.updateSendButton();
        this.stick = true;

        const requestRoot = this.host.root();
        const started = GLib.get_monotonic_time();
        const elapsed = () => (GLib.get_monotonic_time() - started) / 1e6;
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
                    if (requestRoot !== this.host.root()) throw Error('The work folder changed during the request');
                    const active = this.options.activeDocument ? this.host.active() : null;
                    return [...this.host.files(true).filter(f => f.name !== active?.name), ...(active ? [{ name: active.name, text: active.text }] : [])];
                },
                onState: () => {
                    if (generation !== this.generation) return;
                    this.persist();
                    if (this.session.work) { answer.work.update(this.session.work, true, elapsed()); answer.work.widget.show(); }
                },
                // A valid plan is already shown as a checklist; its step row does not need repeating.
                onTool: step => { if (!(step.label === 'Work plan' && this.session.work && step.summary !== 'invalid plan')) this.showStep(answer.steps, step); },
                onBatchProposal: this.host.applyBatch ? changes => requestRoot === this.host.root() ? this.propose(changes) : Promise.resolve({ applied: false, error: 'The work folder changed during the request' }) : undefined,
                onProposal: change => requestRoot === this.host.root() ? this.propose(change) : Promise.resolve({ applied: false, error: 'The work folder changed during the request' }),
                git: this.host.git ? request => requestRoot === this.host.root() ? this.host.git!(request) : Promise.resolve({ ok: false, message: 'The work folder changed during the request' }) : undefined,
            }, this.cancellable);
            if (generation !== this.generation) return;
            this.render(answer.bubble);
            if (answer.work.widget.get_visible() && this.session.work) answer.work.update(this.session.work, false, elapsed());
            if (result.cancelled) answer.footer.set_text(answer.bubble.text || result.toolCalls ? _('Stopped') : _('Stopped before any answer'));
            else if (result.usage) answer.footer.set_text(usageText(result.usage, result.toolCalls, result.applied));
            answer.footer.set_visible(!!answer.footer.get_text());
            this.persist();
        } catch (e) {
            if (generation !== this.generation) return;
            if (this.session.work) this.session.work.status = 'failed';
            this.persist();
            if (answer.work.widget.get_visible() && this.session.work) answer.work.update(this.session.work, false, elapsed());
            this.render(answer.bubble);
            answer.footer.set_markup(`<span foreground="#c9372c">${escapeMarkup(e instanceof Error ? e.message : String(e))}</span>`);
            answer.footer.show();
            if (!answer.bubble.text) answer.bubble.label.hide();
        } finally {
            this.cancellable = null;
            this.updateSendButton();
            this.updateContextSummary();
        }
    }

    // ---------- History on disk ----------

    // Write the conversation to <folder>/.nyerat/chats after every turn. Without a folder, or when turned off, nothing is written.
    private persist(): void {
        const root = this.host.root();
        const history = this.session.history;
        if (!this.saveChats || !root || !history.length && !this.session.work && !this.session.events.length) return;
        if (root !== this.chatRoot) {
            // Switching folders in the middle of a conversation: the continuation is written as a new file in the new folder.
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
            this.addNote(fmt(_('Conversation history was not saved: {error}'), { error: e instanceof Error ? e.message : String(e) }), true);
        }
    }

    // Show a saved conversation and continue from there: the next turns are appended to the same file.
    openChat(path: string): boolean {
        const chat = loadChat(path);
        if (!chat) {
            this.addNote('The conversation file could not be read.', true);
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
                const review = new Gtk.Button({ label: fmt(_('View diff · {count} files'), { count: event.changes.length }), tooltip_text: event.changes.map(c => c.file).join('\n') });
                review.connect('clicked', () => new ProposalViewer(this.host.window?.() ?? null, event.changes, this.dark, () => _('History is read-only'), true).show());
                row.append(review);
                if (event.status === 'applied' && this.host.applyBatch) row.append(this.undoButton(event.changes, null));
                this.messages.append(row);
            }
        }
        if (this.session.work) {
            const list = new WorkList();
            list.update(this.session.work, false);
            this.messages.append(list.widget);
            if (this.session.work.status !== 'complete') {
                const resume = new Gtk.Button({ label: _('Resume work'), halign: Gtk.Align.START });
                resume.connect('clicked', () => { resume.set_sensitive(false); void this.ask('Resume the saved work. Read the actual contents, check the journal, and do not repeat changes that were already applied.'); });
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
        if (!root) return note('Open a work folder to save and open conversation history.');
        const chats = listChats(root);
        if (!chats.length) return note('There are no saved conversations in this folder yet.');
        const popover = this.historyButton.get_popover();
        for (const chat of chats) {
            const row = new Gtk.Box({ spacing: 2 });
            const open = new Gtk.Button({ has_frame: false, tooltip_text: fmt(_('{date} · {turns} Q&A'), { date: chat.created.replace('T', ' '), turns: chat.turns / 2 | 0 }) });
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
            remove.set_tooltip_text(_('Move to the Trash'));
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

    // ---------- Context ----------

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

    // Builds the context for the text being typed, without sending anything.
    previewContext(): BuiltContext {
        return buildContext({ ...this.turnInput(this.input.buffer.text), recent: this.session.questions });
    }

    // A one-line summary of what is sent: the document, selection, attachments, and the number of excerpts per file.
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
        for (const [file, n] of excerpts) parts.push(fmt(_('{count} excerpts from {file}'), { count: n, file }));
        if (built.unknownMentions.length) parts.push(fmt(_('not found: {names}'), { names: built.unknownMentions.map(m => `@${m}`).join(', ') }));
        return fmt(_('Context: {parts}'), { parts: parts.join(' · ') });
    }

    private setContextSummary(built: BuiltContext): void {
        // No arrow of its own: a labeled GTK 4 MenuButton already shows its popover direction arrow.
        this.contextButton.set_label(fmt(_('Context · ≈{tokens} tokens'), { tokens: fmtTokens(built.tokens) }));
    }

    // Building the context touches the whole project, so the summary is only updated while the panel is visible
    // and after typing pauses for a moment.
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
        if (!built.items.length) add('No document context is being sent.', true);
        for (const item of built.items) add(`${KIND_LABEL[item.kind]}: ${item.label} · ${fmtTokens(item.tokens)}`);
        add(fmt(_('Total ≈{tokens} tokens of the {budget} budget'), { tokens: fmtTokens(built.tokens), budget: fmtTokens(this.budget) }), true);
        for (const m of built.unknownMentions) add(fmt(_('File @{name} was not found in the project folder.'), { name: m }), true);
        this.setContextSummary(built);
    }

    // ---------- API key ----------

    private async refreshKeyStatus(): Promise<void> {
        const found = await this.keyStore.get();
        this.keyStatus.set_text(found ? SOURCE_TEXT[found.source] : _('No key yet. Create one at platform.deepseek.com.'));
    }

    private async saveKey(): Promise<void> {
        const key = this.keyEntry.text.trim();
        if (!key) return;
        try {
            const source = await this.keyStore.set(key);
            this.keyEntry.set_text('');
            this.keyStatus.set_text(SOURCE_TEXT[source]);
        } catch (e) {
            this.keyStatus.set_text(fmt(_('Failed to save: {error}'), { error: e instanceof Error ? e.message : String(e) }));
        }
    }

    private async forgetKey(): Promise<void> {
        await this.keyStore.clear();
        await this.refreshKeyStatus();
    }

    // ---------- Messages ----------

    private buildEmptyState(): Gtk.Box {
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, margin_top: 8 });
        const intro = new Gtk.Label({
            label: _('Ask or request help with anything about your work. The assistant reads the open document and relevant excerpts from other files in the folder.'),
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

    // Consecutive updates while an answer streams in are merged; the markup is re-parsed at most ±15 times per second.
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
        const work = new WorkList();
        work.widget.hide();
        const steps = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, visible: false });
        // Proposal cards of agent changes: between the browsing steps and the answer, in the order they happened.
        const cards = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, visible: false });
        const thinkingLabel = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 40, selectable: true });
        thinkingLabel.add_css_class('chat-thinking');
        const thinking = new Gtk.Expander({ label: _('Thinking process'), visible: false });
        thinking.set_child(thinkingLabel);
        const footer = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 44, selectable: true, visible: false, use_markup: true });
        footer.add_css_class('side-meta');
        const row = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
        row.append(meta);
        row.append(work.widget);
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

    // One row per assistant lookup: "Searching “letter”…" and then, once finished, "… → 5 snippets".
    // Called twice per tool (start and finish) with the same id.
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

    // Change proposal: the review window (like a Git history diff) opens automatically; in the panel a compact card
    // is left behind with the status and a button to open it again. Files are not touched before Apply; closing
    // the window, Reject, or stopping the turn is the same as rejecting.
    private propose(change: Change | Change[]): Promise<ProposalResult> {
        const proposalRoot = this.host.root();
        const changes = Array.isArray(change) ? change : [change];
        const description = Array.isArray(change) ? fmt(_('Change batch · {count} files'), { count: changes.length }) : describeChange(change);
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
        const status = new Gtk.Label({ label: fmt(_('+{added} −{removed} · waiting for your decision'), { added: diff.added, removed: diff.removed }), xalign: 0, wrap: true, max_width_chars: 44 });
        status.add_css_class('side-meta');
        const review = new Gtk.Button({ label: _('Review changes'), halign: Gtk.Align.START });
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
                    c => proposalRoot !== this.host.root() ? 'The work folder changed since the proposal was made' : Array.isArray(c) ? this.host.applyBatch ? this.host.applyBatch(c) : 'applying batches is not available' : this.host.applyChange ? this.host.applyChange(c) : 'applying is not available');
                viewer.onDecision = applied => {
                    const note = viewer.note ? { note: viewer.note } : {};
                    if (applied && viewer.accepted) {
                        const kept = viewer.accepted.map(i => changes[i]);
                        finish({ applied: true, accepted: viewer.accepted, ...note }, fmt(_('Applied {applied} of {count} files.'), { applied: kept.length, count: changes.length }));
                        if (this.host.applyBatch) card.append(this.undoButton(kept, status));
                    } else if (applied) {
                        finish({ applied: true, ...note }, _('Applied.'));
                        if (this.host.applyBatch) card.append(this.undoButton(changes, status));
                    } else if (viewer.error) finish({ applied: false, error: viewer.error, ...note }, fmt(_('Failed to apply: {error}'), { error: viewer.error }), true);
                    else finish({ applied: false, ...note }, viewer.note ? fmt(_('Rejected: {note}'), { note: viewer.note }) : _('Rejected.'));
                };
                this.viewer = viewer;
                viewer.show();
            };
            review.connect('clicked', open);
            this.cancellable?.connect(() => {
                const viewer = this.viewer;
                finish({ applied: false }, _('Cancelled.'));
                viewer?.close();
            });
            open();
        });
    }

    // The Undo button for agent changes that were already applied: applies the inverse through the same preflight,
    // so it fails (without overwriting anything) if the file has been edited again since. The journal records it so the
    // agent knows that change no longer applies.
    private undoButton(changes: Change[], status: Gtk.Label | null): Gtk.Button {
        const button = new Gtk.Button({ label: _('Undo'), halign: Gtk.Align.START, tooltip_text: _('Restore the files to their contents before this change') });
        button.connect('clicked', () => {
            if (this.busy) { this.addNote('Wait for the agent to finish before undoing the change.', true); return; }
            const root = this.host.root();
            const error = this.host.applyBatch ? this.host.applyBatch([...changes].reverse().map(invertChange)) : 'applying is not available';
            if (error) { this.addNote(fmt(_('Cannot be undone: {error}'), { error }), true); return; }
            button.hide();
            status?.set_text(_('Undone.'));
            for (const event of this.session.events) {
                if (event.status !== 'applied' || !event.changes.some(c => changes.includes(c))) continue;
                event.status = 'reverted';
                event.summary = 'Undone by the user from the panel; the files are back to their previous contents.';
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

    // Enter sends; Shift+Enter is a new line.
    onInputKey(keyval: number, state: number): boolean {
        if ((keyval !== Gdk.KEY_Return && keyval !== Gdk.KEY_KP_Enter) || state & Gdk.ModifierType.SHIFT_MASK) return false;
        if (!this.busy) void this.send();
        return true;
    }
}
