// Jendela tinjau untuk satu usulan perubahan agent: selisihnya ditampilkan seperti diff riwayat Git, dengan
// tombol Tolak dan Terapkan di bawah. Menutup jendela tanpa memilih sama dengan menolak. Keputusan dikembalikan
// lewat `onDecision` tepat satu kali; penerapan ke berkas dilakukan pemanggil.

import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import { describeChange, unifiedDiff, type Change } from '../agent/changes.js';
import { parseDiff } from '../gitlog.js';
import { createDiffView, fillDiff, setupDiffTags } from './historyviewer.js';
import { onKeyPress, pack } from '../gtkutil.js';

export class ProposalViewer {
    readonly window: Gtk.Window;
    readonly diffView: Gtk.TextView;
    readonly applyButton: Gtk.Button;
    readonly rejectButton: Gtk.Button;
    private readonly status: Gtk.Label;
    private decided = false;
    // Dipanggil sekali. applied=false tanpa error = ditolak (termasuk jendela ditutup).
    onDecision: (applied: boolean) => void = () => {};

    constructor(parent: Gtk.Window | null, readonly change: Change | Change[], dark: boolean, private apply: (change: Change | Change[]) => string | null, readOnly = false) {
        this.window = new Gtk.Window({ transient_for: parent, default_width: 860, default_height: 620 });
        const changes = Array.isArray(change) ? change : [change];
        const title = changes.length > 1 ? `Paket: ${changes.length} berkas` : describeChange(changes[0]);
        const header = new Gtk.HeaderBar({ show_title_buttons: true });
        this.window.set_titlebar(header);
        this.window.set_title(`Usulan agent: ${title}`);

        const subject = new Gtk.Label({ xalign: 0, wrap: true });
        subject.set_markup(`<b>${GLib.markup_escape_text(title, -1)}</b>`);
        const info = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, margin_top: 12, margin_start: 12, margin_end: 12, margin_bottom: 8 });
        info.append(subject);
        const reason = changes.map(c => `${changes.length > 1 ? c.file + ': ' : ''}${c.reason.trim()}`).join('\n');
        const meta = new Gtk.Label({ label: reason || 'Agent tidak memberi alasan.', xalign: 0, wrap: true });
        meta.add_css_class('dim-label');
        info.append(meta);

        this.diffView = createDiffView();
        setupDiffTags(this.diffView, dark);
        fillDiff(this.diffView, changes.flatMap(c => [...(Array.isArray(change) ? [{ kind: 'hunk' as const, text: `Berkas: ${c.file}` }] : []), ...parseDiff(unifiedDiff(c.before, c.after))]));
        const scroll = new Gtk.ScrolledWindow();
        scroll.set_child(this.diffView);

        this.status = new Gtk.Label({ xalign: 0, wrap: true, hexpand: true, visible: false });
        this.status.add_css_class('chat-error');
        this.rejectButton = new Gtk.Button({ label: 'Tolak' });
        this.applyButton = new Gtk.Button({ label: 'Terapkan' });
        this.applyButton.add_css_class('suggested-action');
        if (readOnly) { this.applyButton.hide(); this.rejectButton.set_label('Tutup'); }
        const bar = new Gtk.Box({ spacing: 8, margin_top: 10, margin_bottom: 10, margin_start: 10, margin_end: 10 });
        pack(bar, this.status, true);
        bar.append(this.rejectButton);
        bar.append(this.applyButton);

        const body = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        body.append(info);
        body.append(new Gtk.Separator());
        pack(body, scroll, true);
        body.append(new Gtk.Separator());
        body.append(bar);
        this.window.set_child(body);

        this.applyButton.connect('clicked', () => {
            if (readOnly) return;
            const error = this.apply(change);
            if (error) {
                // Tetap terbuka supaya pengguna membaca sebabnya; Tolak/tutup menyelesaikan giliran.
                this.status.set_text(`Gagal diterapkan: ${error}`);
                this.status.show();
                this.applyButton.set_sensitive(false);
                this.finish(false, error);
            } else {
                this.finish(true);
                this.window.destroy();
            }
        });
        this.rejectButton.connect('clicked', () => { this.finish(false); this.window.destroy(); });
        // GTK 4 tidak memancarkan "destroy" selama objeknya dipegang JavaScript; "unrealize" menandai jendela tertutup.
        this.window.connect('unrealize', () => this.finish(false));
        onKeyPress(this.window, keyval => {
            if (keyval !== Gdk.KEY_Escape) return false;
            this.finish(false);
            this.window.destroy();
            return true;
        });
    }

    error = '';

    private finish(applied: boolean, error = ''): void {
        if (this.decided) return;
        this.decided = true;
        this.error = error;
        this.onDecision(applied);
    }

    setDark(dark: boolean): void {
        setupDiffTags(this.diffView, dark);
    }

    show(): void {
        this.window.present();
    }

    close(): void {
        this.finish(false);
        this.window.destroy();
    }
}
