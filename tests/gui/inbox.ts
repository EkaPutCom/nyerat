// Tes GUI: Inbox.

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { parseInbox, isInbox } from '../../src/markdown/inbox.js';
import { descendants, widgetPixbuf } from '../widgets.js';
import { section, test, eq, ok, tmp, optVal } from '../framework.js';
import { BOARD, INBOX } from '../fixtures.js';
import type { GuiContext } from './context.js';

export function inboxTests(c: GuiContext): void {
    const { w, pump, text } = c;

    section('Inbox (tampilan)');
    const berkas = GLib.build_filenamev([tmp, 'inbox.md']);
    const settle = () => { for (let i = 0; i < 25; i++) { pump(); GLib.usleep(8000); } };
    const open = (content = INBOX) => { GLib.file_set_contents(berkas, content); w.load(berkas); settle(); };
    const labels = () => descendants(w.inbox.widget).filter((x): x is Gtk.Label => x instanceof Gtk.Label).map(l => l.get_label());
    const rows = () => descendants(w.inbox.widget).filter((x): x is Gtk.ListBoxRow => x instanceof Gtk.ListBoxRow);
    const removeButton = (row: number) => descendants(rows()[row]).find((x): x is Gtk.Button => x instanceof Gtk.Button)!;
    const entry = () => descendants(w.inbox.widget).find(x => x.get_name() === 'inbox-entry') as Gtk.Entry;
    // Waktu tetap supaya label usia tidak bergantung pada jam tes.
    w.inbox.now = () => new Date(2026, 9, 7, 14, 32);

    test('dokumen inbox dibuka sebagai inbox, bukan papan atau teks', () => {
        open();
        ok(w.inboxMode && !w.boardMode, 'inbox tidak tampil');
        eq(rows().length, 3, 'jumlah baris');
        ok(labels().includes('Inbox') && labels().includes('Tempat menangkap ide.'), `judul: ${labels().join('|')}`);
        ok(w.statusBar.right.label.includes('3 catatan'), `status: ${w.statusBar.right.label}`);
        eq(text(), INBOX, 'teks dokumen tidak berubah karena dibuka');
        GLib.file_set_contents(berkas, BOARD);
        w.load(berkas); settle();
        ok(w.boardMode && !w.inboxMode, 'papan kanban terganggu');
        GLib.file_set_contents(berkas, '# Biasa\n\n- a');
        w.load(berkas); settle();
        ok(!w.boardMode && !w.inboxMode, 'dokumen biasa tampil sebagai inbox');
    });
    test('baris menampilkan judul tanpa tag, usia, dan tag', () => {
        open();
        const all = labels();
        ok(all.includes('10 menit lalu · ada catatan'), `usia: ${all.join('|')}`);
        ok(all.includes('1 jam lalu'), 'jam');
        ok(all.includes('#idea') && all.includes('#read'), 'tag');
        ok(!all.some(l => l.includes('➕')), 'waktu tangkap tidak tampil mentah');
    });
    test('tangkap cepat menyisipkan item di atas dan menulis teks dokumen', () => {
        open();
        entry().set_text('Link menarik #read');
        entry().emit('activate');
        settle();
        eq(rows().length, 4, 'baris');
        const items = parseInbox(text()).items;
        ok(/^Link menarik #read ➕ \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(items[0].text), items[0].text);
        eq(entry().text, '', 'isian dikosongkan');
        ok(w.statusBar.right.label.includes('4 catatan'), 'status diperbarui');
        entry().set_text('   ');
        entry().emit('activate');
        settle();
        eq(rows().length, 4, 'teks kosong ditolak');
        eq(entry().text, '', 'spasi saja dikosongkan');
    });
    test('tombol hapus membuang item; undo mengembalikannya', () => {
        open();
        removeButton(1).emit('clicked');
        settle();
        eq(rows().length, 2, 'baris setelah hapus');
        ok(!text().includes('Baca artikel'), 'item masih ada di teks');
        c.action('undo');
        settle();
        eq(rows().length, 3, 'baris setelah undo');
        eq(text(), INBOX, 'teks kembali');
    });
    test('catatan baru dan sunting lewat dialog; waktu tangkap dipertahankan', () => {
        open();
        const calls: string[] = [];
        w.inbox.dialogs = { editNote: (_p, item, title) => { calls.push(title ?? 'sunting'); return { text: item.text ? `${item.text} #baru` : 'Dari dialog #d', notes: ['isi'] }; } };
        w.inbox.showAddNote();
        settle();
        eq(calls, ['Catatan Baru']);
        const items = parseInbox(text()).items;
        ok(items[0].text.startsWith('Dari dialog #d ➕ '), items[0].text);
        eq(items[0].notes, ['isi']);
        rows()[1].emit('activate');
        settle();
        eq(calls[1], 'sunting');
        eq(parseInbox(text()).items[1].text, 'Ide SQLite #idea ➕ 2026-10-07 14:22 #baru');
        w.inbox.dialogs = { editNote: () => null };
        const before = text();
        w.inbox.editItem(0);
        settle();
        eq(text(), before, 'batal tidak mengubah apa pun');
    });
    test('tampilan teks dan kembali ke inbox; Inbox Baru membuat dokumen inbox', () => {
        open();
        w.toggleBoardView(false);
        ok(!w.inboxMode, 'masih inbox');
        w.toggleBoardView(true);
        ok(w.inboxMode, 'tidak kembali ke inbox');
        w.newInboxDocument();
        settle();
        ok(w.inboxMode && isInbox(text()), 'dokumen baru bukan inbox');
        eq(rows().length, 0, 'inbox baru kosong');
        ok(descendants(w.inbox.widget).some(x => x instanceof Gtk.Label && x.get_label() === 'Inbox kosong'), 'keadaan kosong tidak tampil');
        while (w.editor !== c.ed) ok(w.closeTab(), 'closeTab() gagal');
    });
    test('tangkapan layar inbox', () => {
        // --shot-inbox=<prefix>: simpan <prefix>-terang.png dan <prefix>-gelap.png.
        const shot = optVal('shot-inbox');
        if (!shot) return;
        open(INBOX.replace('Tempat menangkap ide.', 'Tempat menangkap ide, catatan, dan hal yang perlu diproses nanti.'));
        w.win.set_focus(null);
        for (const dark of [false, true]) {
            w.setOption('dark', dark);
            for (let i = 0; i < 30; i++) { pump(); GLib.usleep(15000); }
            widgetPixbuf(w.win)?.savev(`${shot}-${dark ? 'gelap' : 'terang'}.png`, 'png', [], []);
        }
        w.setOption('dark', false);
    });
}
