// The agent's work plan (the set_work tool) as a checklist in the Assistant panel:
//
//   ▾ Sync the release schedule · 1/2 · 52 s
//     ✔ Read the meeting decision
//     ◌ Check the plan and task cards      (spinner while the agent is working)
//     ⚠ A blocked step
//     Agent note
//
// Rebuilt every time the plan changes; its contents come only from WorkState, so it is the same for a running turn
// and for a conversation that is opened again.

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import type { WorkState, WorkStep } from '../agent/work.js';
import { childrenOf } from '../gtkutil.js';
import { _, fmt } from '../i18n.js';

const STATUS_TEXT: Record<WorkState['status'], string> = {
    running: _('running'),
    paused: _('paused'),
    failed: _('failed'),
    complete: _('finished and verified'),
};

export function durationText(seconds: number): string {
    const s = Math.max(0, Math.round(seconds));
    return s < 60 ? fmt(_('{s} s'), { s }) : fmt(_('{m} min {s} s'), { m: Math.floor(s / 60), s: s % 60 });
}

export class WorkList {
    readonly widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
    private readonly expander = new Gtk.Expander({ expanded: true });
    private readonly title = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 40, hexpand: true });
    private readonly meta = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 40 });
    private readonly steps = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, margin_top: 4, accessible_role: Gtk.AccessibleRole.LIST });
    private readonly note = new Gtk.Label({ xalign: 0, wrap: true, max_width_chars: 40, selectable: true, visible: false });

    constructor() {
        this.widget.add_css_class('chat-work');
        this.title.add_css_class('chat-work-goal');
        this.meta.add_css_class('side-meta');
        this.note.add_css_class('side-meta');
        const header = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        header.append(this.title);
        header.append(this.meta);
        this.expander.set_label_widget(header);
        const body = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
        body.append(this.steps);
        body.append(this.note);
        this.expander.set_child(body);
        this.widget.append(this.expander);
    }

    // running = the agent is working on this turn: the first pending step gets a spinner.
    // seconds = how long the turn has been running, if known.
    update(work: WorkState, running: boolean, seconds?: number): void {
        const done = work.steps.filter(s => s.status === 'done').length;
        this.title.set_text(work.goal);
        const parts = [fmt(_('{done}/{total} steps'), { done, total: work.steps.length }), running ? _('working') : STATUS_TEXT[work.status]];
        if (seconds !== undefined) parts.push(durationText(seconds));
        if (work.verification && !work.verification.passed) parts.push(_('verification failed'));
        this.meta.set_text(parts.join(' · '));

        for (const child of childrenOf(this.steps)) this.steps.remove(child);
        const current = running && work.status === 'running' ? work.steps.findIndex(s => s.status === 'pending') : -1;
        work.steps.forEach((step, i) => this.steps.append(stepRow(step, i === current)));
        this.note.set_text(work.note.trim());
        this.note.set_visible(!!work.note.trim());
    }

    // The text of the whole list, for tests and screen readers.
    text(): string {
        return [this.title.get_text(), this.meta.get_text(), ...childrenOf(this.steps).map(r => stepTexts.get(r) ?? ''), this.note.get_text()].filter(Boolean).join('\n');
    }
}

const stepTexts = new WeakMap<Gtk.Widget, string>();

// Adw.Spinner (libadwaita 1.6+, GNOME 50 runtime); Gtk.Spinner for older system libadwaita.
function spinner(): Gtk.Widget {
    const AdwSpinner = (Adw as any).Spinner as (new () => Gtk.Widget) | undefined;
    return AdwSpinner ? new AdwSpinner() : new Gtk.Spinner({ spinning: true });
}

function stepRow(step: WorkStep, current: boolean): Gtk.Widget {
    const row = new Gtk.Box({ spacing: 8, accessible_role: Gtk.AccessibleRole.LIST_ITEM });
    row.add_css_class('chat-work-step');
    let mark: Gtk.Widget;
    if (current) {
        mark = spinner();
    } else if (step.status === 'done') {
        mark = new Gtk.Image({ icon_name: 'object-select-symbolic', pixel_size: 10 });
        mark.add_css_class('work-done');
    } else if (step.status === 'blocked') {
        mark = new Gtk.Image({ icon_name: 'dialog-warning-symbolic', pixel_size: 14 });
        mark.add_css_class('work-blocked');
    } else {
        mark = new Gtk.Box();
        mark.add_css_class('work-pending');
    }
    mark.set_valign(Gtk.Align.START);
    mark.set_size_request(16, 16);
    const label = new Gtk.Label({ label: step.text, xalign: 0, wrap: true, max_width_chars: 38, selectable: true, hexpand: true });
    if (step.status === 'done') label.add_css_class('work-step-done');
    const state = { pending: current ? _('in progress') : _('not yet'), done: _('done'), blocked: _('blocked') }[step.status];
    // The status is read out by screen readers, not only visible from the icon and color.
    const text = `${step.text} — ${state}`;
    stepTexts.set(row, text);
    row.update_property([Gtk.AccessibleProperty.LABEL], [text]);
    row.append(mark);
    row.append(label);
    return row;
}
