// Tes GUI: Kanban (papan).

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { readTextFile } from '../../src/files.js';
import { addCard, isKanban, parseBoard } from '../../src/markdown/kanban.js';
import { KanbanBoard } from '../../src/ui/kanban.js';
import { dueField, editCardDialog, findDialog } from '../../src/ui/dialogs.js';
import { findEntry, type MenuEntry } from '../../src/ui/menu.js';
import { childrenOf } from '../../src/gtkutil.js';
import { descendants, widgetPixbuf } from '../widgets.js';
import { section, test, eq, ok, tmp, optVal } from '../framework.js';
import { BOARD } from '../fixtures.js';
import type { GuiContext } from './context.js';

export function kanbanBoardTests(c: GuiContext): void {
    const { w, ed, buf, pump, text, setText, action } = c;

    section('Kanban (papan)');
    const papan = GLib.build_filenamev([tmp, 'papan.md']);
    GLib.file_set_contents(papan, BOARD);
    const kb = w.board;
    const settleK = () => { for (let i = 0; i < 25; i++) { pump(); GLib.usleep(8000); } };
    const kbDescendants = descendants;
    const kbEntry = (name: string) => kbDescendants(kb.widget).find(c => c.get_name() === name) as Gtk.Entry | undefined;
    const kbCheck = (col: number, idx: number) => kbDescendants(kb.columns[col].cards[idx]).find(c => c instanceof Gtk.CheckButton) as Gtk.CheckButton;
    const kbMenu = (menu: MenuEntry[], label: string) => {
        const item = findEntry(menu, label);
        if (!item) throw new Error(`item menu "${label}" tidak ada`);
        return { item, enabled: item.enabled !== false, activate: () => item.run!() };
    };
    const kbTitles = () => kb.getBoard().columns.map(c => c.title);
    // Titik di kartu `target` (offset dx, dy) dinyatakan dalam koordinat kartu `from`.
    const inCard = (from: Gtk.Widget, target: Gtk.Widget, dx: number, dy: number) => {
        const [, x, y] = target.translate_coordinates(from, dx, dy);
        return [x, y] as const;
    };
    const stubDialogs = (over: Partial<KanbanBoard['dialogs']> = {}) => {
        const calls: string[] = [];
        kb.dialogs = {
            editCard: () => { calls.push('sunting'); return null; },
            prompt: () => { calls.push('prompt'); return null; },
            confirm: () => { calls.push('konfirmasi'); return true; },
            ...over,
        };
        return calls;
    };
    const openBoard = () => { GLib.file_set_contents(papan, BOARD); w.load(papan); settleK(); };

    test('dokumen kanban dibuka sebagai papan, dokumen biasa sebagai teks', () => {
        openBoard();
        ok(w.boardMode, 'papan tidak tampil');
        eq(kbTitles(), ['Rencana', 'Dikerjakan', 'Selesai']);
        eq(kb.columns.map(c => c.cards.length), [2, 1, 2], 'jumlah kartu');
        ok(w.statusBar.right.label.includes('3 daftar · 5 kartu'), `status: ${w.statusBar.right.label}`);
        eq(text(), BOARD, 'teks dokumen tidak berubah karena dibuka');
        GLib.file_set_contents(papan, '# Biasa\n\nteks');
        w.load(papan); settleK();
        ok(!w.boardMode, 'dokumen biasa tampil sebagai papan');
        openBoard();
    });
    test('menambah kartu lewat dialog menulis ke teks dokumen', () => {
        openBoard();
        const titles: (string | undefined)[] = [];
        stubDialogs({ editCard: (_p, _c, title) => { titles.push(title); return { text: 'Kartu uji #baru', notes: ['catatan'] }; } });
        kb.showAddCard(1); settleK();
        eq(titles, ['Tambah Kartu'], 'judul dialog');
        eq(kb.cardTexts(1), ['Desain logo', 'Kartu uji #baru'], 'model');
        ok(text().includes('- [ ] Desain logo\n- [ ] Kartu uji #baru\n  catatan\n'), 'teks dokumen');
        ok(buf.get_modified(), 'dokumen belum ditandai berubah');
        stubDialogs({ editCard: () => ({ text: '', notes: [] }) });
        kb.showAddCard(1); settleK();
        eq(kb.cardTexts(1).length, 2, 'kartu kosong ditolak');
        stubDialogs({ editCard: () => null });
        kb.showAddCard(1); settleK();
        eq(kb.cardTexts(1).length, 2, 'dibatalkan');
    });
    test('menambah daftar lewat isian', () => {
        openBoard();
        kb.showAddList(); settleK();
        const entry = kbEntry('kanban-entry-list')!;
        ok(entry.get_child_visible() && entry.get_mapped(), 'isian tampil setelah klik Tambah daftar');
        entry.set_text('Review'); entry.emit('activate'); settleK();
        eq(kbTitles(), ['Rencana', 'Dikerjakan', 'Selesai', 'Review']);
        ok(text().includes('## Review'), 'teks dokumen');
        kb.hideAdd();
    });
    test('kotak centang menandai kartu selesai', () => {
        openBoard();
        kbCheck(0, 1).set_active(true); settleK();
        eq(kb.getBoard().columns[0].cards[1].done, true, 'model');
        ok(text().includes('- [x] Kirim undangan'), 'teks dokumen');
        ok(kb.columns[0].cards[1].has_css_class('kanban-card-done'), 'gaya kartu selesai');
    });
    test('menu kartu: hapus, pindah ke daftar lain, naik/turun, tandai selesai', () => {
        openBoard();
        const menu = kb.cardMenu(0, 0);
        ok(!kbMenu(menu, 'Naik').enabled && kbMenu(menu, 'Turun').enabled, 'Naik/Turun di kartu pertama');
        kbMenu(menu, 'Turun').activate(); settleK();
        eq(kb.cardTexts(0), ['Kirim undangan', 'Tulis laporan #penting @{2026-10-20}'], 'turun');
        const submenu = kbMenu(kb.cardMenu(0, 0), 'Pindahkan ke').item.submenu!;
        eq(submenu.map(e => e.label), ['Dikerjakan', 'Selesai'], 'tujuan tidak memuat daftar asal');
        submenu.find(e => e.label === 'Selesai')!.run!(); settleK();
        eq([kb.cardTexts(0).length, kb.cardTexts(2).at(-1)], [1, 'Kirim undangan'], 'pindah ke akhir daftar tujuan');
        kbMenu(kb.cardMenu(2, 2), 'Tandai Selesai').activate(); settleK();
        eq(kb.getBoard().columns[2].cards[2].done, true, 'tandai selesai');
        kbMenu(kb.cardMenu(2, 2), 'Hapus').activate(); settleK();
        eq(kb.cardTexts(2).length, 2, 'hapus');
    });
    test('menu daftar: ganti nama, geser, hapus dengan konfirmasi', () => {
        openBoard();
        const calls = stubDialogs({ prompt: () => 'Backlog' });
        kbMenu(kb.columnMenu(0), 'Ganti Nama…').activate(); settleK();
        eq(kbTitles()[0], 'Backlog', 'ganti nama');
        ok(!kbMenu(kb.columnMenu(0), 'Geser ke Kiri').enabled, 'daftar pertama tidak bisa ke kiri');
        kbMenu(kb.columnMenu(0), 'Geser ke Kanan').activate(); settleK();
        eq(kbTitles(), ['Dikerjakan', 'Backlog', 'Selesai'], 'geser');
        stubDialogs({ confirm: () => false });
        kbMenu(kb.columnMenu(1), 'Hapus Daftar…').activate(); settleK();
        eq(kbTitles().length, 3, 'tidak jadi dihapus');
        stubDialogs({ confirm: () => true });
        kbMenu(kb.columnMenu(1), 'Hapus Daftar…').activate(); settleK();
        eq(kbTitles(), ['Dikerjakan', 'Selesai'], 'dihapus');
        void calls;
    });
    test('sunting kartu lewat dialog: judul dan catatan', () => {
        openBoard();
        stubDialogs({ editCard: () => ({ text: 'Judul baru #x', notes: ['baris 1', 'baris 2'] }) });
        kb.editCard(0, 1); settleK();
        eq(kb.getBoard().columns[0].cards[1], { done: false, text: 'Judul baru #x', notes: ['baris 1', 'baris 2'] });
        ok(text().includes('- [ ] Judul baru #x\n  baris 1\n  baris 2\n'), 'teks dokumen');
        stubDialogs({ editCard: () => ({ text: '', notes: [] }) });
        kb.editCard(0, 1); settleK();
        eq(kb.cardTexts(0)[1], 'Judul baru #x', 'judul kosong tidak menimpa');
    });
    test('klik kartu tanpa bergeser membuka sunting; gerak kecil tetap dianggap klik', () => {
        openBoard();
        const calls = stubDialogs();
        const card = kb.columns[0].cards[0];
        kb.onCardPress(0, 0, card, 10, 10);
        kb.onCardMotion(12, 11);
        ok(!kb.dragging, 'gerak 3 piksel dianggap menyeret');
        kb.onCardRelease();
        eq(calls, ['sunting']);
    });
    test('menyeret kartu ke daftar lain menjatuhkannya di posisi yang ditunjuk', () => {
        openBoard();
        const calls = stubDialogs();
        const moved = kb.cardTexts(0)[0];
        const source = kb.columns[0].cards[0], target = kb.columns[2].cards[0];
        kb.onCardPress(0, 0, source, 10, 10);
        const top = inCard(source, target, 10, 4);   // di paruh atas kartu pertama daftar tujuan
        kb.onCardMotion(top[0], top[1]);
        ok(kb.dragging, 'tidak mulai menyeret');
        eq(childrenOf(kb.columns[2].cardsBox).length, 3, 'penanda tujuan muncul di daftar tujuan');
        const ghost = kb['drag']!.ghost;
        ok(ghost.get_parent(), 'kartu bayangan');
        kb.onCardRelease(); settleK();
        ok(!kb.dragging, 'masih menyeret setelah dilepas');
        ok(!ghost.get_parent(), 'kartu bayangan tidak dibersihkan');
        eq([kb.cardTexts(2)[0], kb.cardTexts(0).length, kb.cardTexts(2).length], [moved, 1, 3], 'kartu pindah ke atas daftar tujuan');
        ok(text().includes(`## Selesai\n\n- [ ] ${moved}\n`), 'teks dokumen');
        eq(calls, [], 'seret tidak membuka dialog sunting');
    });
    test('menyeret di paruh bawah kartu menjatuhkan setelahnya; di daftar yang sama mengurutkan ulang', () => {
        openBoard();
        const source = kb.columns[0].cards[0], second = kb.columns[0].cards[1];
        const first = kb.cardTexts(0)[0];
        kb.onCardPress(0, 0, source, 10, 10);
        const low = inCard(source, second, 10, second.get_allocated_height() - 3);
        kb.onCardMotion(low[0], low[1]);
        kb.onCardRelease(); settleK();
        eq(kb.cardTexts(0)[1], first, 'kartu pertama turun ke bawah kartu kedua');
    });
    test('menjatuhkan di tempat asal tidak mengubah apa pun', () => {
        openBoard();
        buf.set_modified(false);
        const source = kb.columns[1].cards[0];
        kb.onCardPress(1, 0, source, 10, 10);
        const same = inCard(source, source, 10, 4);
        kb.onCardMotion(same[0] + 200, same[1]);   // 200 px ke kanan → menyeret
        kb.onCardMotion(same[0], same[1]);         // lalu kembali ke tempat asal
        kb.onCardRelease(); settleK();
        eq(text(), BOARD, 'teks');
        ok(!buf.get_modified(), 'dokumen ditandai berubah');
    });
    test('menyeret ke ruang kosong di bawah daftar menjatuhkan di akhir daftar itu', () => {
        openBoard();
        const source = kb.columns[0].cards[0], last = kb.columns[1].cards[0];
        const moved = kb.cardTexts(0)[0];
        kb.onCardPress(0, 0, source, 10, 10);
        const below = inCard(source, last, 10, 400);
        kb.onCardMotion(below[0], below[1]);
        kb.onCardRelease(); settleK();
        eq(kb.cardTexts(1).at(-1), moved);
    });
    test('menyeret dekat tepi kanan menggulir papan', () => {
        openBoard();
        kb.showAddList(); kb.hideAdd(); settleK();
        const hadj = kb.scroller.get_hadjustment();
        if (hadj.get_upper() - hadj.get_page_size() < 50) { w.win.set_default_size(700, 600); settleK(); }
        hadj.set_value(0);
        const source = kb.columns[0].cards[0];
        kb.onCardPress(0, 0, source, 10, 10);
        kb.onCardMotion(20, 20);
        const drag = kb['drag']!;
        const edgeX = hadj.get_value() + kb.scroller.get_allocated_width() - 10;   // 10 px dari tepi kanan
        drag.pointer = [edgeX, drag.pointer[1]];
        kb.autoscroll();
        ok(hadj.get_value() > 0, `papan tidak tergulir (${hadj.get_value()})`);
        kb.onCardRelease(); settleK();
        w.win.set_default_size(1100, 700); settleK();
    });
    test('undo dan redo mengembalikan papan dan teks, satu langkah per perubahan', () => {
        openBoard();
        kb.commit(addCard(kb.getBoard(), 0, 'Satu'));
        kb.commit(addCard(kb.getBoard(), 0, 'Dua')); settleK();
        eq(kb.cardTexts(0).length, 4, 'dua kartu ditambah');
        action('undo'); settleK();
        eq([kb.cardTexts(0).length, text().includes('Dua')], [3, false], 'undo pertama hanya membatalkan "Dua"');
        action('undo'); settleK();
        eq([kb.cardTexts(0).length, text()], [2, BOARD], 'undo kedua mengembalikan teks semula');
        action('redo'); settleK();
        eq(kb.cardTexts(0).at(-1), 'Satu', 'redo');
    });
    test('beralih ke tampilan teks dan kembali; perubahan di teks muncul di papan', () => {
        openBoard();
        w.toggleBoardView(false); settleK();
        ok(!w.boardMode && ed.widget.get_visible(), 'tampilan teks');
        eq(text(), BOARD, 'teks mentah');
        setText(BOARD.replace('- [ ] Kirim undangan', '- [ ] Kirim undangan\n- [ ] Dari teks'));
        w.toggleBoardView(true); settleK();
        ok(w.boardMode, 'kembali ke papan');
        eq(kb.cardTexts(0), ['Tulis laporan #penting @{2026-10-20}', 'Kirim undangan', 'Dari teks']);
    });
    test('tampilan papan untuk dokumen biasa ditolak dengan pesan', () => {
        GLib.file_set_contents(papan, '# Biasa');
        w.load(papan); settleK();
        w.toggleBoardView(true);
        ok(!w.boardMode, 'dokumen biasa tampil sebagai papan');
        ok(w.lastToast.includes('bukan papan kanban'), `pesan: ${w.lastToast}`);
    });
    test('papan kanban baru berisi tiga daftar kosong', () => {
        w.newBoardDocument(); settleK();
        ok(w.boardMode && w.file === null, 'mode atau nama file');
        eq(kbTitles(), ['Rencana', 'Dikerjakan', 'Selesai']);
        ok(isKanban(w.editor.getText()), 'teks bukan papan kanban');
        // Papan baru dibuka di tab baru (dokumen sebelumnya berfile); tutup supaya tes lain memakai editor semula.
        ok(w.closeTab(), 'closeTab() gagal'); settleK();
        ok(w.editor === ed, 'editor semula tidak aktif lagi');
    });
    test('aksi yang menyunting teks nonaktif saat papan tampil dan aktif lagi di tampilan teks', () => {
        openBoard();
        const before = text();
        action('bold'); action('heading1'); action('table');
        eq(text(), before, 'teks berubah');
        const enabled = (name: string) => w.app.lookup_action(name)!.enabled;
        eq([enabled('bold'), enabled('heading1'), enabled('table'), enabled('save')], [false, false, false, true], 'status aksi di papan');
        w.toggleBoardView(false); settleK();
        eq([enabled('bold'), enabled('table')], [true, true], 'status aksi di tampilan teks');
        w.toggleBoardView(true); settleK();
    });
    test('simpan menulis Markdown yang bisa dibaca lagi sebagai papan yang sama', () => {
        openBoard();
        kb.commit(addCard(kb.getBoard(), 1, 'Tersimpan'));
        const out = GLib.build_filenamev([tmp, 'simpan.md']);
        w.file = out;
        ok(w.save(), 'save() gagal');
        const saved = readTextFile(out);
        eq(saved, text(), 'isi file = isi dokumen');
        eq(parseBoard(saved), kb.getBoard(), 'papan dari file = papan di layar');
        w.file = null;
    });
    test('label tanggal: tahun hanya jika bukan tahun ini; tanggal lewat batas ditandai', () => {
        kb.today = () => '2026-10-20';
        eq([kb.formatDue('2026-10-25'), kb.formatDue('2027-01-02')], ['25 Okt', '2 Jan 2027']);
        openBoard();
        const chip = (cls: string) => kbDescendants(kb.widget).some(c => c instanceof Gtk.Label && c.has_css_class(cls));
        ok(!chip('kanban-due-overdue'), 'tanggal 20 Okt belum lewat pada 20 Okt');
        kb.today = () => '2026-10-21'; kb.render(); settleK();
        ok(chip('kanban-due-overdue'), 'tanggal 20 Okt harus lewat batas pada 21 Okt');
        kb.today = () => '2026-10-20';
        eq([kb.tagColor('penting'), kb.tagColor('penting')].every(c => c >= 0 && c < 8), true, 'warna tag dalam rentang');
        eq(kb.tagColor('bug'), kb.tagColor('bug'), 'warna tag tetap');
    });
    test('replaceText: suntingan minimal, satu langkah undo, aman untuk emoji', () => {
        setText('atas 🎉 tengah 🎉 bawah');
        buf.set_modified(false);
        ed.replaceText('atas 🎉 TENGAH 🎉 bawah'); pump();
        eq(text(), 'atas 🎉 TENGAH 🎉 bawah');
        buf.undo(); pump();
        eq(text(), 'atas 🎉 tengah 🎉 bawah', 'undo');
        buf.set_modified(false);
        ed.replaceText('atas 🎉 tengah 🎉 bawah'); pump();
        ok(!buf.get_modified(), 'teks sama tidak mengubah dokumen');
        ed.replaceText('🎉🎉'); pump();
        eq(text(), '🎉🎉', 'pasangan surrogat di tepi');
        ed.replaceText('x🎉🎉y'); pump();
        eq(text(), 'x🎉🎉y');
    });
    test('papan dan seret tidak memicu peringatan GTK', () => {
        const warnings: string[] = [];
        const flags = GLib.LogLevelFlags.LEVEL_WARNING | GLib.LogLevelFlags.LEVEL_CRITICAL;
        const handlers = ['Gtk', 'Gdk', 'Pango', 'GLib-GObject'].map(domain =>
            [domain, GLib.log_set_handler(domain, flags, (_d, _l, m) => { warnings.push(`${domain}: ${m}`); })] as const);
        try {
            openBoard();
            const source = kb.columns[0].cards[0], target = kb.columns[2].cards[0];
            kb.onCardPress(0, 0, source, 10, 10);
            const at = inCard(source, target, 10, 4);
            kb.onCardMotion(at[0], at[1]); settleK();
            kb.onCardRelease(); settleK();
            kb.showAddList(); settleK(); kb.hideAdd(); settleK();
            w.setDark(true); settleK(); w.setDark(false); settleK();
        } finally {
            for (const [domain, id] of handlers) GLib.log_remove_handler(domain, id);
        }
        eq(warnings, [], 'peringatan');
    });
    GLib.file_set_contents(papan, '# selesai');
    w.load(papan); settleK();
    stubDialogs();
    w.file = null;
    buf.set_modified(false);

    test('kolom tenggat: kalender mengisi tanggal, menjaga jam, dan bisa dikosongkan', () => {
        const field = dueField('2026-10-05 09:30');
        const host = new Gtk.Window({ child: field.widget, default_width: 400 });
        host.present();
        pump();
        const popover = field.button.popover!;
        field.button.popup();
        pump();
        const date = field.calendar.get_date();
        eq([date.get_year(), date.get_month(), date.get_day_of_month()], [2026, 10, 5], 'kalender menunjuk tanggal di kolom');
        eq(field.entry.text, '2026-10-05 09:30', 'membuka kalender tidak mengubah kolom');
        const shot = optVal('shot-due');
        if (shot) {
            for (let i = 0; i < 20; i++) { pump(); GLib.usleep(10000); }
            widgetPixbuf(popover)?.savev(`${shot}-kalender.png`, 'png', [], []);
        }
        // Klik hari = select_day lalu day-selected (select_day sendiri tidak memancarkannya).
        field.calendar.select_day(GLib.DateTime.new_local(2026, 10, 20, 0, 0, 0));
        field.calendar.emit('day-selected');
        pump();
        eq(field.entry.text, '2026-10-20 09:30', 'tanggal diganti, jam tetap');
        ok(!popover.get_visible(), 'kalender tertutup setelah memilih');

        field.entry.text = 'bukan tanggal';
        field.button.popup();
        pump();
        const today = GLib.DateTime.new_now_local();
        eq(field.calendar.get_date().format('%Y-%m-%d'), today.format('%Y-%m-%d'), 'teks tidak valid: kalender di hari ini');
        const buttons = descendants(popover).filter((b): b is Gtk.Button => b instanceof Gtk.Button);
        buttons.find(b => b.label === 'Kosongkan')!.emit('clicked');
        pump();
        eq(field.entry.text, '', 'dikosongkan');
        field.button.popup();
        pump();
        buttons.find(b => b.label === 'Hari ini')!.emit('clicked');
        pump();
        eq(field.entry.text, today.format('%Y-%m-%d'), 'hari ini');
        host.destroy();
        pump();
        // Dialog sunting kartu asli (modal), terang dan gelap: ditangkap dari timer selagi tampil, lalu ditutup.
        if (shot) {
            for (const dark of [false, true]) {
                w.setOption('dark', dark);
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                    const dialog = findDialog('Tambah Kartu');
                    if (dialog) { widgetPixbuf(dialog)?.savev(`${shot}-dialog${dark ? '-gelap' : ''}.png`, 'png', [], []); dialog.close(); }
                    return GLib.SOURCE_REMOVE;
                });
                editCardDialog(w.win, { text: 'Tulis laporan #kerja @{2026-10-20}', notes: ['Ikuti keputusan di [[Catatan Rapat]].'] }, 'Tambah Kartu', () => ['Catatan Rapat.md']);
            }
            w.setOption('dark', false);
            pump();
        }
    });
}
