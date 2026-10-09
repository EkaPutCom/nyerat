// The right-hand side of the agent log: everything known about the selected event (metrics, arguments, result, raw text).
// Built once; show() only updates the texts, so a streaming reasoning does not reset the scroll position.

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import { AgentTrace, type TraceEvent } from '../agent/trace.js';
import { descendants, formatCount, formatMs, formatSize, traceStats, turnEvents, type TraceNode } from '../agent/tracetree.js';
import { _, fmt } from '../i18n.js';

type Metric = [value: string, caption: string];

const duration = (e: TraceEvent): string => e.ms !== undefined ? formatMs(e.ms) : e.status === 'running' ? '…' : '–';

const toolMetrics = (e: TraceEvent, nodes: TraceNode[]): Metric[] => {
    const busy = traceStats(turnEvents(nodes, e.seq)).ms;
    const share = e.ms !== undefined && busy > 0 ? `${Math.max(1, Math.round(e.ms / busy * 100))}%` : '–';
    return [[duration(e), _('Duration')], [formatSize((e.result ?? '').length), _('Result size')], [share, _('Of the turn’s time')], [`#${e.seq}`, _('Event')]];
};

const roundMetrics = (e: TraceEvent, nodes: TraceNode[]): Metric[] => {
    const tools = descendants(nodes, e.seq).filter(x => x.kind === 'tool').length;
    const u = e.usage;
    return [[duration(e), _('Model time')], [u ? formatCount(u.prompt) : '–', u ? fmt(_('Tokens in ({cached} cached)'), { cached: formatCount(u.cached) }) : _('Tokens in')], [u ? formatCount(u.completion) : '–', _('Tokens out')], [`${tools}`, _('Tool calls')]];
};

const turnMetrics = (e: TraceEvent, nodes: TraceNode[]): Metric[] => {
    const s = traceStats(turnEvents(nodes, e.seq));
    return [[formatMs(s.ms), _('Model and tools')], [`${s.rounds}`, _('Rounds')], [`${s.tools}${s.failed ? ` · ${s.failed} ✗` : ''}`, _('Tool calls')], [`${formatCount(s.prompt)} / ${formatCount(s.completion)}`, _('Tokens in / out')]];
};

const otherMetrics = (e: TraceEvent): Metric[] => [[e.time.slice(11), _('Time')], [e.round !== undefined ? `${e.round}` : '–', _('Round')], [formatSize((e.detail + (e.result ?? '')).length), _('Size')], [`#${e.seq}`, _('Event')]];

const METRICS: Partial<Record<TraceEvent['kind'], (e: TraceEvent, nodes: TraceNode[]) => Metric[]>> = { tool: toolMetrics, round: roundMetrics, turn: turnMetrics };

const preview = (text: string, lines = 12): string => {
    const all = text.split('\n');
    return all.length > lines ? `${all.slice(0, lines).join('\n')}\n…` : text;
};

const TITLED = new Set(['round', 'reasoning', 'text']);

interface Block { box: Gtk.Box; label: Gtk.Label }

export class LogDetail {
    readonly widget = new Gtk.Stack();
    private readonly title = new Gtk.Label({ xalign: 0, hexpand: true, ellipsize: 3, selectable: true });
    private readonly chip = new Gtk.Label({ valign: Gtk.Align.CENTER });
    private readonly subtitle = new Gtk.Label({ xalign: 1 });
    private readonly cards: { box: Gtk.Box; value: Gtk.Label; caption: Gtk.Label }[] = [];
    private readonly tabs = new Map<string, Gtk.ToggleButton>();
    private readonly pages = new Gtk.Stack();
    private readonly blocks: Record<'context' | 'args' | 'result' | 'detail', Block>;
    private readonly argsPage = LogDetail.mono();
    private readonly resultPage = LogDetail.mono();
    private readonly rawPage = LogDetail.mono();
    private readonly copyArgs = new Gtk.Button({ label: _('Copy arguments') });
    private readonly copyResult = new Gtk.Button({ label: _('Copy result') });
    private event: TraceEvent | null = null;

