// Pengujian input dari server X11: tidak memanggil handler seret secara langsung.
import GLib from 'gi://GLib';
import System from 'system';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import { parseBoard } from '../../src/markdown/kanban.js';
import { readTextFile } from '../../src/files.js';
import { tmp, section, test, eq, ok } from '../framework.js';
import { MouseInput } from './mouse-input.js';
import { countPointerEvents, screenPoint } from '../widgets.js';
import type { GuiContext } from './context.js';

const BOARD = '---\nkanban: true\n---\n\n## Asal\n\n- [ ] Kartu A 🎉\n  Catatan A\n- [ ] Kartu B\n\n## Tujuan\n\n- [ ] Kartu C\n\n## Kosong\n';

export function kanbanMouseTests(c: GuiContext): void {
    const { w, buf, pump, text, action } = c;
    const kb = w.board;
    section('Seret kartu lewat mouse X11 (XTest)');
    ok(Gdk.Display.get_default()?.get_name().includes(':'), 'Tes membutuhkan backend X11 (GDK_BACKEND=x11).');
    const input = new MouseInput();
    const settle = () => {
        // pump() memutar main loop bersarang. Selesaikan GC GJS sebelum masuk ke
        // putaran itu agar finalisasi widget yang dibuang saat papan digambar ulang tidak tertunda.
        System.gc();
        for (let i = 0; i < 12; i++) { pump(); GLib.usleep(10000); }
    };
    const move = (x: number, y: number) => { input.move(x, y); settle(); };
    const point = (widget: Gtk.Widget, y: number): readonly [number, number] => {
        ok(widget.get_mapped(), 'Widget tujuan belum tampil.');
        return screenPoint(widget, widget.get_allocated_width() / 2, y, (xid, x, wy) => input.toRoot(xid, x, wy));
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
        w.win.set_default_size(1100, 700);
        w.win.present_with_time(Gdk.CURRENT_TIME);
        settle();
        kb.scroller.get_hadjustment().set_value(0);
        settle();
        edits = 0;
    };
    let held = false;
    const drag = (source: Gtk.Box, destination: () => readonly [number, number]) => {
        const start = point(source, 12);
        const target = destination();
        // Penghitung di fase CAPTURE melihat event sebelum gesture kartu menanganinya.
        const events = countPointerEvents(source);
        try {
            move(...start);
            input.down(); held = true; settle();
            ok(events.presses > 0, 'Tombol tekan XTest tidak diterima kartu oleh GTK.');
            // Lewati ambang seret sebelum menuju tujuan, agar klik tidak dianggap sunting.
            move(start[0] + 12, start[1]);
            ok(kb.dragging, 'GTK menerima tekan, tetapi seret tidak dimulai.');
            const ghost = kb['drag']!.ghost;
            const placeholder = kb['drag']!.placeholder;
            ok(ghost.get_parent(), 'Kartu bayangan tidak tampil.');
            for (let i = 1; i <= 10; i++) {
                move(start[0] + 12 + (target[0] - start[0] - 12) * i / 10,
                    start[1] + (target[1] - start[1]) * i / 10);
            }
            // Penanda jatuh mengubah tata letak selama gerak. Ikuti kartu tujuan yang
            // terlihat sekarang, seperti saat pengguna menyeret dengan tangan.
            for (let i = 0; i < 3; i++) move(...destination());
            input.up(); held = false; settle();
            ok(events.motions > 0 && events.releases > 0, 'Event gerak/lepas tidak diterima GTK.');
            ok(!kb.dragging, 'Seret masih aktif setelah tombol dilepas.');
            ok(!ghost.get_parent(), 'Kartu bayangan belum dibersihkan.');
            ok(!placeholder.get_parent(), 'Penanda jatuh belum dibersihkan.');
            eq(edits, 0, 'seret tidak membuka sunting');
            eq(parseBoard(text()), kb.getBoard(), 'Markdown sesuai papan');
        } finally {
            if (held) { input.up(); held = false; settle(); }
            events.stop();
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
