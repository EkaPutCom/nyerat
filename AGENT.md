# AGENT.md

Panduan singkat untuk AI agent yang bekerja di proyek ini. Penjelasan lengkap (fitur, shortcut, arsitektur, cara kerja tiap modul) ada di [README.md](README.md); baca bagian yang relevan sebelum mengubah modul terkait.

## Ringkasan

Goal Nyerat: **personal workbench AI agent** untuk desktop Linux, ruang kerja pribadi untuk catatan, dokumen, riset, rencana, dan tugas bersama agent AI yang memahami konteks kerja pengguna. Fondasi saat ini adalah editor Markdown dengan tampilan langsung terformat, kanban, riwayat Git, dan asisten AI. Asisten membaca bebas dan transparan soal konteks dan token, tetapi tidak pernah menulis sendiri: satu-satunya tindakan yang ada adalah usulan berkas baru atau perubahan teks (`agent/changes.ts`) yang baru diterapkan setelah pengguna menekan Terapkan; pertahankan perilaku itu saat mengubah `agent/` dan `ui/chat.ts`, kecuali tugas secara eksplisit mencakup penambahan kemampuan tindakan agent. Kemampuan tindakan baru harus memiliki batas akses yang jelas, hasil yang dapat ditinjau, dan persetujuan pengguna untuk tindakan yang memerlukannya. Bedakan goal pengembangan dari fitur yang sudah tersedia; lihat README bagian "Goal: personal workbench AI agent". **GTK 4 + GtkSourceView 5 + GJS** (WebKitGTK 6.0 untuk diagram), kode **TypeScript** yang dibundel **Vite** ke `dist/`. Aplikasi dijalankan GJS (SpiderMonkey 115), **bukan** Node.js, jadi API Node dan browser tidak tersedia saat runtime. Node hanya untuk build.

Bahasa: komentar kode, pesan commit, teks antarmuka, nama tes, dan dokumentasi ditulis dalam **bahasa Indonesia**. Ikuti itu.

## Perintah

| Perintah | Fungsi |
| --- | --- |
| `npm install` | Pasang dependensi pengembangan (sekali) |
| `npm run typecheck` | Hanya `tsc --noEmit` |
| `npm run build` | Cek tipe, lalu bundel ke `dist/` |
| `npm start` | Build lalu jalankan aplikasi |
| `npm run dev` | Build ulang dan buka ulang aplikasi tiap file disimpan |
| `npm test` | Build lalu semua tes (unit + GUI + mouse) di display Xvfb terpisah |
| `npm run test:ui` | Build lalu semua tes ditampilkan di desktop X11; pointer akan bergerak |
| `npm run test:live` | Tes langsung ke API DeepSeek (butuh `DEEPSEEK_API_KEY` di `.env`; tidak ikut `npm test`, memakai kuota sungguhan) |
| `npm run bench` | Build lalu ukur performa (Markdown + editor GUI) di Xvfb; `gjs -m dist/bench.js --no-gui` hanya modul Markdown |
| `npm run bench:compare` | Benchmark dan bandingkan dengan `bench/baseline.json`; setelah optimasi sengaja, perbarui baseline lewat `--save=bench/baseline.json` |
| `gjs -m dist/run-tests.js --no-gui` | Tes tanpa jendela (setelah build) |