    constructor() {
        const empty = new Adw.StatusPage({ icon_name: 'utilities-terminal-symbolic', title: _('Nothing selected'), description: _('Choose a step on the left to see its details.') });
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10, margin_start: 14, margin_end: 14, margin_top: 12, margin_bottom: 12 });
        this.title.add_css_class('heading');
        this.subtitle.add_css_class('dim-label');
        this.subtitle.add_css_class('caption');
        const head = new Gtk.Box({ spacing: 8 });
        head.append(this.title);
        head.append(this.chip);
        head.append(this.subtitle);
        box.append(head);
        box.append(this.buildCards());
        box.append(this.buildTabs());

        this.blocks = { context: this.block(_('Context sent')), args: this.block(_('Arguments')), result: this.block(_('Result (preview)')), detail: this.block(_('Details')) };
        const summary = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10 });
        for (const b of Object.values(this.blocks)) summary.append(b.box);
        this.pages.add_named(summary, 'summary');
        this.pages.add_named(this.argsPage, 'args');
        this.pages.add_named(this.resultPage, 'result');
        this.pages.add_named(this.rawPage, 'raw');
        const scroller = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true });
        scroller.set_child(this.pages);
        box.append(scroller);
        box.append(this.buildActions());

        this.widget.add_named(empty, 'empty');
        this.widget.add_named(box, 'event');
    }

    private static mono(): Gtk.Label {
        const label = new Gtk.Label({ xalign: 0, yalign: 0, wrap: true, wrap_mode: 2, selectable: true, margin_bottom: 4 });
        label.add_css_class('chat-diff');
        return label;
    }

    private block(caption: string): Block {
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
        const head = new Gtk.Label({ label: caption, xalign: 0 });
        head.add_css_class('caption');
        head.add_css_class('dim-label');
        const label = LogDetail.mono();
        label.add_css_class('log-block');
        box.append(head);
        box.append(label);
        return { box, label };
    }

    private buildCards(): Gtk.Widget {
        const row = new Gtk.Box({ spacing: 8, homogeneous: true });
        for (let i = 0; i < 4; i++) {
            const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, margin_start: 10, margin_end: 10, margin_top: 8, margin_bottom: 8 });
            const value = new Gtk.Label({ xalign: 0 });
            value.add_css_class('title-3');
            const caption = new Gtk.Label({ xalign: 0, ellipsize: 3 });
            caption.add_css_class('caption');
            caption.add_css_class('dim-label');
            box.append(value);
            box.append(caption);
            const card = new Gtk.Box();
            card.add_css_class('card');
            card.append(box);
            row.append(card);
            this.cards.push({ box: card, value, caption });
        }
        return row;
    }

    private buildTabs(): Gtk.Widget {
        const row = new Gtk.Box({ spacing: 0 });
        row.add_css_class('linked');
        let first: Gtk.ToggleButton | null = null;
        for (const [name, label] of [['summary', _('Summary')], ['args', _('Arguments')], ['result', _('Result')], ['raw', _('Raw')]]) {
            const button = new Gtk.ToggleButton({ label, active: !first });
            if (first) button.set_group(first); else first = button;
            button.connect('toggled', () => { if (button.active) this.pages.set_visible_child_name(name); });
            this.tabs.set(name, button);
            row.append(button);
        }
        return row;
    }

    private buildActions(): Gtk.Widget {
        const row = new Gtk.Box({ spacing: 8 });
        const copyAll = new Gtk.Button({ label: _('Copy event') });
        copyAll.connect('clicked', () => { if (this.event) this.copy(AgentTrace.format(this.event)); });
        this.copyArgs.connect('clicked', () => this.copy(this.event?.args ?? ''));
        this.copyResult.connect('clicked', () => this.copy(this.event?.result ?? ''));
        for (const b of [this.copyArgs, this.copyResult, copyAll]) row.append(b);
        return row;
    }

    private copy(text: string): void {
        this.widget.get_clipboard().set(text);
    }

    // Select what to show; null = nothing. Cheap to call on every refresh: labels are only touched when their text changed.
    show(event: TraceEvent | null, nodes: TraceNode[]): void {
        const changed = event?.seq !== this.event?.seq;
        this.event = event;
        this.widget.set_visible_child_name(event ? 'event' : 'empty');
        if (!event) return;
        this.header(event);
        this.metrics(METRICS[event.kind]?.(event, nodes) ?? otherMetrics(event));
        this.content(event);
        if (changed) this.tabs.get('summary')!.set_active(true);
    }

    private header(e: TraceEvent): void {
        const kinds: Record<string, string> = { turn: _('Question'), round: _('Model round'), reasoning: _('Reasoning'), text: _('Answer'), tool: _('Tool call'), usage: _('Usage'), note: _('Note'), error: _('Error') };
        const name = e.kind === 'tool' ? e.title.replace(/^Tool: /, '') : e.kind === 'turn' ? e.title.replace(/^New turn: /, '') : TITLED.has(e.kind) ? kinds[e.kind] : e.title;
        set(this.title, name);
        set(this.subtitle, `${kinds[e.kind]}${e.round !== undefined && e.kind !== 'round' ? ` · ${fmt(_('round {n}'), { n: e.round })}` : ''} · ${e.time.slice(11)}`);
        const state = e.status === 'running' ? _('Running…') : e.status === 'failed' ? _('Failed') : e.status === 'ok' ? _('Done') : '';
        set(this.chip, state);
        this.chip.set_visible(!!state);
        for (const c of ['success', 'error', 'accent']) this.chip.remove_css_class(c);
        this.chip.add_css_class(e.status === 'failed' ? 'error' : e.status === 'running' ? 'accent' : 'success');
    }

    private metrics(values: Metric[]): void {
        this.cards.forEach((card, i) => {
            card.box.set_visible(i < values.length);
            if (!values[i]) return;
            set(card.value, values[i][0]);
            set(card.caption, values[i][1]);
        });
    }

    private content(e: TraceEvent): void {
        const tool = e.kind === 'tool';
        const show = (b: Block, text: string): void => { b.box.set_visible(!!text); set(b.label, text); };
        show(this.blocks.context, (e.items ?? []).map(i => `• ${i}`).join('\n'));
        show(this.blocks.args, tool ? preview(e.args ?? '', 20) : '');
        show(this.blocks.result, tool ? preview(e.result ?? '', 12) : '');
        show(this.blocks.detail, e.detail);
        set(this.argsPage, e.args || _('(no arguments)'));
        set(this.resultPage, e.result || (e.status === 'running' ? _('Waiting for the result…') : _('(empty)')));
        set(this.rawPage, AgentTrace.format(e));
        for (const name of ['args', 'result']) this.tabs.get(name)!.set_visible(tool);
        this.copyArgs.set_visible(tool);
        this.copyResult.set_visible(tool);
        if (!tool && ['args', 'result'].includes(this.pages.get_visible_child_name() ?? '')) this.tabs.get('summary')!.set_active(true);
    }
}

function set(label: Gtk.Label, text: string): void {
    if (label.get_text() !== text) label.set_text(text);
}
