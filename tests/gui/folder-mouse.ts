// Seret file/folder di pohon berkas dengan input X11 sungguhan (XTest).
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import { tmp, section, test, ok } from '../framework.js';
import { MouseInput } from './mouse-input.js';
import { screenPoint } from '../widgets.js';
import type { GuiContext } from './context.js';

export function folderMouseTests(c: GuiContext): void {
    const { w, pump } = c;
    const ft = w.fileTree;
    section('Seret berkas di pohon lewat mouse X11 (XTest)');
    const input = new MouseInput();
    const settle = () => { for (let i = 0; i < 12; i++) { pump(); GLib.usleep(10000); } };
    const move = (x: number, y: number) => { input.move(x, y); settle(); };
    const proj = GLib.build_filenamev([tmp, 'seret']);
    const abs = (...p: string[]) => GLib.build_filenamev([proj, ...p]);
    const exists = (path: string) => GLib.file_test(path, GLib.FileTest.EXISTS);
    const mk = (rel: string) => {
        GLib.mkdir_with_parents(GLib.path_get_dirname(abs(rel)), 0o755);
        GLib.file_set_contents(abs(rel), '# x');
    };
    let held = false;
    try {
        mk('a.md'); mk('tujuan/b.md'); mk('lain/c.md');
        w.win.set_default_size(1100, 700);
        w.win.present_with_time(Gdk.CURRENT_TIME);
        w.openFolder(proj);
        settle();

        // Titik pada widget dalam koordinat layar.
        const onScreen = (widget: Gtk.Widget, x: number, y: number) => screenPoint(widget, x, y, (xid, sx, sy) => input.toRoot(xid, sx, sy));
        const rowPoint = (name: string): [number, number] => {
            ok(ft.list.get_mapped(), 'pohon belum tampil');
            const point = ft.rowPoint(abs(name));
            ok(point, `baris ${name} tidak ada`);
            return onScreen(ft.list, point![0], point![1]);
        };
        const drag = (from: [number, number], to: [number, number]) => {
            move(...from);
            input.down(); held = true; settle();
            move(from[0] + 12, from[1] + 6);
            for (let i = 1; i <= 8; i++) move(from[0] + 12 + (to[0] - from[0] - 12) * i / 8, from[1] + 6 + (to[1] - from[1] - 6) * i / 8);
            input.up(); held = false; settle();
        };

        test('seret file ke folder memindahkannya ke dalam folder itu', () => {
            drag(rowPoint('a.md'), rowPoint('tujuan'));
            ok(exists(abs('tujuan', 'a.md')) && !exists(abs('a.md')), 'file tidak berpindah');
        });
        test('seret folder ke folder lain', () => {
            drag(rowPoint('lain'), rowPoint('tujuan'));
            ok(exists(abs('tujuan', 'lain', 'c.md')) && !exists(abs('lain')), 'folder tidak berpindah');
        });
        test('seret file ke judul pohon memindahkannya keluar ke root', () => {
            const label = ft.widget.get_first_child()!;
            ok(label.get_mapped(), 'judul tidak terlihat');
            const titlePoint = onScreen(label, 20, label.get_allocated_height() / 2);
            ft.expand(abs('tujuan'));
            settle();
            const found = rowPoint('tujuan/b.md');
            drag(found, titlePoint);
            ok(exists(abs('b.md')) && !exists(abs('tujuan', 'b.md')), 'file tidak keluar ke root');
        });
    } finally {
        if (held) input.up();
        input.close();
        ft.setRoot(null);
    }
}
