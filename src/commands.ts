// Nama aksi aplikasi untuk palet perintah (aksinya sendiri didaftarkan di actions.ts).

import { _ } from './i18n.js';

// Nama yang tampil di palet perintah (Ctrl+Shift+P), urut seperti yang ditampilkan saat pencarian kosong.
// Aksi yang tidak ada di sini (misalnya untuk tiap judul atau perintah tabel) tidak muncul di palet.
export const COMMAND_LABELS: Record<string, string> = {
    'new': _('Dokumen Baru'), 'open': _('Buka File…'), 'open-folder': _('Buka Folder…'), 'save': _('Simpan'), 'save-as': _('Simpan Sebagai…'),
    'export-html': _('Ekspor HTML…'), 'home': _('Beranda'), 'close-tab': _('Tutup Tab'), 'next-tab': _('Tab Berikutnya'), 'prev-tab': _('Tab Sebelumnya'),
    'find': _('Cari'), 'undo': _('Urungkan'), 'redo': _('Ulangi'),
    'bold': _('Tebal'), 'italic': _('Miring'), 'strike': _('Coret'), 'inline-code': _('Kode Sebaris'), 'highlight': _('Sorot'), 'link': _('Sisipkan Tautan'),
    'image': _('Sisipkan Gambar…'), 'zoom-image': _('Perbesar Gambar'), 'codeblock': _('Sisipkan Blok Kode'), 'table': _('Sisipkan Tabel'),
    'quote': _('Kutipan'), 'ulist': _('Daftar Butir'), 'olist': _('Daftar Bernomor'),
    'table-row-below': _('Tabel: Tambah Baris di Bawah'), 'table-row-above': _('Tabel: Tambah Baris di Atas'), 'table-delete-row': _('Tabel: Hapus Baris'),
    'table-col-right': _('Tabel: Tambah Kolom di Kanan'), 'table-col-left': _('Tabel: Tambah Kolom di Kiri'), 'table-delete-col': _('Tabel: Hapus Kolom'),
    'table-align-left': _('Tabel: Rata Kiri'), 'table-align-center': _('Tabel: Rata Tengah'), 'table-align-right': _('Tabel: Rata Kanan'),
    'table-format': _('Tabel: Rapikan'),
    'kanban-new': _('Papan Kanban Baru'), 'inbox-new': _('Inbox Baru'), 'kanban-view': _('Tampilan Papan/Inbox'),
    'sidebar': _('Sidebar'), 'chat': _('Asisten'), 'source': _('Mode Source'), 'focus': _('Mode Fokus'), 'typewriter': _('Mode Typewriter'),
    'dark': _('Mode Gelap'), 'autosave': _('Auto Save'), 'preferences': _('Preferensi'), 'shortcuts': _('Pintasan Keyboard'), 'about': _('Tentang Nyerat'), 'quit': _('Keluar'),
    'command-palette': _('Palet Perintah'),
};
