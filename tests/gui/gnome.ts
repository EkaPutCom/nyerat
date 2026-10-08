// Tes GUI: kepatuhan pada pedoman GNOME (tata letak adaptif, dialog pintasan, ikon aplikasi, warna Adwaita).

import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gtk from 'gi://Gtk?version=4.0';
import { section, test, eq, ok, optVal, ROOT } from '../framework.js';
import { widgetPixbuf } from '../widgets.js';
import type { GuiContext } from './context.js';
import { APP_ID } from '../../src/config.js';
import { hasAdwShortcutsDialog, shortcutEntries, showShortcuts } from '../../src/ui/shortcuts.js';
import { applyTheme } from '../../src/ui/theme.js';
import { _ } from '../../src/i18n.js';
import { childrenOf } from '../../src/gtkutil.js';
import { ImageViewer } from '../../src/ui/imageviewer.js';

const descendants = (widget: Gtk.Widget): Gtk.Widget[] => childrenOf(widget).flatMap(child => [child, ...descendants(child)]);

export function gnomeTests(c: GuiContext): void {
    const { app, w, pump } = c;
    const settle = (n = 40) => { for (let i = 0; i < n; i++) { pump(); GLib.usleep(15000); } };
    const shot = optVal('shot-gnome');

    section('Pedoman GNOME');

    test('ikon jendela dan dialog Tentang memakai App ID', () => {
        eq(APP_ID, 'com.ekaput.Nyerat');
        eq(w.win.get_icon_name(), APP_ID);
        const theme = Gtk.IconTheme.get_for_display(w.win.get_display());
        ok(theme.has_icon(APP_ID), 'ikon aplikasi tidak ditemukan di tema ikon (dist/icons)');
    });

    test('teks tanpa terjemahan tampil dalam bahasa sumber', () => {
        eq(_('Simpan'), 'Simpan');
    });

    test('jendela sempit melipat panel Asisten lalu sidebar menjadi melayang', () => {
        const wasSidebar = w.settings.sidebar, wasChat = w.settings.chat;
        w.settings.sidebar = true; w.settings.chat = true;
        w.win.set_default_size(1100, 700); settle();
        ok(!w.chatSplit.collapsed && !w.sidebar.widget.collapsed, 'jendela lebar: panel tidak boleh melipat');
        w.win.set_default_size(760, 700); settle();
        ok(w.chatSplit.collapsed, 'di bawah 900sp panel Asisten harus melipat');
        ok(!w.sidebar.widget.collapsed, 'di 760 px sidebar masih menempel');
        w.win.set_default_size(480, 700); settle();
        ok(w.chatSplit.collapsed && w.sidebar.widget.collapsed, 'di bawah 600sp kedua panel melipat');
        if (shot) widgetPixbuf(w.win)?.savev(`${shot}-sempit.png`, 'png', [], []);
        ok(!w.chatSplit.show_sidebar && !w.sidebar.widget.show_sidebar, 'panel tertutup saat melipat');
        w.settings.sidebar = true; settle();
        ok(w.sidebar.widget.show_sidebar, 'saat terlipat sidebar tetap bisa dibuka (melayang)');
        w.win.set_default_size(1100, 700); settle();
        ok(!w.chatSplit.collapsed && !w.sidebar.widget.collapsed, 'jendela dilebarkan lagi: panel kembali menempel');
        eq([w.settings.sidebar, w.settings.chat], [true, true], 'pengaturan panel sebelum melipat dipulihkan');
        // Panel yang ditutup tidak ikut terbuka setelah jendela menyempit lalu melebar.
        w.settings.chat = false;
        w.win.set_default_size(760, 700); settle();
        w.win.set_default_size(1100, 700); settle();
        eq(w.chatSplit.show_sidebar, false, 'panel Asisten yang ditutup tetap tertutup');
        w.settings.sidebar = wasSidebar; w.settings.chat = wasChat; settle();
    });

    test('dialog pintasan disusun dari accel aksi yang terpasang', () => {
        const entries = shortcutEntries(app);
        const all = new Map(entries.flatMap(([, items]) => items));
        eq(all.get('Simpan'), '<Control>s');
        eq(all.get('Pintasan Keyboard'), '<Control>question');
        ok(entries.every(([, items]) => items.length > 0), 'bagian kosong ikut tampil');
        const shown = showShortcuts(app, w.win);
        settle(20);
        ok(w.win.get_visible_dialog() === shown, 'dialog pintasan tidak tampil');
        if (!hasAdwShortcutsDialog()) {
            const rows = descendants(shown).filter(x => x instanceof Adw.ActionRow).map(x => (x as Adw.ActionRow).title);
            ok(rows.includes('Simpan') && rows.includes('Palet Perintah'), `isi dialog pintasan: ${rows.slice(0, 5).join(', ')}…`);
        }
        if (shot) widgetPixbuf(w.win)?.savev(`${shot}-pintasan.png`, 'png', [], []);
        shown.force_close();
        for (let i = 0; i < 50 && w.win.get_visible_dialog(); i++) settle(1);
        settle(10);
    });

    test('palet editor memakai aksen bawaan Adwaita bila sistem tidak menyediakan aksen', () => {
        const light = applyTheme(false), dark = applyTheme(true);
        const style = Adw.StyleManager.get_default() as Adw.StyleManager & { get_system_supports_accent_colors?(): boolean };
        if (!style.get_system_supports_accent_colors?.()) eq([light.accent, dark.accent], ['#1c71d8', '#78aeed']);
        else ok(/^#[0-9a-f]{6}$/.test(light.accent), `aksen sistem tidak valid: ${light.accent}`);
        w.setDark(false);
    });

    if (shot) {
        test('tangkapan layar penampil gambar (Adw.Window)', () => {
            const pixbuf = GdkPixbuf.Pixbuf.new_from_file(GLib.build_filenamev([ROOT, 'tests', 'samples', 'images', 'example.png']));
            const viewer = new ImageViewer(w.win, pixbuf, 'example.png');
            viewer.show(); settle();
            widgetPixbuf(viewer.window)?.savev(`${shot}-gambar.png`, 'png', [], []);
            viewer.window.destroy(); settle(5);
        });
        test('tangkapan layar tema terang dan gelap', () => {
            w.setDark(false); settle();
            widgetPixbuf(w.win)?.savev(`${shot}-terang.png`, 'png', [], []);
            w.setDark(true); settle();
            widgetPixbuf(w.win)?.savev(`${shot}-gelap.png`, 'png', [], []);
            w.setDark(false); settle();
        });
    }
}
