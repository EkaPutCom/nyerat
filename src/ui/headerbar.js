// Header bar: tombol-tombol dan menu ☰. Setiap tombol/menu hanya menyebut nama
// aksi ("app.save"); aksinya sendiri didaftarkan di actions.js.

import Gtk from 'gi://Gtk?version=3.0';
import Gio from 'gi://Gio';

const MENU = [
    [['Simpan Sebagai…', 'app.save-as'], ['Ekspor HTML…', 'app.export-html']],
    [['Cari', 'app.find'], ['Sisipkan Gambar…', 'app.image'], ['Sisipkan Tabel', 'app.table'],
        ['Sisipkan Blok Kode', 'app.codeblock']],
    [['Mode Source', 'app.source'], ['Mode Fokus', 'app.focus'], ['Mode Typewriter', 'app.typewriter'],
        ['Mode Gelap', 'app.dark']],
    [['Tentang Nyerat', 'app.about'], ['Keluar', 'app.quit']],
];

function iconButton(icon, action, tooltip, toggle = false) {
    const button = toggle ? new Gtk.ToggleButton() : new Gtk.Button();
    button.set_image(Gtk.Image.new_from_icon_name(icon, Gtk.IconSize.BUTTON));
    button.set_action_name(action);
    button.set_tooltip_text(tooltip);
    return button;
}

export function createHeaderBar() {
    const bar = new Gtk.HeaderBar({ show_close_button: true });
    bar.pack_start(iconButton('format-justify-left-symbolic', 'app.sidebar', 'Outline (Ctrl+\\)', true));
    bar.pack_start(iconButton('document-open-symbolic', 'app.open', 'Buka (Ctrl+O)'));
    bar.pack_start(iconButton('document-new-symbolic', 'app.new', 'Baru (Ctrl+N)'));

    const menu = new Gio.Menu();
    for (const section of MENU) {
        const part = new Gio.Menu();
        for (const [label, action] of section) part.append(label, action);
        menu.append_section(null, part);
    }
    const menuButton = new Gtk.MenuButton({ menu_model: menu, tooltip_text: 'Menu' });
    menuButton.set_image(Gtk.Image.new_from_icon_name('open-menu-symbolic', Gtk.IconSize.BUTTON));
    bar.pack_end(menuButton);
    bar.pack_end(iconButton('document-save-symbolic', 'app.save', 'Simpan (Ctrl+S)'));
    return bar;
}