- `dist/` adalah hasil build dan tidak masuk git. **Tes selalu berjalan dari `dist/`**, jadi build ulang sebelum menjalankan `gjs -m dist/run-tests.js ...`.
- `npm test` membutuhkan `xvfb-run`, `Xvfb`, dan `xauth`; tes GUI dan mouse memakai display virtual sehingga tidak butuh sesi desktop dan tidak menggerakkan pointer pengguna. Runner GJS langsung masih bisa memakai sesi desktop; tanpa display, pakai `--no-gui`.
- **Selama pengembangan**, pakai `npm test` (Xvfb, tidak menggerakkan pointer pengguna) sebagai tes sehari-hari. Jika tidak ada display, minimal `npm run typecheck` + `--no-gui`.
- **Di akhir pengembangan**, sebelum menyatakan pekerjaan selesai, jalankan juga `npm run test:ui` (di desktop X11 sungguhan; pointer akan bergerak, jadi beri tahu pengguna) dan laporkan hasil kedua perintah apa adanya.
- **Log kedua tes harus bersih**, bukan hanya "0 gagal": periksa keluarannya dan pastikan tidak ada `Gjs-CRITICAL`, `Gjs-WARNING`, `Gtk-WARNING`, `GLib-*`, stack trace, atau baris galat/peringatan lain yang berasal dari kode kita. Telusuri dan perbaiki penyebabnya (sering kali tes yang memakai widget yang sudah dihancurkan), jangan disembunyikan atau diabaikan. Hanya peringatan lingkungan yang bukan dari kode kita (mis. `libEGL warning: DRI3`) boleh tersisa; sebutkan itu di laporan. **Wajib membaca log lengkap** (jangan hanya `tail` atau `grep ✓`/ringkasan lulus-gagal): simpan keluaran ke file lalu `grep -nE 'CRITICAL|WARNING|Error|Traceback|Stack trace|^\s+@'`. Jika log tidak bersih, perbaiki dan jalankan ulang sampai bersih sebelum menyatakan selesai; laporan akhir harus menyebut hasil pemeriksaan log ini.
- **Fitur baru atau perubahan tampilan wajib dicek lewat screenshot.** Jalankan aplikasinya (mis. lewat `scripts/capture.ts` atau `npm start` di Xvfb/desktop), ambil screenshot keadaan yang relevan (tema terang dan gelap bila terkait), lalu lihat gambarnya dan nilai apakah tata letaknya sesuai: posisi dan lebar sidebar, perataan, jarak, teks terpotong, widget yang mengembang atau menumpuk. Tes hijau saja belum membuktikan tampilannya benar. Perbaiki yang janggal sebelum menyatakan selesai, dan sebutkan di laporan apa yang diperiksa.
- Tes yang gagal sesekali (flaky) tidak boleh dianggap lulus: ulangi, cari penyebabnya, dan laporkan jika belum terpecahkan.

## Pemeriksaan performa wajib

- **Selalu cek dampak performa setiap perubahan sebelum menyatakan pekerjaan selesai.** Tes kebenaran saja belum cukup untuk perubahan kode aplikasi.
- Untuk perubahan kode aplikasi, jalankan `npm run bench:compare` dan benchmark skenario yang terdampak. Bandingkan sebelum/sesudah dengan ukuran dokumen, jumlah pengulangan, jenis fixture, dan lingkungan yang setara; laporkan median, p95, maksimum, serta regresi yang ditemukan.
- Perubahan editor, penyorotan, atau tata letak harus diperiksa pada dokumen biasa dan dokumen panjang. Gunakan fixture `long` untuk puluhan ribu baris, fixture `buku` (`--fixture=buku --size=400 --sizes=50,200,400`, naskah ±650 KB) untuk pengalaman menulis buku, serta dokumen dengan banyak tabel/blok kode bila terkait. Untuk membuka dokumen, lihat `buka: jeda terpanjang` (jeda main loop yang terasa membeku), bukan hanya total `setText`. Periksa membuka teks, mengetik, perpindahan kursor, paste, hapus, undo, dan redo sesuai cakupan perubahan.
- Telusuri regresi yang berarti sebelum menyatakan performa membaik. Jika benchmark macet, callback GJS terblokir saat GC, atau pengukuran tidak lengkap, laporkan sebagai pemeriksaan gagal/belum terverifikasi; jangan gunakan hasil parsial sebagai baseline atau bukti aplikasi sudah nyaman.
- Perbarui `bench/baseline.json` hanya dari hasil lengkap yang valid setelah perubahan disengaja dievaluasi, dan catat hasil serta keterbatasannya di `bench/PERFORMANCE.md`. Jangan mengganti baseline hanya untuk menyembunyikan regresi.
- **Setiap kali ada improvement performa, perbarui juga `docs/belajar-performa.html`** (ditautkan dari `docs/index.html`), dokumentasi belajar performa untuk dev. Tambahkan commit-nya ke daftar perjalanan dan, bila metriknya tercakup, ke data grafik (`typeData`/`cursorData`). Tulis bab baru atau perluas bab yang ada dengan gejala, penyebab, ilustrasi struktur data sebelum/sesudah, bar sebelum/sesudah (`.cmp[data-rows]`) dari angka di `bench/PERFORMANCE.md`, dan pelajarannya. Tambahkan simulasi bila perubahan struktur datanya bisa diperagakan; sebutkan apakah simulasi itu pengukuran nyata atau model terkalibrasi. Catat juga regresi yang muncul di bagian regresi. Setelah mengubahnya, buka halaman itu di browser untuk memastikan tidak ada error console dan tidak ada gulir horizontal di lebar 375 px.
- Untuk perubahan dokumentasi saja, tetap cek bahwa kode runtime tidak berubah dan nyatakan bahwa benchmark tidak dijalankan karena tidak ada dampak runtime. Jika lingkungan menghalangi benchmark yang diperlukan, laporkan alasan dan cakupan yang belum diperiksa.

