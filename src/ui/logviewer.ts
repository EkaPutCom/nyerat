// Jendela pemantau kegiatan agent: lini masa tiap giliran (putaran model, penalaran, alat yang dipanggil beserta
// argumen dan hasilnya, usulan, token). Memperbarui diri selama agent bekerja; hanya membaca AgentTrace.

import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import { AgentTrace, type TraceEvent, type TraceKind } from '../agent/trace.js';
import { onKeyPress, pack } from '../gtkutil.js';

const KIND_ICON: Record<TraceKind, string> = { turn: '▶', round: '◆', reasoning: '💭', text: '✎', tool: '🔧', usage: '∑', note: '■', error: '⚠' };
const KIND_FILTER: [string, TraceKind[]][] = [['Semua', []], ['Alat', ['tool']], ['Penalaran', ['reasoning']], ['Model', ['round', 'text']]];

interface Row {
    box: Gtk.Box;
    title: Gtk.Label;
    detail: Gtk.Label;
    event: TraceEvent;
}

export class LogViewer {
    readonly window: Gtk.Window;
    readonly list: Gtk.Box;
    private readonly scroller: Gtk.ScrolledWindow;
    private readonly summary: Gtk.Label;
    private readonly rows = new Map<number, Row>();
    private filter: TraceKind[] = [];
    private timer = 0;
    private stick = true;
    private stickIdle = 0;

    constructor(parent: Gtk.Window | null, private readonly trace: AgentTrace, title = 'Log agent') {
        this.window = new Gtk.Window({ transient_for: parent, default_width: 760, default_height: 640, title });
        const header = new Gtk.HeaderBar({ show_title_buttons: true });
        this.window.set_titlebar(header);

        const copy = new Gtk.Button({ label: 'Salin semua', tooltip_text: 'Salin seluruh log sebagai teks' });
        copy.connect('clicked', () => this.window.get_clipboard().set(this.trace.text()));
        const clear = new Gtk.Button({ label: 'Bersihkan', tooltip_text: 'Kosongkan tampilan log (percakapan tidak terpengaruh)' });
        clear.connect('clicked', () => this.trace.clear());
        header.pack_start(copy);
        header.pack_start(clear);

        const filters = new Gtk.Box({ spacing: 4, margin_start: 10, margin_end: 10, margin_top: 8, margin_bottom: 4 });
        let first: Gtk.ToggleButton | null = null;
        for (const [label, kinds] of KIND_FILTER) {
            const button = new Gtk.ToggleButton({ label, active: !first });
            if (first) button.set_group(first); else first = button;
            button.connect('toggled', () => { if (button.active) { this.filter = kinds; this.applyFilter(); } });
            filters.append(button);
        }
        this.summary = new Gtk.Label({ xalign: 1, hexpand: true });
        this.summary.add_css_class('dim-label');
        filters.append(this.summary);

        this.list = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, margin_start: 10, margin_end: 10, margin_bottom: 10 });
        this.scroller = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true });
        this.scroller.set_child(this.list);
        const vadj = this.scroller.get_vadjustment();
        // Sama seperti panel Asisten: menggulir di dalam "changed" tidak diterapkan viewport, jadi ditunda ke idle.
        vadj.connect('changed', () => {
            if (!this.stick || this.stickIdle) return;
            this.stickIdle = GLib.idle_add(GLib.PRIORITY_HIGH_IDLE, () => {
                this.stickIdle = 0;
                if (this.stick) vadj.set_value(vadj.get_upper() - vadj.get_page_size());
                return GLib.SOURCE_REMOVE;
            });
        });
        vadj.connect('value-changed', () => { this.stick = vadj.get_upper() - vadj.get_page_size() - vadj.get_value() < 24; });

        const body = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        body.append(filters);
        body.append(new Gtk.Separator());
        pack(body, this.scroller, true);
        this.window.set_child(body);

        this.trace.onChange = () => this.queueRefresh();
        this.window.connect('unrealize', () => this.dispose());
        onKeyPress(this.window, keyval => {
            if (keyval !== Gdk.KEY_Escape) return false;
            this.window.destroy();
            return true;
        });
        this.refresh();
    }

    private dispose(): void {
        if (this.timer) GLib.source_remove(this.timer);
        if (this.stickIdle) GLib.source_remove(this.stickIdle);
        this.timer = this.stickIdle = 0;
        this.trace.onChange = () => {};
    }

    show(): void {
        this.stick = true;
        this.window.present();
    }

    // Penalaran mengalir puluhan kali per detik; tampilan cukup diperbarui beberapa kali.
    private queueRefresh(): void {
        if (this.timer) return;
        this.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => { this.timer = 0; this.refresh(); return GLib.SOURCE_REMOVE; });
    }

    private static titleText(e: TraceEvent): string {
        const state = e.status === 'running' ? ' …' : e.status === 'failed' ? ' — gagal' : '';
        return `${KIND_ICON[e.kind]}  ${e.time.slice(11)}  ${e.title}${e.ms !== undefined ? `  (${e.ms < 1000 ? `${e.ms} ms` : `${(e.ms / 1000).toFixed(1)} dtk`})` : ''}${state}`;
    }

    private refresh(): void {
        const events = this.trace.events;
        // Kejadian terpangkas atau log dikosongkan: bangun ulang dari awal.
        const first = events[0]?.seq;
        for (const [seq, row] of [...this.rows]) {
            if (first === undefined || seq < first || this.rows.size > events.length) {
                this.list.remove(row.box);
                this.rows.delete(seq);
            }
        }
        for (const event of events) {
            let row = this.rows.get(event.seq);
            if (!row) {
                const title = new Gtk.Label({ xalign: 0, wrap: true, wrap_mode: 2, selectable: true });
                const detail = new Gtk.Label({ xalign: 0, wrap: true, wrap_mode: 2, selectable: true, margin_start: 22, margin_top: 2, margin_bottom: 4 });
                detail.add_css_class('chat-diff');
                const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
                if (event.kind === 'turn') box.set_margin_top(10);
                const content = event.detail ? new Gtk.Expander({ expanded: event.kind === 'turn' || event.kind === 'error' }) : null;
                if (content) { content.set_label_widget(title); content.set_child(detail); box.append(content); }
                else box.append(title);
                this.list.append(box);
                row = { box, title, detail, event };
                this.rows.set(event.seq, row);
            }
            row.event = event;
            row.title.set_text(LogViewer.titleText(event));
            if (event.status === 'failed') row.title.add_css_class('chat-error'); else row.title.remove_css_class('chat-error');
            if (row.detail.get_text() !== event.detail) row.detail.set_text(event.detail);
        }
        this.applyFilter();
        const tools = events.filter(e => e.kind === 'tool').length;
        const rounds = events.filter(e => e.kind === 'round').length;
        this.summary.set_text(events.length ? `${rounds} putaran model · ${tools} panggilan alat` : 'Belum ada kegiatan. Kirim pertanyaan ke Asisten.');
    }

    private applyFilter(): void {
        for (const row of this.rows.values()) row.box.set_visible(!this.filter.length || this.filter.includes(row.event.kind) || row.event.kind === 'turn');
    }
}
