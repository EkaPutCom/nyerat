# AGENT.md

Panduan singkat untuk AI agent yang bekerja di proyek ini. Penjelasan lengkap (fitur, shortcut, arsitektur, cara kerja tiap modul) ada di [README.md](README.md); baca bagian yang relevan sebelum mengubah modul terkait.

## Ringkasan

Nyerat: editor Markdown ala Typora untuk desktop Linux. **GTK 3 + GtkSourceView 4 + GJS**, kode **TypeScript** yang dibundel **Vite** ke `dist/`. Aplikasi dijalankan GJS (SpiderMonkey 115), **bukan** Node.js, jadi API Node dan browser tidak tersedia saat runtime. Node hanya untuk build.

Bahasa: komentar kode, pesan commit, teks antarmuka, nama tes, dan dokumentasi ditulis dalam **bahasa Indonesia**. Ikuti itu.

## Perintah

| Perintah | Fungsi |
| --- | --- |
| `npm install` | Pasang dependensi pengembangan (sekali) |
| `npm run typecheck` | Hanya `tsc --noEmit` |
| `npm run build` | Cek tipe, lalu bundel ke `dist/` |
| `npm start` | Build lalu jalankan aplikasi |
| `npm run dev` | Build ulang dan buka ulang aplikasi tiap file disimpan |
| `npm test` | Build lalu semua tes (unit + GUI) |
| `gjs -m dist/run-tests.js --no-gui` | Tes tanpa jendela (setelah build) |

- `dist/` adalah hasil build dan tidak masuk git. **Tes selalu berjalan dari `dist/`**, jadi build ulang sebelum menjalankan `gjs -m dist/run-tests.js ...`.
- Tes GUI membuka jendela sungguhan dan butuh sesi desktop (X11/Wayland). Tanpa display, pakai `--no-gui`.
- Sebelum menyatakan pekerjaan selesai, jalankan `npm test` (atau minimal `npm run typecheck` + `--no-gui` jika tidak ada display) dan laporkan hasilnya apa adanya.

## Struktur dan aturan lapisan

```
src/
  markdown/   aturan Markdown, TypeScript murni, TANPA import GTK (mudah diuji)
  editor/     mesin editor (MarkdownView, tag, penyorot, gambar, tabel, kode)
  ui/         komponen antarmuka mandiri (sidebar, kanban, dialog, ...)
  window.ts   satu-satunya tempat komponen saling dihubungkan
  actions.ts  semua aksi menu dan shortcut
tests/
  unit/       tes tanpa GUI, satu file per modul
  gui/        tes dengan jendela sungguhan, satu file per modul
  run-tests.ts, framework.ts, fixtures.ts
  samples/    dokumen contoh (dipakai tes dan pemeriksaan manual)
```

Arah ketergantungan: `window.ts` → `ui/*`, `editor/*` → `markdown/*`. Lapisan bawah tidak boleh meng-import lapisan atas. `editor/` tidak boleh tahu soal `ui/`, file, atau menu; ia memberi kabar lewat callback (`onHighlighted`, `onCursorMoved`, ...) yang disambungkan di `window.ts`.

## Konvensi kode

- Import antarmodul memakai akhiran **`.js`** meski filenya `.ts` (`import { x } from './tags.js'`).
- Modul GJS diimpor dengan `gi://`, mis. `import Gtk from 'gi://Gtk?version=3.0'`. Modul bawaan GJS (`gi://`, `system`, `gettext`, `cairo`, `console`) ditandai `external` di Vite; jangan menambah dependensi runtime dari `node_modules`.
- Indentasi 4 spasi, tanda kutip tunggal, titik koma. Samakan gaya dan kepadatan komentar dengan file di sekitarnya; komentar menjelaskan *mengapa*, bukan *apa*.
- Tipe `@girs/*` kadang tidak cocok dengan perilaku runtime (contoh: event `key-press-event` di `editor/view.ts` di-*cast* ke `Gdk.Event`). Beri cast yang sempit dan komentar singkat, jangan melonggarkan tsconfig.
- Fungsi di `markdown/` (termasuk operasi model kanban dan tabel) bersifat murni: tidak mengubah argumen, mengembalikan nilai baru.

