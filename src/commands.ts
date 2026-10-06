// Nama aksi aplikasi untuk palet perintah (aksinya sendiri didaftarkan di actions.ts).

// Nama yang tampil di palet perintah (Ctrl+Shift+P), urut seperti yang ditampilkan saat pencarian kosong.
// Aksi yang tidak ada di sini (misalnya untuk tiap judul atau perintah tabel) tidak muncul di palet.
export const COMMAND_LABELS: Record<string, string> = {
    'new': 'Dokumen Baru', 'open': 'Buka File…', 'open-folder': 'Buka Folder…', 'save': 'Simpan', 'save-as': 'Simpan Sebagai…',
    'export-html': 'Ekspor HTML…', 'close-tab': 'Tutup Tab', 'next-tab': 'Tab Berikutnya', 'prev-tab': 'Tab Sebelumnya',
    'find': 'Cari', 'undo': 'Urungkan', 'redo': 'Ulangi',
    'bold': 'Tebal', 'italic': 'Miring', 'strike': 'Coret', 'inline-code': 'Kode Sebaris', 'highlight': 'Sorot', 'link': 'Sisipkan Tautan',
    'image': 'Sisipkan Gambar…', 'zoom-image': 'Perbesar Gambar', 'codeblock': 'Sisipkan Blok Kode', 'table': 'Sisipkan Tabel',
    'quote': 'Kutipan', 'ulist': 'Daftar Butir', 'olist': 'Daftar Bernomor',
    'table-row-below': 'Tabel: Tambah Baris di Bawah', 'table-row-above': 'Tabel: Tambah Baris di Atas', 'table-delete-row': 'Tabel: Hapus Baris',
    'table-col-right': 'Tabel: Tambah Kolom di Kanan', 'table-col-left': 'Tabel: Tambah Kolom di Kiri', 'table-delete-col': 'Tabel: Hapus Kolom',
    'table-align-left': 'Tabel: Rata Kiri', 'table-align-center': 'Tabel: Rata Tengah', 'table-align-right': 'Tabel: Rata Kanan',
    'table-format': 'Tabel: Rapikan',
    'kanban-new': 'Papan Kanban Baru', 'kanban-view': 'Tampilan Papan Kanban',
    'sidebar': 'Sidebar', 'chat': 'Asisten', 'source': 'Mode Source', 'focus': 'Mode Fokus', 'typewriter': 'Mode Typewriter',
    'dark': 'Mode Gelap', 'autosave': 'Auto Save', 'preferences': 'Preferensi', 'about': 'Tentang Nyerat', 'quit': 'Keluar',
    'command-palette': 'Palet Perintah',
};