## Struktur dan aturan lapisan

```
src/
  markdown/   aturan Markdown, TypeScript murni, TANPA import GTK (mudah diuji)
  agent/      asisten AI: penyusunan konteks naskah dan klien model (context/session/sse/transcript murni, tanpa GTK; chatstore.ts memakai Gio)
  editor/     mesin editor (MarkdownView, tag, penyorot, gambar, tabel, kode)
  ui/         komponen antarmuka mandiri (sidebar, kanban, dialog, ...)
  window.ts   satu-satunya tempat komponen saling dihubungkan; juga mengelola dokumen/tab (satu `MarkdownView` per tab)
  actions.ts  semua aksi menu dan shortcut
tests/
  unit/       tes tanpa GUI, satu file per modul
  gui/        tes dengan jendela sungguhan, satu file per modul
  run-tests.ts, framework.ts, fixtures.ts
  samples/    dokumen contoh (dipakai tes dan pemeriksaan manual)
```

Arah ketergantungan: `window.ts` → `ui/*`, `editor/*` → `markdown/*`, `agent/*`. Lapisan bawah tidak boleh meng-import lapisan atas. `editor/` tidak boleh tahu soal `ui/`, file, atau menu; ia memberi kabar lewat callback (`onHighlighted`, `onCursorMoved`, ...) yang disambungkan di `window.ts`.

## Konvensi kode

- Import antarmodul memakai akhiran **`.js`** meski filenya `.ts` (`import { x } from './tags.js'`).
- Modul GJS diimpor dengan `gi://`, mis. `import Gtk from 'gi://Gtk?version=4.0'` (juga `Gdk?version=4.0`, `GtkSource?version=5`, `WebKit?version=6.0`). Modul bawaan GJS (`gi://`, `system`, `gettext`, `cairo`, `console`) ditandai `external` di Vite; jangan menambah dependensi runtime dari `node_modules`.
- Indentasi 4 spasi, tanda kutip tunggal, titik koma. Samakan gaya dan kepadatan komentar dengan file di sekitarnya; komentar menjelaskan *mengapa*, bukan *apa*.
- Tipe `@girs/*` kadang tidak cocok dengan perilaku runtime (contoh: XID `GdkX11.X11Surface.get_xid()` di `tests/widgets.ts`). Beri cast yang sempit dan komentar singkat, jangan melonggarkan tsconfig.
- Pembantu GTK 4 ada di `src/gtkutil.ts` (boleh dipakai semua lapisan): `iterAtLine()` (GTK 4 mengembalikan `[ok, iter]`), `childrenOf()`/`removeChildren()` (tidak ada `get_children()`), `onClick()`/`onKeyPress()` (controller pengganti sinyal event), `pack()` (pengganti `pack_start`), `runModal()` (pengganti `dialog.run()`). Pakai itu, jangan menulis ulang polanya.
- Fungsi di `markdown/` (termasuk operasi model kanban dan tabel) bersifat murni: tidak mengubah argumen, mengembalikan nilai baru.

