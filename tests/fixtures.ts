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