## Jebakan yang sudah diketahui

Detail dan alasannya ada di README, bagian "Hal teknis yang perlu diketahui".

- **Posisi teks:** GtkTextBuffer menghitung per code point, string JS per unit UTF-16 (emoji = 1 vs 2). Konversi dengan `makeCpMap()` (`editor/offsets.ts`) tepat sebelum menyentuh buffer.
- **Jangan pakai atribut `invisible`** pada GtkTextTag (bisa crash GTK 3). Menyembunyikan teks memakai tag `hidden` dengan ukuran kecil `TINY` = 256, **bukan** 1 (ukuran 1 membuat font emoji gagal digambar).
- **Gambar dan tabel bukan isi buffer.** Keduanya widget yang ditempel dengan `add_child_in_window()` di atas ruang kosong (`pixels_below_lines`). Jangan menyisipkan `GtkTextChildAnchor` karena mengotori dokumen dan riwayat undo.
- **Teks buffer adalah sumber kebenaran** untuk papan kanban. Perubahan dari papan lewat `commit()` → `serializeBoard()` → `MarkdownView.replaceText()` agar jadi satu langkah undo.
- **Penyorotan ditunda** dengan `GLib.idle_add(PRIORITY_HIGH_IDLE)` (`queueHighlight`, `queueCursorUpdate`). Jangan memanggil `highlight()` langsung dari handler yang bisa terpicu beruntun.
- **Lebar jendela:** ScrolledWindow editor memakai `hscrollbar_policy: EXTERNAL`, bukan `NEVER`, supaya jendela bisa mengecil.
- **Diagram Mermaid** dirender WebKitGTK tak terlihat (`editor/mermaidrender.ts`), memuat `dist/mermaid.min.js` yang disalin dari `node_modules` oleh plugin di `vite.config.ts`. Lapisannya (`editor/mermaid.ts`) memakai tag `mermaidhide` sendiri; jangan dipakai bersama `tablehide` karena tiap lapisan menghapus tag-nya di seluruh buffer. Tes pertama yang merender butuh beberapa detik (WebKit dijalankan).
- GJS tidak punya HMR; perubahan baru terlihat setelah aplikasi dibuka ulang (`npm run dev` melakukannya otomatis).

## Menambah atau mengubah fitur

1. Aturan Markdown baru → taruh di `src/markdown/` (tanpa GTK) dan tulis tes di `tests/unit/`.
2. Perilaku editor/UI → tes GUI di `tests/gui/`. Tiap modul tes mengekspor satu fungsi dan didaftarkan di `tests/run-tests.ts` (`runUnitTests` atau `runGuiTests`). Pakai `section`, `test`, `eq`, `ok` dari `tests/framework.ts`.
3. Format Markdown baru → tambahkan contohnya ke `tests/samples/semua-format.md` (dipakai tes dan ekspor HTML).
4. Dialog yang menahan program (modal) harus bisa diganti di tes, seperti `KanbanBoard.dialogs`.
5. Fitur, shortcut, atau struktur folder yang berubah → perbarui `README.md` (tabel shortcut, daftar fitur, pohon folder, dan bagian "Cara kerja" yang terkait) dan menu/aksi di `actions.ts`/`headerbar.ts`.

## Lingkungan tes

- Tes memakai folder pengaturan sementara (`XDG_CONFIG_HOME`), jadi `~/.config/nyerat/settings.json` pengguna tidak tersentuh. Jangan menulis ke home pengguna dari tes.
- `--mouse` menggerakkan pointer sungguhan lewat XTest; jalankan hanya jika diminta.
- Jangan mengedit `dist/` atau `node_modules/` secara manual.

## Git

- Pesan commit berbahasa Indonesia, satu kalimat ringkas dalam bentuk perintah/deskriptif (mis. "Perbaiki dialog konfirmasi hapus saat tanpa keterangan tambahan").
- Satu perubahan logis per commit; sertakan tesnya di commit yang sama.
