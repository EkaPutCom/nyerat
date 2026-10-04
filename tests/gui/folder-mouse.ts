// Seret file/folder di pohon berkas dengan input X11 sungguhan (XTest).
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=3.0';
import Gdk from 'gi://Gdk?version=3.0';
import { tmp, section, test, ok } from '../framework.js';
import { MouseInput } from './mouse-input.js';
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
        w.win.resize(1100, 700);
        w.win.present_with_time(Gdk.CURRENT_TIME);
        w.openFolder(proj);
        settle();

        // Titik tengah baris (atau judul) dalam koordinat layar.
        const origin = () => w.win.get_window()!.get_origin().slice(1) as [number, number];
        const rowPoint = (name: string): [number, number] => {
            let [ok2, it] = ft.store.iter_children(null);
            while (ok2 && ft.store.get_value(it, 0) !== name) ok2 = ft.store.iter_next(it);
            ok(ok2, `baris ${name} tidak ada`);
            const rect = ft.view.get_cell_area(ft.store.get_path(it)!, ft.view.get_column(0));
            const [valid, x, y] = ft.view.translate_coordinates(w.win, rect.x + 40, rect.y + rect.height / 2);
            ok(valid && ft.view.get_mapped(), 'pohon belum tampil');
            const [ox, oy] = origin();
            return [ox + x, oy + y];
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
            const label = ft.widget.get_children()[0];
            const [valid, x, y] = label.translate_coordinates(w.win, 20, label.get_allocated_height() / 2);
            ok(valid, 'judul tidak terlihat');
            const [ox, oy] = origin();
            ft.view.expand_all();
            settle();
            let found: [number, number] | null = null;
            const walk = (iter: Gtk.TreeIter | null, depth: number) => {
                let [ok2, it] = ft.store.iter_children(iter);
                while (ok2) {
                    if (ft.store.get_value(it, 1) === abs('tujuan', 'b.md')) {
                        const rect = ft.view.get_cell_area(ft.store.get_path(it)!, ft.view.get_column(0));
                        const [, px, py] = ft.view.translate_coordinates(w.win, rect.x + 40, rect.y + rect.height / 2);
                        found = [ox + px, oy + py];
                    }
                    walk(it, depth + 1);
                    ok2 = ft.store.iter_next(it);
                }
            };
            walk(null, 0);
            ok(found, 'baris b.md tidak ditemukan');
            drag(found!, [ox + x, oy + y]);
            ok(exists(abs('b.md')) && !exists(abs('tujuan', 'b.md')), 'file tidak keluar ke root');
        });
    } finally {
        if (held) input.up();
        input.close();
        ft.setRoot(null);
    }
}
