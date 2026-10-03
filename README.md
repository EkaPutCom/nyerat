# Nyerat

Editor Markdown ala [Typora](https://typora.io) untuk desktop Linux, dibuat dengan **GTK 3**, **GtkSourceView 4**, dan **GJS** (JavaScript untuk GNOME). Kodenya ditulis dalam **TypeScript** dan dibundel dengan **Vite**.

Tidak ada panel pratinjau terpisah: teks langsung tampil terformat. Sintaks Markdown seperti `#`, `**`, `` ` `` dan `[](url)` disembunyikan, lalu muncul lagi saat kursor berada di baris tersebut.

## Kebutuhan

- Linux dengan desktop X11 atau Wayland
- GJS (diuji dengan versi 1.80)
- GTK 3 dan GtkSourceView 4 (biasanya sudah terpasang di desktop GNOME)
- Node.js 20.19+ atau 22.12+ (syarat Vite), **hanya untuk build** (diuji dengan Node.js 24). Aplikasinya sendiri dijalankan GJS, bukan Node.js.

Di Ubuntu/Debian:

```bash
sudo apt install gjs gir1.2-gtk-3.0 gir1.2-gtksource-4
```

## Menjalankan

Sekali saja, pasang dependensi pengembangan (Vite, TypeScript, dan tipe GJS/GTK):

```bash
npm install
```

Build lalu jalankan:

```bash
npm start
```

Setelah di-build, aplikasi bisa dijalankan langsung tanpa npm, termasuk untuk membuka file tertentu (file yang belum ada akan dibuat saat disimpan):

```bash
gjs -m dist/nyerat.js catatan.md
```

Atau membuka sebuah folder, yang isinya tampil di tab Berkas:

```bash
gjs -m dist/nyerat.js ~/catatan
```

| Perintah | Fungsi |
| --- | --- |
| `npm run build` | Periksa tipe (`tsc --noEmit`), lalu bundel dengan Vite ke `dist/` |
| `npm run watch` | Build ulang otomatis setiap file disimpan (tutup dan buka lagi aplikasinya untuk melihat perubahan) |
| `npm run typecheck` | Hanya periksa tipe |
| `npm start` | Build, lalu jalankan aplikasi |
| `npm test` | Build, lalu jalankan semua tes |

## Fitur

**Penulisan ala Typora**
- Heading, **tebal**, *miring*, ~~coret~~, ==stabilo==, `kode inline`, tautan, dan gambar langsung tampil terformat
- Blok kode, kutipan, tabel, dan garis pemisah diberi gaya; baris pembatas ```` ``` ```` disembunyikan di luar blok
- Daftar tugas `- [ ]` bisa dicentang dengan mengklik kotaknya
- Tautan dibuka dengan **Ctrl+klik** (path relatif dihitung dari folder file)
- Gambar `![alt](url)` ditampilkan langsung di bawah barisnya, dari file lokal (path relatif dihitung dari folder dokumen) maupun dari internet. Klik gambar untuk memunculkan sintaksnya
- Enter melanjutkan daftar, daftar bernomor, daftar tugas, dan kutipan secara otomatis; Enter di item kosong mengakhirinya
- Tab / Shift+Tab mengatur indentasi item daftar

**Tampilan**
- Sidebar dengan dua tab:
  - **Berkas**: pohon folder yang dibuka (lewat tombol folder di header bar, `Ctrl+Shift+O`, atau dengan memilih folder di dialog Buka File), berisi subfolder dan file Markdown (`.md`, `.markdown`, `.mdown`, `.mkd`). Klik file untuk membukanya; file yang sedang dibuka ikut disorot. File/folder tersembunyi dan `node_modules` tidak ditampilkan. Pohon diperbarui otomatis saat ada file yang ditambah atau dihapus di disk, dan folder terakhir dibuka lagi saat aplikasi dijalankan
  - **Outline**: daftar heading dokumen; klik untuk melompat
- Mode fokus: paragraf selain yang sedang disunting diredupkan
- Mode typewriter: baris aktif selalu di tengah layar
- Mode source: semua sintaks Markdown ditampilkan
- Mode gelap, otomatis mengikuti tema sistem saat pertama dibuka
- Kolom teks dibuat di tengah dengan lebar baca yang nyaman

**Lainnya**
- Cari teks, undo/redo, hitungan kata dan karakter, posisi kursor
- Ekspor ke HTML mandiri (CSS sudah disertakan)
- Peringatan sebelum menutup jika ada perubahan yang belum disimpan

## Shortcut

| Shortcut | Fungsi |
| --- | --- |
| Ctrl+N / Ctrl+O | Dokumen baru / buka file |
| Ctrl+Shift+O | Buka folder |
| Ctrl+S / Ctrl+Shift+S | Simpan / simpan sebagai |
| Ctrl+Shift+E | Ekspor HTML |
| Ctrl+F | Cari |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo |
| Ctrl+Q | Keluar |
| Ctrl+B | Tebal |
| Ctrl+I | Miring |
| Ctrl+Shift+X atau Alt+Shift+5 | Coret |
| Ctrl+Shift+H | Stabilo |
| Ctrl+` | Kode inline |
| Ctrl+K | Tautan |
| Ctrl+Shift+I | Sisipkan gambar |
| Ctrl+Shift+K | Sisipkan blok kode |
| Ctrl+T | Sisipkan tabel |
| Ctrl+1 … Ctrl+6 | Heading 1–6 |
| Ctrl+0 | Kembalikan ke paragraf |
| Ctrl+Shift+Q | Kutipan |
| Ctrl+Shift+] / Ctrl+Shift+[ | Daftar biasa / daftar bernomor |
| Ctrl+\ atau Ctrl+Shift+1 | Tampilkan/sembunyikan sidebar |
| Ctrl+/ | Mode source |
| F8 | Mode fokus |
| F9 | Mode typewriter |
| Ctrl+Shift+D | Mode gelap |

## Tes

```bash
npm test
```

Tes ditulis dalam TypeScript tanpa framework tambahan, dibundel Vite menjadi `dist/run-tests.js`, lalu dijalankan GJS. Script keluar dengan kode `1` jika ada yang gagal. Isinya:

- **Konversi** Markdown → HTML dan pengurai format inline, tanpa GUI
- **Editor**: membuka jendela sungguhan, lalu memeriksa sintaks yang disembunyikan/ditampilkan, Enter dan Tab di daftar, shortcut format, undo, klik kotak tugas, serta simpan dan buka file
- **Folder**: isi pohon dan urutannya, file tersembunyi dan non-Markdown yang disaring, isi subfolder yang baru dibaca saat dibuka, membuka file dengan klik, sorotan file aktif, pembaruan otomatis saat file ditambah/dihapus di disk, serta folder dari argumen dan dari pengaturan
- **Dokumen contoh lengkap**: membuka `tests/samples/semua-format.md`, lalu memeriksa tag setiap format, kasus-kasus sulit, dan hasil ekspor HTML-nya
- **Ketahanan**: kursor disapu ke semua baris, mengetik di tiap baris, dan dokumen dihapus sedikit demi sedikit untuk mencari crash

Opsi tambahan, dijalankan setelah `npm run build`:

```bash
gjs -m dist/run-tests.js --mouse
```

| Opsi | Fungsi |
| --- | --- |
| `--no-gui` | Hanya tes konversi, tanpa membuka jendela |
| `--mouse` | Tambah klik mouse sungguhan lewat XTest (pointer akan bergerak sendiri) |
| `--screenshot=file.png` | Simpan tangkapan layar jendela editor |

Tes memakai folder pengaturan sementara, jadi pengaturan Anda tidak tersentuh.

### File contoh

[`tests/samples/semua-format.md`](tests/samples/semua-format.md) berisi semua format yang didukung beserta kasus-kasus sulit: penekanan bersarang, escape, URL bergaris bawah, emoji dan teks non-Latin, tabel tanpa pipa di tepi, blok kode empat backtick, serta penekanan yang tidak ditutup. Buka di editor untuk memeriksa tampilannya secara manual:

```bash
gjs -m dist/nyerat.js tests/samples/semua-format.md
```

File ini juga dipakai oleh tes otomatis, jadi jika menambah format baru, tambahkan juga contohnya di sini.

## Arsitektur

### Struktur folder

```
package.json              script npm dan dependensi pengembangan
tsconfig.json             pengaturan pemeriksaan tipe TypeScript
vite.config.ts            pengaturan build Vite
dist/                     hasil build (tidak masuk git)
src/
├── main.ts               titik masuk: hanya memanggil main() dari app.ts
├── env.d.ts              tipe untuk GJS dan modul gi:// (dari paket @girs)
├── app.ts                membuat Gtk.Application dan jendela
├── window.ts             MainWindow: menyusun komponen + buka/simpan/ekspor
├── actions.ts            semua aksi menu dan shortcut keyboard
├── config.ts             nama, ID, versi aplikasi, dan font
├── settings.ts           baca/tulis ~/.config/nyerat/settings.json
├── files.ts              baca/tulis file teks UTF-8
├── welcome.ts            dokumen contoh saat pertama dibuka
│
├── markdown/             memahami Markdown (TypeScript murni, tanpa GTK)
│   ├── syntax.ts         regex untuk heading, daftar, kutipan, tabel, penekanan
│   ├── inline.ts         parseInline(): format di dalam satu baris
│   └── html.ts           markdownToHtml(): untuk Ekspor HTML
│
├── editor/               mesin editor ala Typora
│   ├── view.ts           MarkdownView: widget editor, menyatukan modul di bawah
│   ├── tags.ts           gaya teks (GtkTextTag) dan warnanya
│   ├── highlighter.ts    memasang tag sesuai sintaks, mengumpulkan marker
│   ├── decorations.ts    menyembunyikan marker, meredupkan (mode fokus)
│   ├── editing.ts        perintah format: tebal, tautan, heading, kutipan
│   ├── lists.ts          Enter dan Tab di daftar dan kutipan
│   ├── clicks.ts         klik kotak tugas, membaca URL tautan
│   ├── images.ts         menampilkan gambar di bawah barisnya
│   └── offsets.ts        konversi posisi UTF-16 ↔ code point
│
└── ui/                   komponen antarmuka
    ├── headerbar.ts      tombol dan menu ☰
    ├── sidebar.ts        sidebar bertab: Berkas dan Outline
    ├── filetree.ts       tab Berkas: pohon folder, dipantau dengan Gio.FileMonitor
    ├── outline.ts        tab Outline: daftar heading
    ├── findbar.ts        bilah pencarian
    ├── statusbar.ts      hitungan kata, posisi kursor, pesan singkat
    ├── dialogs.ts        pilih file, konfirmasi simpan, error, tentang
    └── theme.ts          palet warna, font, CSS terang/gelap
tests/
├── run-tests.ts          tes otomatis
└── samples/
    ├── semua-format.md   dokumen berisi semua format, untuk tes dan pemeriksaan manual
    └── gambar/contoh.png gambar lokal yang dirujuk dokumen itu
```

### Build: TypeScript + Vite

Vite dipakai sebagai **bundler** saja (mode library di [`vite.config.ts`](vite.config.ts)). Dev server dan HMR-nya tidak dipakai, karena ini aplikasi GTK yang dijalankan GJS, bukan halaman web.

```
src/main.ts ─────────┐                        ┌─► dist/nyerat.js         (aplikasi)
                     ├─► tsc --noEmit ─► vite ┼─► dist/run-tests.js      (tes)
tests/run-tests.ts ──┘   (cek tipe)   (bundel)└─► dist/chunks/window.js  (kode bersama)
```

- **Dua langkah build.** Vite (lewat esbuild) hanya membuang anotasi tipe tanpa memeriksanya. Karena itu `npm run build` menjalankan `tsc --noEmit` lebih dulu, dan build berhenti jika ada kesalahan tipe.
- **Modul bawaan GJS ditandai `external`**: `gi://...`, `system`, `gettext`, `cairo`, dan `console`. Modul-modul ini disediakan GJS saat runtime, jadi tidak ikut dibundel dan tidak dicari di `node_modules`.
- **Target `firefox115`**, karena GJS 1.80 memakai mesin JavaScript SpiderMonkey 115.
- **Tipe untuk GTK, GLib, dan lainnya** berasal dari paket `@girs/*` (proyek ts-for-gir). Paket-paket itu didaftarkan di [`src/env.d.ts`](src/env.d.ts), sehingga `import Gtk from 'gi://Gtk?version=3.0'` dikenali TypeScript. Paket ini hanya dipakai saat pengecekan tipe dan tidak ikut ke `dist/`.
- **Import antarmodul tetap memakai akhiran `.js`** (misalnya `'./tags.js'`), meskipun filenya `.ts`. TypeScript dan Vite sama-sama memetakannya ke file `.ts`.
- **Satu pengecualian tipe di `editor/view.ts`.** Tipe `@girs` menyebut parameter sinyal `key-press-event` sebagai `EventKey`, yaitu struct tanpa method. Padahal saat runtime GJS memberikan `Gdk.Event` yang punya `get_keyval()` dan sejenisnya. Karena itu event tersebut di-*cast* ke `Gdk.Event`.

### Lapisan dan arah ketergantungan

Kode dibagi menjadi lapisan. Setiap lapisan hanya boleh memakai lapisan di bawahnya, tidak pernah ke atas:

```
 app.ts
   └─ window.ts ── actions.ts
        ├─ ui/*            komponen antarmuka
        ├─ editor/*        mesin editor
        │    └─ markdown/* aturan Markdown (tanpa GTK)
        └─ settings.ts, files.ts, config.ts
```

- **`markdown/`** tidak meng-import GTK sama sekali. Isinya hanya fungsi string → data, jadi paling mudah dipelajari dan diuji.
- **`editor/`** tidak tahu apa-apa soal file, menu, atau sidebar. `MarkdownView` hanya memberi kabar lewat callback (`onHighlighted`, `onCursorMoved`, `onMessage`).
- **`ui/`** berisi komponen yang berdiri sendiri. `Outline` tidak kenal editor; ia hanya menerima daftar heading dan memanggil `onJump(baris)` saat diklik. Begitu juga `FileTree`: ia hanya menampilkan folder dan memanggil `onOpenFile(path)`; yang memutuskan cara membuka file (termasuk bertanya dulu jika ada perubahan belum disimpan) adalah jendela.
- **`window.ts`** adalah satu-satunya tempat komponen saling dihubungkan. Contoh: setelah penyorotan, editor memanggil `onHighlighted`, lalu jendela meneruskan heading ke `Outline` dan teks ke `StatusBar`.

### Alur kerja editor

Ada dua siklus utama di `editor/view.ts`:

```
Teks berubah ───► queueHighlight() ───► highlight()
                                          ├─ highlighter.ts   pasang tag gaya,
                                          │                   kumpulkan marker + heading
                                          ├─ images.ts        tampilkan gambar yang ditemukan
                                          ├─ onHighlighted()  → outline, status bar
                                          └─ updateCursor(true)

Kursor pindah ──► queueCursorUpdate() ──► updateCursor()
                                          ├─ decorations.ts   sembunyikan marker di luar
                                          │                   baris aktif, redupkan (fokus)
                                          └─ onCursorMoved()  → status bar
```

Keduanya ditunda dengan `GLib.idle_add(PRIORITY_HIGH_IDLE)`. Beberapa perubahan beruntun (misalnya saat menempel teks) digabung jadi satu proses, dan prosesnya selesai sebelum GTK menggambar ulang layar sehingga tidak berkedip.

### Cara kerja efek "ala Typora"

1. **`highlighter.ts`** membaca dokumen baris per baris. Untuk setiap sintaks, ia memasang tag gaya pada isinya (misalnya `bold` pada "tebal" di `**tebal**`) dan mencatat posisi penandanya (`**`) sebagai **marker**.
2. Setiap marker menyimpan rentang baris tempat ia "aktif": `[awal, akhir, barisPertama, barisTerakhir]`. Untuk format inline, rentangnya hanya barisnya sendiri. Untuk pembatas ```` ``` ````, rentangnya seluruh blok kode, jadi pembatas muncul selama kursor ada di dalam blok.
3. **`decorations.ts`** memasang tag `hidden` pada semua marker yang rentang barisnya tidak memuat kursor. Begitu kursor pindah baris, hanya langkah ini yang diulang; penyorotan penuh tidak perlu dijalankan lagi.

`parseInline()` di `markdown/inline.ts` memakai teknik **masking**: setelah suatu bagian dikenali (misalnya kode inline), karakternya diganti `\0` agar tidak dikenali lagi oleh pola berikutnya. Itu sebabnya `` `**bukan tebal**` `` tetap tampil sebagai kode.

### Hal teknis yang perlu diketahui

**Posisi teks (`editor/offsets.ts`).** GtkTextBuffer menghitung posisi per karakter Unicode, sedangkan string JavaScript menghitung per unit UTF-16. Emoji 🎉 bernilai 1 di GTK tetapi 2 di JavaScript. Penyorot bekerja dengan posisi JavaScript, lalu mengonversinya dengan `makeCpMap()` tepat sebelum menyentuh buffer.

**Menyembunyikan teks tanpa `invisible` (`editor/tags.ts`).** Atribut `invisible` milik GtkTextView di GTK 3 bisa memicu crash *"Byte index is off the end of the line"*. Karena itu tag `hidden` membuat teks sangat kecil (`size: 1`) dan berwarna sama dengan latar. Hasilnya di layar sama, tapi jalur kode GTK yang bermasalah tidak tersentuh.

**Kolom teks di tengah (`editor/view.ts`).** Margin kiri/kanan dihitung dari lebar ScrolledWindow, dan ScrolledWindow memakai `hscrollbar_policy: EXTERNAL`, bukan `NEVER`. Lebar minimum GtkTextView yang dibungkus sama dengan lebarnya saat ini ditambah margin. Dengan `NEVER`, lebar minimum itu diteruskan ke jendela, sehingga jendela tidak bisa mengecil dan terus membesar setiap margin dihitung ulang.

### Cara kerja gambar (`editor/images.ts`)

Gambar tidak dimasukkan ke buffer teks. Jika memakai `GtkTextChildAnchor`, setiap gambar akan menambah karakter ke dokumen dan ke riwayat undo. Sebagai gantinya:

1. `highlighter.ts` mencatat setiap gambar beserta barisnya: `{ line, url, alt }`.
2. `ImageLayer` memuat gambar secara async lewat GIO (file lokal, atau http/https lewat gvfs) dan menyimpannya di cache per URI. Mengetik tidak memuat ulang gambar yang sama.
3. Di bawah baris gambar disediakan ruang kosong dengan tag `pixels_below_lines` setinggi gambarnya.
4. Widget gambar ditempel di atas ruang itu dengan `add_child_in_window()`. Posisinya dalam koordinat buffer sehingga ikut bergulir, dan dihitung ulang dari `get_line_yrange()` setiap kali tata letak berubah.
5. Widget dicocokkan berdasarkan URI, bukan nomor baris. Jika ada baris baru di atasnya, widget yang sama hanya dipindahkan, tidak dibuat ulang.

Seperti format lain, seluruh `![alt](url)` didaftarkan sebagai marker, jadi sintaksnya tersembunyi kecuali di baris aktif.

### Urutan membaca kode

Untuk mempelajari kodenya, urutan berikut bergerak dari yang paling sederhana:

1. `src/markdown/syntax.ts` → `inline.ts` → `html.ts`: aturan Markdown, tanpa GTK
2. `src/editor/tags.ts` → `highlighter.ts` → `decorations.ts`: inti efek Typora
3. `src/editor/view.ts`: bagaimana semuanya digerakkan oleh sinyal GTK
4. `src/editor/editing.ts`, `lists.ts`, `clicks.ts`: interaksi pengguna
5. `src/editor/images.ts`: menempelkan widget di atas teks
6. `src/ui/*`: komponen antarmuka
7. `src/window.ts` dan `src/actions.ts`: bagaimana semuanya disatukan
8. `tests/run-tests.ts`: contoh pemakaian setiap bagian

### Menambah fitur

Contoh menambah format baru, misalnya `^superskrip^`:

1. Tambahkan pola di `EMPHASIS` (`src/markdown/syntax.ts`), misalnya `['sup', /(\^)(?=\S)([\s\S]*?\S)\^/g, 1]`, lalu tambahkan `'sup'` ke tipe `EmphasisTag` di file yang sama
2. Tambahkan tag `sup` di `TAG_DEFS` (`src/editor/tags.ts`), misalnya `{ rise: 4000, scale: 0.8 }`
3. Tambahkan konversinya di `emphHtml()` (`src/markdown/html.ts`)
4. Jika perlu shortcut, daftarkan di `src/actions.ts`: `action('sup', ['<Control><Shift>p'], () => wrapSelection(buf, '^'))`
5. Tambahkan contohnya di `tests/samples/semua-format.md` dan tesnya di `tests/run-tests.ts`

## Pengaturan

Disimpan di `~/.config/nyerat/settings.json`: mode gelap, sidebar dan tab yang terakhir dipilih, folder yang terakhir dibuka, mode fokus, mode typewriter, dan ukuran jendela.

## Keterbatasan

- Gambar yang diubah di disk tidak dimuat ulang sampai aplikasi dibuka lagi (ada cache per URI); GIF animasi hanya menampilkan frame pertama
- Gambar di dalam tabel tidak ditampilkan, dan gambar di dalam daftar atau kutipan tidak ikut menjorok
- Kode di dalam blok kode belum diwarnai sesuai bahasanya
- Tabel masih berupa teks monospace, belum jadi grid yang bisa diedit
- Garis pemisah tampil sebagai teks `---` pudar di tengah, bukan garis
- Kutipan bersarang (`>>`) tidak ditampilkan lebih menjorok dari kutipan biasa
- Penyorotan memproses ulang seluruh dokumen setiap kali teks berubah, sehingga dokumen yang sangat panjang (puluhan ribu baris) bisa terasa lambat
