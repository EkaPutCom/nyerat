// Data bersama untuk tes model dan tes GUI.

// Papan kanban baku untuk tes model dan tes GUI.
export const BOARD = [
    '---', 'kanban: true', '---', '',
    '## Rencana', '',
    '- [ ] Tulis laporan #penting @{2026-10-20}', '  catatan satu', '', '  catatan dua',
    '- [ ] Kirim undangan', '',
    '## Dikerjakan', '', '**Aktif**', '', '- [ ] Desain logo', '',
    '## Selesai', '', '- [x] Pesan tempat', '- Item biasa', '', '***', '',
    '%% kanban:settings', '```', '{"kanban":true}', '```', '%%', '',
].join('\n');

// Inbox baku untuk tes model dan tes GUI.
export const INBOX = [
    '---', 'inbox: true', '---', '',
    '# Inbox', '',
    'Tempat menangkap ide.', '',
    '- Ide SQLite #idea ➕ 2026-10-07 14:22', '  catatan satu', '', '  catatan dua',
    '- Baca artikel HIG #read #gnome ➕ 2026-10-07 13:32',
    '- Item tanpa waktu', '',
    'Penutup biasa', '',
].join('\n');
