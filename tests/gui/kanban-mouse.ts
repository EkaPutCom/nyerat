// Pengujian input dari server X11: tidak memanggil handler seret secara langsung.
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=3.0';
import Gdk from 'gi://Gdk?version=3.0';
import { parseBoard } from '../../src/markdown/kanban.js';
import { readTextFile } from '../../src/files.js';
import { tmp, section, test, eq, ok } from '../framework.js';
import { MouseInput } from './mouse-input.js';
import type { GuiContext } from './context.js';

const BOARD = '---\nkanban: true\n---\n\n## Asal\n\n- [ ] Kartu A 🎉\n  Catatan A\n- [ ] Kartu B\n\n## Tujuan\n\n- [ ] Kartu C\n\n## Kosong\n';

export function kanbanMouseTests(c: GuiContext): void {
    const { w, buf, pump, text, action } = c;
    const kb = w.board;
    section('Seret kartu lewat mouse X11 (XTest)');
    ok(Gdk.Display.get_default()?.get_name().includes(':'), 'Tes membutuhkan backend X11 (GDK_BACKEND=x11).');
    const input = new MouseInput();
    const settle = () => { for (let i = 0; i < 12; i++) { pump(); GLib.usleep(10000); } };
    const move = (x: number, y: number) => { input.move(x, y); settle(); };
    const point = (widget: Gtk.Widget, y: number): readonly [number, number] => {
        const [valid, x, wy] = widget.translate_coordinates(w.win, widget.get_allocated_width() / 2, y);
        ok(valid && widget.get_mapped(), 'Widget tujuan belum tampil.');
        const [, rx, ry] = w.win.get_window()!.get_origin();
        return [rx + x, ry + wy];
    };
    const path = GLib.build_filenamev([tmp, 'mouse-kanban.md']);
    let original: readonly [number, number];
    try { original = input.position(); }
    catch (error) { input.close(); throw error; }
    let edits = 0;
    const dialogs = kb.dialogs;
    kb.dialogs = { ...dialogs, editCard: () => { edits++; return null; } };
    const reset = () => {
        GLib.file_set_contents(path, BOARD);
        w.load(path);
        w.win.resize(1100, 700);
        w.win.present_with_time(Gdk.CURRENT_TIME);
        settle();
        kb.widget.get_hadjustment().set_value(0);
        settle();
        edits = 0;
    };
    let held = false;
    const drag = (source: Gtk.EventBox, destination: () => readonly [number, number]) => {
        const start = point(source, 12);
        const target = destination();
        let presses = 0, motions = 0, releases = 0;
        let sourceDestroyed = false;
        const destroyId = source.connect('destroy', () => { sourceDestroyed = true; });
        // Sinyal umum terbit sebelum handler kartu mengonsumsi sinyal khususnya.
        const id = source.connect('event', (_widget, event) => {
            const kind = (event as unknown as Gdk.Event).get_event_type();
            if (kind === Gdk.EventType.BUTTON_PRESS) presses++;
            if (kind === Gdk.EventType.MOTION_NOTIFY) motions++;
            if (kind === Gdk.EventType.BUTTON_RELEASE) releases++;
            return false;
        });
        try {
            move(...start);
            input.down(); held = true; settle();
            ok(presses > 0, 'Tombol tekan XTest tidak diterima kartu oleh GTK.');
            // Lewati ambang seret sebelum menuju tujuan, agar klik tidak dianggap sunting.
            move(start[0] + 12, start[1]);
            ok(kb.dragging, 'GTK menerima tekan, tetapi seret tidak dimulai.');
            const ghost = kb['drag']!.ghost;
            const placeholder = kb['drag']!.placeholder;
            let placeholderDestroyed = false;
            placeholder.connect('destroy', () => { placeholderDestroyed = true; });
            ok(ghost, 'Kartu bayangan tidak tampil.');
            for (let i = 1; i <= 10; i++) {
                move(start[0] + 12 + (target[0] - start[0] - 12) * i / 10,
                    start[1] + (target[1] - start[1]) * i / 10);
            }
            // Penanda jatuh mengubah tata letak selama gerak. Ikuti kartu tujuan yang
            // terlihat sekarang, seperti saat pengguna menyeret dengan tangan.
            for (let i = 0; i < 3; i++) move(...destination());
            input.up(); held = false; settle();
            ok(motions > 0 && releases > 0, 'Event gerak/lepas tidak diterima GTK.');
            ok(!kb.dragging, 'Seret masih aktif setelah tombol dilepas.');
            ok(!Gtk.Window.list_toplevels().includes(ghost), 'Jendela bayangan belum dibersihkan.');
            ok(placeholderDestroyed, 'Penanda jatuh belum dibersihkan.');
            eq(edits, 0, 'seret tidak membuka sunting');
            eq(parseBoard(text()), kb.getBoard(), 'Markdown sesuai papan');
        } finally {
            if (held) { input.up(); held = false; settle(); }
            // Papan boleh membangun ulang kartu setelah drop; wrapper yang sudah
            // di-destroy tidak boleh dipakai lagi hanya untuk melepas sinyal tes.
            if (!sourceDestroyed) { source.disconnect(id); source.disconnect(destroyId); }
        }
    };
    try {
        test('mouse memindahkan kartu antar daftar, menyimpan catatan, undo/redo dan file', () => {
            reset();
            const target = kb.columns[1].cards[0];
            drag(kb.columns[0].cards[0], () => point(target, 4));
            eq(kb.cardTexts(0), ['Kartu B']);
            eq(kb.cardTexts(1), ['Kartu A 🎉', 'Kartu C']);
            eq(kb.getBoard().columns[1].cards[0].notes, ['Catatan A']);
            ok(buf.get_modified(), 'Dokumen tidak ditandai berubah.');
            const moved = text();
            action('undo'); settle(); eq(text(), BOARD, 'satu undo mengembalikan dokumen');
            action('redo'); settle(); eq(text(), moved, 'redo mengembalikan perpindahan');
            ok(w.save(), 'Simpan gagal.');
            eq(readTextFile(path), moved, 'hasil simpan');
        });
        test('mouse mengurutkan ulang kartu dalam daftar yang sama', () => {
            reset();
            const second = kb.columns[0].cards[1];
            drag(kb.columns[0].cards[0], () => point(second, second.get_allocated_height() - 4));
            eq(kb.cardTexts(0), ['Kartu B', 'Kartu A 🎉']);
        });
        test('mouse menjatuhkan kartu ke daftar kosong', () => {
            reset();
            drag(kb.columns[0].cards[0], () => point(kb.columns[2].cardsBox, 24));
            eq(kb.cardTexts(2), ['Kartu A 🎉']);
            eq(kb.cardTexts(0), ['Kartu B']);
        });
        test('mouse menjatuhkan di posisi asal tanpa mengubah Markdown', () => {
            reset();
            const source = kb.columns[0].cards[0];
            drag(source, () => point(source, 4));
            eq(text(), BOARD);
            ok(!buf.get_modified(), 'Seret ke asal menandai dokumen berubah.');
        });
        test('klik mouse tanpa seret membuka sunting sekali', () => {
            reset();
            move(...point(kb.columns[0].cards[0], 12));
            input.down(); held = true; settle();
            input.up(); held = false; settle();
            eq(edits, 1, 'dialog sunting');
            eq(text(), BOARD);
        });
    } finally {
        try {
            if (held) input.up();
        } finally {
            kb.dialogs = dialogs;
            buf.set_modified(false);
            w.file = null;
            try { move(...original); }
            finally { input.close(); }
        }
    }
}
