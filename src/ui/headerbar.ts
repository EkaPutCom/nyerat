// Header bar: tombol-tombol dan menu ☰. Setiap tombol/menu hanya menyebut nama
// aksi ("app.save"); aksinya sendiri didaftarkan di actions.ts.

import Gtk from 'gi://Gtk?version=3.0';
import Gio from 'gi://Gio';

type Item = [label: string, action: string];

// Perintah untuk tabel di posisi kursor (aksinya di actions.ts).
const TABLE_MENU: Item[][] = [
    [['Tambah Baris di Bawah', 'app.table-row-below'], ['Tambah Baris di Atas', 'app.table-row-above'],
        ['Hapus Baris', 'app.table-delete-row']],
    [['Tambah Kolom di Kanan', 'app.table-col-right'], ['Tambah Kolom di Kiri', 'app.table-col-left'],
        ['Hapus Kolom', 'app.table-delete-col']],
    [['Rata Kiri', 'app.table-align-left'], ['Rata Tengah', 'app.table-align-center'], ['Rata Kanan', 'app.table-align-right']],
    [['Rapikan Tabel', 'app.table-format']],
];

const MENU: Item[][] = [
    [['Buka Folder…', 'app.open-folder'], ['Simpan Sebagai…', 'app.save-as'], ['Auto Save', 'app.autosave'],
        ['Ekspor HTML…', 'app.export-html']],
    [['Cari', 'app.find'], ['Sisipkan Gambar…', 'app.image'], ['Perbesar Gambar', 'app.zoom-image'], ['Sisipkan Tabel', 'app.table'],
        ['Sisipkan Blok Kode', 'app.codeblock']],
    [['Papan Kanban Baru', 'app.kanban-new'], ['Tampilan Papan Kanban', 'app.kanban-view']],
    [['Mode Source', 'app.source'], ['Mode Fokus', 'app.focus'], ['Mode Typewriter', 'app.typewriter'],
        ['Mode Gelap', 'app.dark']],
    [['Tentang Nyerat', 'app.about'], ['Keluar', 'app.quit']],
];

function iconButton(icon: string, action: string, tooltip: string, toggle = false): Gtk.Button {
    const button = toggle ? new Gtk.ToggleButton() : new Gtk.Button();
    button.set_image(Gtk.Image.new_from_icon_name(icon, Gtk.IconSize.BUTTON));
    button.set_action_name(action);
    button.set_tooltip_text(tooltip);
    return button;
}

export function createHeaderBar(): Gtk.HeaderBar {
    const bar = new Gtk.HeaderBar({ show_close_button: true });
    bar.pack_start(iconButton('format-justify-left-symbolic', 'app.sidebar', 'Sidebar (Ctrl+\\)', true));
    // Ikon dokumen, bukan document-open-symbolic: di beberapa tema ikon (misalnya
    // elementary-xfce) document-open berupa folder, sehingga tertukar dengan Buka Folder.
    bar.pack_start(iconButton('text-x-generic-symbolic', 'app.open', 'Buka File (Ctrl+O)'));
    bar.pack_start(iconButton('folder-open-symbolic', 'app.open-folder', 'Buka Folder (Ctrl+Shift+O)'));
    bar.pack_start(iconButton('document-new-symbolic', 'app.new', 'Baru (Ctrl+N)'));

    const menu = new Gio.Menu();
    for (const section of MENU) {
        const part = new Gio.Menu();
        for (const [label, action] of section) part.append(label, action);
        // Submenu Tabel mengikuti item "Sisipkan Tabel".
        if (section.some(([, action]) => action === 'app.table')) {
            const sub = new Gio.Menu();
            for (const group of TABLE_MENU) {
                const groupMenu = new Gio.Menu();
                for (const [label, action] of group) groupMenu.append(label, action);
                sub.append_section(null, groupMenu);
            }
            part.append_submenu('Edit Tabel', sub);
        }
        menu.append_section(null, part);
    }
    const menuButton = new Gtk.MenuButton({ menu_model: menu, tooltip_text: 'Menu' });
    menuButton.set_image(Gtk.Image.new_from_icon_name('open-menu-symbolic', Gtk.IconSize.BUTTON));
    bar.pack_end(menuButton);
    bar.pack_end(iconButton('document-save-symbolic', 'app.save', 'Simpan (Ctrl+S)'));
    bar.pack_end(iconButton('user-available-symbolic', 'app.chat', 'Asisten (Ctrl+Shift+A)', true));
    return bar;
}