## Jebakan yang sudah diketahui

Detail dan alasannya ada di README, bagian "Hal teknis yang perlu diketahui".

- **Posisi teks:** GtkTextBuffer menghitung per code point, string JS per unit UTF-16 (emoji = 1 vs 2). Konversi dengan `makeCpMap()` (`editor/offsets.ts`) tepat sebelum menyentuh buffer.
- **Jangan pakai atribut `invisible`** pada GtkTextTag (bisa crash GTK 3; tata letak tabel/diagram/marker bertumpu pada tag kecil ini). Menyembunyikan teks memakai tag `hidden` dengan ukuran kecil `TINY` = 256, **bukan** 1 (ukuran 1 membuat font emoji gagal digambar).
- **Gambar dan tabel bukan isi buffer.** Keduanya widget overlay TextView di atas ruang kosong (`pixels_below_lines`). Jangan menyisipkan `GtkTextChildAnchor` karena mengotori dokumen dan riwayat undo. Overlay **tidak bisa dilepas** di GTK 4.14 (`gtk_text_view_remove()` memberi "is not a child"), jadi pinjam slot dari `OverlaySlots` (`editor/overlays.ts`), posisikan dengan `place()` (koordinat buffer), dan kembalikan dengan `release()`; pasang penerima klik di isi slot, bukan di slotnya. Overlay juga tidak ikut bergulir tanpa bantuan (lihat README, Catatan GTK 4): `OverlaySlots` mengalokasikan ulang TextView dan wadahnya tiap kali bergulir. Tes posisi overlay harus membandingkan letak widget sebenarnya (`translate_coordinates`) setelah digulir, bukan angka yang disimpan lapisan. Jangan pakai `ListBox.remove_all()` (ikut membuang placeholder); pakai `removeChildren()`.
- **Teks buffer adalah sumber kebenaran** untuk papan kanban. Perubahan dari papan lewat `commit()` → `serializeBoard()` → `MarkdownView.replaceText()` agar jadi satu langkah undo.
- **Penyorotan ditunda** dengan `GLib.idle_add(PRIORITY_HIGH_IDLE)` (`queueHighlight`, `queueCursorUpdate`). Jangan memanggil `highlight()` langsung dari handler yang bisa terpicu beruntun.
- **Mengganti seluruh isi TextView yang bisa panjang** harus lewat `replaceAllText()` (`editor/view.ts`). Tanpa itu GTK bisa menata semua baris baru sekaligus saat menggambar pertama (di GTK 3 naskah 650 KB membeku ±0,6 detik). Fungsi itu hanya menggulir ke kursor jika TextView sudah punya ukuran; gulir yang diantre sebelum dialokasikan dijalankan GTK 4 dengan geometri kosong dan membuka dokumen di tengah/akhir. Jangan mengubah `bottom_margin`/`top_margin` TextView saat runtime: GTK lalu menata ulang seluruh dokumen.
- **Penyorotan bertahap saat membuka:** setelah `setText()`, tag dokumen panjang (>200 baris) dicicil di idle (`queueFill()`). Tes yang memeriksa tag di akhir dokumen panjang harus menunggu `ed.highlightComplete`; kode yang memasang tag lewat `LineTagger` harus menghormati baris yang ditunda (`defer()`/`fill()`).
- **Marker tersembunyi bertahap:** `MarkerConcealer` (`editor/decorations.ts`) hanya memeriksa baris aktif lama/baru, baris `reparsed` dari penyorot, dan baris yang belum diketahui. Jika mengubah penyorot, pastikan `reparsed` mencakup semua baris yang marker-nya bisa berubah dan marker tetap urut menurut barisnya; tes `marker tersembunyi bertahap` di `tests/gui/robust.ts` menjaganya.
- **Tulis file lewat `files.ts`.** Auto save dari timer menulis di latar (`writeTextFileAsync()`); penulisan sinkron, pindah, dan buang file harus memanggil `waitForWrites()` (sudah dilakukan `writeTextFile()` dan `fileops.ts`) supaya isi lama tidak menimpa yang baru.
- **Jangan `remove_tag()` di seluruh buffer lalu pasang ulang.** GTK lalu menata ulang seluruh dokumen; itu dulu membuat mengetik di dokumen 30 KB ±300 ms per ketukan. Pakai `setTagRanges()`/`setTagGroup()` atau `LineTagger` dari `editor/tagsync.ts`. Tag sintaks harus tetap di dalam satu baris (boleh mencakup newline-nya) supaya `LineTagger` bisa dipakai.
- **Lebar jendela:** ScrolledWindow editor memakai `hscrollbar_policy: EXTERNAL`, bukan `NEVER`, supaya jendela bisa mengecil. Hal yang sama berlaku untuk ScrolledWindow di panel Asisten (`ui/chat.ts`): dengan `NEVER`, teks panjang tanpa spasi di kotak pesan melebarkan panel; tesnya ada di `tests/gui/chat.ts`.
- **Diagram Mermaid** dirender WebKitGTK tak terlihat (`editor/mermaidrender.ts`), memuat `dist/mermaid.min.js` yang disalin dari `node_modules` oleh plugin di `vite.config.ts`. Lapisannya (`editor/mermaid.ts`) memakai tag `mermaidhide` sendiri; jangan dipakai bersama `tablehide` karena tiap lapisan menghapus tag-nya di seluruh buffer. Blok ```dbml diterjemahkan ke Mermaid `erDiagram` oleh `markdown/dbml.ts` dan memakai lapisan yang sama. Tes pertama yang merender butuh beberapa detik (WebKit dijalankan).
- **Asisten:** konteks naskah disusun di `agent/context.ts` (murni, diuji di `tests/unit/agent.ts`); jaga agar bagian `system` stabil antar-pertanyaan (cache prefiks DeepSeek) dan semua bagian yang berubah masuk ke `note`. Alat penelusuran model ada di `agent/tools.ts` dan hanya-baca; alat baru harus murni (bekerja di atas `SourceFile[]`), tidak melempar, dan terdaftar di `TOOLS` serta `runTool()`/`describeCall()`. Alat yang mengubah sesuatu tidak boleh masuk `TOOLS`: ia berada di `agent/changes.ts` (`CHANGE_TOOLS`), hanya menghasilkan `Change` murni, dan dijalankan sesi lewat `onProposal`, yang menunggu keputusan pengguna di kartu `ChatPanel.propose()`; penerapannya (`MainWindow.applyChange()`) harus memeriksa lagi bahwa isi berkas belum berubah dan nama berkasnya aman. Alat tulis baru mengikuti pola yang sama dan diberi tes di `tests/unit/changes.ts` dan `tests/gui/chat.ts`. Loop agen ada di `agent/session.ts`. Tes tidak boleh memanggil API sungguhan: pakai `Provider` palsu (`panel.makeProvider`) dan `KeyStore` palsu (`panel.keyStore`); `systemKeyStore` menyentuh keyring dan file di `~/.config`. libsoup dan libsecret dimuat dengan `import()` dinamis supaya typelib yang hilang tidak mematikan aplikasi. Tes yang menunggu Promise memakai `settle()` dari `tests/framework.ts`.
- **Banyak dokumen (tab):** `MainWindow` memegang `docs: Doc[]` dan satu `doc` aktif; `w.editor` dan `w.file` adalah getter ke dokumen aktif, jadi jangan menyimpan `w.editor` di variabel jangka panjang (tes memakai `c.ed` hanya selama tab pertama aktif). Callback editor harus mengecek `doc === this.doc` sebelum menyentuh komponen bersama (outline, status bar). `load()` mengganti isi dokumen aktif; `openInTab()`/`openFile()`/`newDocument()` membuka tab (dokumen tanpa file dan tanpa perubahan dipakai ulang). Tes yang membuka file lewat pohon atau `newDocument()` harus menutup tab tambahannya (`w.closeTab()`) supaya `ed`/`buf` konteks tetap dokumen aktif. Menutup editor menghancurkan widget-nya: idle/timeout di lapisan editor harus mengecek flag `destroyed`, kalau tidak muncul `Gjs-CRITICAL ... already disposed`.
- **Riwayat percakapan:** `ChatPanel.persist()` menulis ke `<folder>/.nyerat/chats` lewat `agent/chatstore.ts` (format di `agent/transcript.ts`, murni dan diuji di `tests/unit/transcript.ts`). Tes GUI memakai folder sementara, jadi aman; jangan menulis ke folder pengguna. Folder bertitik tetap tidak dibaca `readProject`, jaga itu supaya asisten tidak menelusuri riwayatnya sendiri.
- **GTK 4 lewat GJS tidak memancarkan `destroy` untuk widget yang masih dipegang JavaScript.** Jangan memakai sinyal itu untuk membersihkan timer/idle. Komponen yang punya timer menyediakan `destroy()` sendiri; `MainWindow.dispose()` (dari sinyal `unrealize` jendela) dan `closeTab()` memanggilnya. Jendela anak memakai `unrealize` untuk menandai dirinya tertutup.
- **Dialog modal** memakai `runModal()` (main loop bersarang): `Gtk.FileDialog` untuk berkas, `modalWindow()` (`ui/dialogs.ts`) untuk pesan dan formulir. Jangan memakai `Gtk.AlertDialog` atau `destroy_with_parent` (GLib-CRITICAL saat proses keluar). Dialog yang menahan program tetap harus bisa diganti di tes. `Gtk.FileDialog` memakai xdg-desktop-portal jika ada di D-Bus sesi: skrip uji manual yang membuka dialog berkas jalankan dengan `dbus-run-session` dan `GDK_DEBUG=no-portals` supaya dialog tidak muncul di desktop pengguna.
- **`hexpand`/`vexpand` diteruskan ke atas di GTK 4.** Panel samping (sidebar, tab Riwayat/Berkas, panel Asisten) diberi `hexpand: false` eksplisit; jika menambah widget mengembang di dalamnya, pastikan tes `tab riwayat tidak membuat sidebar mengembang` tetap lulus.
- **Seleksi tidak boleh sempat kosong** saat perintah format mengubah teks terpilih: di X11 GTK 4 lalu membatalkan seleksi baru (clipboard PRIMARY). Sisipkan/hapus di tepi seleksi, jangan hapus lalu sisipkan ulang (lihat `wrapSelection()`).
- **GtkTreeView (pohon berkas):** jangan memanggil `set_drag_dest_row()` (GTK 4.14 segfault saat menggambarnya tanpa DnD model); penanda tujuan memakai seleksi. Jangan memakai widget sebagai ikon drag (`GtkDragIcon` → Gtk-CRITICAL); pakai `DragSource.set_icon()`.
- **Menu konteks** ditulis sebagai `MenuEntry[]` (`ui/menu.ts`) dan ditampilkan dengan `popupMenu()`; tes memanggil `run()` entrinya.
- **Tes di Xvfb (layar 1280×800):** jangan biarkan jendela tes lebih lebar dari layar. Popover dari tombol di luar monitor memicu `gdk_monitor_get_geometry` Gdk-CRITICAL di GTK 4/X11; kembalikan ukuran jendela (mis. 1100×700) setelah tes yang membesarkannya.
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
- `npm test` otomatis menyertakan tes mouse kanban di Xvfb. `npm run docs` tetap memakai display desktop seperti sebelumnya.
- `npm run test:ui` menampilkan seluruh tes termasuk drag mouse di desktop; jalankan hanya jika pengguna meminta mode tes yang ditampilkan.
- Jangan mengedit `dist/` atau `node_modules/` secara manual.

## Git

- Pesan commit berbahasa Indonesia, satu kalimat ringkas dalam bentuk perintah/deskriptif (mis. "Perbaiki dialog konfirmasi hapus saat tanpa keterangan tambahan").
- Satu perubahan logis per commit; sertakan tesnya di commit yang sama.
