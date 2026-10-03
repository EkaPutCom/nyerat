# Nyerat

Editor Markdown ala [Typora](https://typora.io) untuk desktop Linux, dibuat dengan **GTK 3**, **GtkSourceView 4**, dan **GJS** (JavaScript untuk GNOME).

Tidak ada panel pratinjau terpisah: teks langsung tampil terformat. Sintaks Markdown seperti `#`, `**`, `` ` `` dan `[](url)` disembunyikan, lalu muncul lagi saat kursor berada di baris tersebut.

## Kebutuhan

- Linux dengan desktop X11 atau Wayland
- GJS (diuji dengan versi 1.80)
- GTK 3 dan GtkSourceView 4 (biasanya sudah terpasang di desktop GNOME)

Di Ubuntu/Debian:

```bash
sudo apt install gjs gir1.2-gtk-3.0 gir1.2-gtksource-4
```

Tidak perlu compile, Node.js, atau npm.

## Menjalankan

```bash
gjs -m nyerat.js
```

Membuka file tertentu (file yang belum ada akan dibuat saat disimpan):

```bash
gjs -m nyerat.js catatan.md
```

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
- Sidebar outline berisi daftar heading; klik untuk melompat
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
| Ctrl+\ atau Ctrl+Shift+1 | Tampilkan/sembunyikan outline |
| Ctrl+/ | Mode source |
| F8 | Mode fokus |
| F9 | Mode typewriter |
| Ctrl+Shift+D | Mode gelap |

## Tes

```bash
gjs -m tests/run-tests.js
```

Tes ditulis dengan GJS saja, tanpa framework tambahan, dan keluar dengan kode `1` jika ada yang gagal. Isinya:

- **Konversi** Markdown → HTML dan pengurai format inline, tanpa GUI
- **Editor**: membuka jendela sungguhan, lalu memeriksa sintaks yang disembunyikan/ditampilkan, Enter dan Tab di daftar, shortcut format, undo, klik kotak tugas, serta simpan dan buka file
- **Dokumen contoh lengkap**: membuka `tests/samples/semua-format.md`, lalu memeriksa tag setiap format, kasus-kasus sulit, dan hasil ekspor HTML-nya
- **Ketahanan**: kursor disapu ke semua baris, mengetik di tiap baris, dan dokumen dihapus sedikit demi sedikit untuk mencari crash

### File contoh

[`tests/samples/semua-format.md`](tests/samples/semua-format.md) berisi semua format yang didukung beserta kasus-kasus sulit: penekanan bersarang, escape, URL bergaris bawah, emoji dan teks non-Latin, tabel tanpa pipa di tepi, blok kode empat backtick, serta penekanan yang tidak ditutup. Buka di editor untuk memeriksa tampilannya secara manual:

```bash
gjs -m nyerat.js tests/samples/semua-format.md
```

File ini juga dipakai oleh tes otomatis, jadi jika menambah format baru, tambahkan juga contohnya di sini.

| Opsi | Fungsi |
| --- | --- |
| `--no-gui` | Hanya tes konversi, tanpa membuka jendela |
| `--mouse` | Tambah klik mouse sungguhan lewat XTest (pointer akan bergerak sendiri) |
| `--screenshot=file.png` | Simpan tangkapan layar jendela editor |

Tes memakai folder pengaturan sementara, jadi pengaturan Anda tidak tersentuh.

## Arsitektur

### Struktur folder

```
nyerat.js                 titik masuk: hanya memanggil main() dari src/app.js
src/
├── app.js                membuat Gtk.Application dan jendela
├── window.js             MainWindow: menyusun komponen + buka/simpan/ekspor
├── actions.js            semua aksi menu dan shortcut keyboard
├── config.js             nama, ID, versi aplikasi, dan font
├── settings.js           baca/tulis ~/.config/nyerat/settings.json
├── files.js              baca/tulis file teks UTF-8
├── welcome.js            dokumen contoh saat pertama dibuka
│
├── markdown/             memahami Markdown (JavaScript murni, tanpa GTK)
│   ├── syntax.js         regex untuk heading, daftar, kutipan, tabel, penekanan
│   ├── inline.js         parseInline(): format di dalam satu baris
│   └── html.js           markdownToHtml(): untuk Ekspor HTML
│
├── editor/               mesin editor ala Typora
│   ├── view.js           MarkdownView: widget editor, menyatukan modul di bawah
│   ├── tags.js           gaya teks (GtkTextTag) dan warnanya
│   ├── highlighter.js    memasang tag sesuai sintaks, mengumpulkan marker
│   ├── decorations.js    menyembunyikan marker, meredupkan (mode fokus)
│   ├── editing.js        perintah format: tebal, tautan, heading, kutipan
│   ├── lists.js          Enter dan Tab di daftar dan kutipan
│   ├── clicks.js         klik kotak tugas, membaca URL tautan
│   ├── images.js         menampilkan gambar di bawah barisnya
│   └── offsets.js        konversi posisi UTF-16 ↔ code point
│
└── ui/                   komponen antarmuka
    ├── headerbar.js      tombol dan menu ☰
    ├── outline.js        sidebar daftar heading
    ├── findbar.js        bilah pencarian
    ├── statusbar.js      hitungan kata, posisi kursor, pesan singkat
    ├── dialogs.js        pilih file, konfirmasi simpan, error, tentang
    └── theme.js          palet warna, font, CSS terang/gelap
tests/
├── run-tests.js          tes otomatis
└── samples/
    ├── semua-format.md   dokumen berisi semua format, untuk tes dan pemeriksaan manual
    └── gambar/contoh.png gambar lokal yang dirujuk dokumen itu
```

### Lapisan dan arah ketergantungan

Kode dibagi menjadi lapisan. Setiap lapisan hanya boleh memakai lapisan di bawahnya, tidak pernah ke atas:

```
 app.js
   └─ window.js ── actions.js
        ├─ ui/*            komponen antarmuka
        ├─ editor/*        mesin editor
        │    └─ markdown/* aturan Markdown (tanpa GTK)
        └─ settings.js, files.js, config.js
```

- **`markdown/`** tidak meng-import GTK sama sekali. Isinya hanya fungsi string → data, jadi paling mudah dipelajari dan diuji.
- **`editor/`** tidak tahu apa-apa soal file, menu, atau sidebar. `MarkdownView` hanya memberi kabar lewat callback (`onHighlighted`, `onCursorMoved`, `onMessage`).
- **`ui/`** berisi komponen yang berdiri sendiri. `Outline` tidak kenal editor; ia hanya menerima daftar heading dan memanggil `onJump(baris)` saat diklik.
- **`window.js`** adalah satu-satunya tempat komponen saling dihubungkan. Contoh: setelah penyorotan, editor memanggil `onHighlighted`, lalu jendela meneruskan heading ke `Outline` dan teks ke `StatusBar`.

### Alur kerja editor

Ada dua siklus utama di `editor/view.js`:

```
Teks berubah ───► queueHighlight() ───► highlight()
                                          ├─ highlighter.js   pasang tag gaya,
                                          │                   kumpulkan marker + heading
                                          ├─ images.js        tampilkan gambar yang ditemukan
                                          ├─ onHighlighted()  → outline, status bar
                                          └─ updateCursor(true)

Kursor pindah ──► queueCursorUpdate() ──► updateCursor()
                                          ├─ decorations.js   sembunyikan marker di luar
                                          │                   baris aktif, redupkan (fokus)
                                          └─ onCursorMoved()  → status bar
```

Keduanya ditunda dengan `GLib.idle_add(PRIORITY_HIGH_IDLE)`. Beberapa perubahan beruntun (misalnya saat menempel teks) digabung jadi satu proses, dan prosesnya selesai sebelum GTK menggambar ulang layar sehingga tidak berkedip.

### Cara kerja efek "ala Typora"

1. **`highlighter.js`** membaca dokumen baris per baris. Untuk setiap sintaks, ia memasang tag gaya pada isinya (misalnya `bold` pada "tebal" di `**tebal**`) dan mencatat posisi penandanya (`**`) sebagai **marker**.
2. Setiap marker menyimpan rentang baris tempat ia "aktif": `[awal, akhir, barisPertama, barisTerakhir]`. Untuk format inline, rentangnya hanya barisnya sendiri. Untuk pembatas ```` ``` ````, rentangnya seluruh blok kode, jadi pembatas muncul selama kursor ada di dalam blok.
3. **`decorations.js`** memasang tag `hidden` pada semua marker yang rentang barisnya tidak memuat kursor. Begitu kursor pindah baris, hanya langkah ini yang diulang; penyorotan penuh tidak perlu dijalankan lagi.

`parseInline()` di `markdown/inline.js` memakai teknik **masking**: setelah suatu bagian dikenali (misalnya kode inline), karakternya diganti `\0` agar tidak dikenali lagi oleh pola berikutnya. Itu sebabnya `` `**bukan tebal**` `` tetap tampil sebagai kode.

### Hal teknis yang perlu diketahui

**Posisi teks (`editor/offsets.js`).** GtkTextBuffer menghitung posisi per karakter Unicode, sedangkan string JavaScript menghitung per unit UTF-16. Emoji 🎉 bernilai 1 di GTK tetapi 2 di JavaScript. Penyorot bekerja dengan posisi JavaScript, lalu mengonversinya dengan `makeCpMap()` tepat sebelum menyentuh buffer.

**Menyembunyikan teks tanpa `invisible` (`editor/tags.js`).** Atribut `invisible` milik GtkTextView di GTK 3 bisa memicu crash *"Byte index is off the end of the line"*. Karena itu tag `hidden` membuat teks sangat kecil (`size: 1`) dan berwarna sama dengan latar. Hasilnya di layar sama, tapi jalur kode GTK yang bermasalah tidak tersentuh.

**Kolom teks di tengah (`editor/view.js`).** Margin kiri/kanan dihitung dari lebar ScrolledWindow, dan ScrolledWindow memakai `hscrollbar_policy: EXTERNAL`, bukan `NEVER`. Lebar minimum GtkTextView yang dibungkus sama dengan lebarnya saat ini ditambah margin. Dengan `NEVER`, lebar minimum itu diteruskan ke jendela, sehingga jendela tidak bisa mengecil dan terus membesar setiap margin dihitung ulang.

### Cara kerja gambar (`editor/images.js`)

Gambar tidak dimasukkan ke buffer teks. Jika memakai `GtkTextChildAnchor`, setiap gambar akan menambah karakter ke dokumen dan ke riwayat undo. Sebagai gantinya:

1. `highlighter.js` mencatat setiap gambar beserta barisnya: `{ line, url, alt }`.
2. `ImageLayer` memuat gambar secara async lewat GIO (file lokal, atau http/https lewat gvfs) dan menyimpannya di cache per URI. Mengetik tidak memuat ulang gambar yang sama.
3. Di bawah baris gambar disediakan ruang kosong dengan tag `pixels_below_lines` setinggi gambarnya.
4. Widget gambar ditempel di atas ruang itu dengan `add_child_in_window()`. Posisinya dalam koordinat buffer sehingga ikut bergulir, dan dihitung ulang dari `get_line_yrange()` setiap kali tata letak berubah.
5. Widget dicocokkan berdasarkan URI, bukan nomor baris. Jika ada baris baru di atasnya, widget yang sama hanya dipindahkan, tidak dibuat ulang.

Seperti format lain, seluruh `![alt](url)` didaftarkan sebagai marker, jadi sintaksnya tersembunyi kecuali di baris aktif.

### Urutan membaca kode

Untuk mempelajari kodenya, urutan berikut bergerak dari yang paling sederhana:

1. `src/markdown/syntax.js` → `inline.js` → `html.js`: aturan Markdown, tanpa GTK
2. `src/editor/tags.js` → `highlighter.js` → `decorations.js`: inti efek Typora
3. `src/editor/view.js`: bagaimana semuanya digerakkan oleh sinyal GTK
4. `src/editor/editing.js`, `lists.js`, `clicks.js`: interaksi pengguna
5. `src/editor/images.js`: menempelkan widget di atas teks
6. `src/ui/*`: komponen antarmuka
7. `src/window.js` dan `src/actions.js`: bagaimana semuanya disatukan
8. `tests/run-tests.js`: contoh pemakaian setiap bagian

### Menambah fitur

Contoh menambah format baru, misalnya `^superskrip^`:

1. Tambahkan pola di `EMPHASIS` (`src/markdown/syntax.js`), misalnya `['sup', /(\^)(?=\S)([\s\S]*?\S)\^/g, 1]`
2. Tambahkan tag `sup` di `TAG_DEFS` (`src/editor/tags.js`), misalnya `{ rise: 4000, scale: 0.8 }`
3. Tambahkan konversinya di `emphHtml()` (`src/markdown/html.js`)
4. Jika perlu shortcut, daftarkan di `src/actions.js`: `action('sup', ['<Control><Shift>p'], () => wrapSelection(buf, '^'))`
5. Tambahkan contohnya di `tests/samples/semua-format.md` dan tesnya di `tests/run-tests.js`

## Pengaturan

Disimpan di `~/.config/nyerat/settings.json`: mode gelap, sidebar, mode fokus, mode typewriter, dan ukuran jendela.

## Keterbatasan

- Gambar yang diubah di disk tidak dimuat ulang sampai aplikasi dibuka lagi (ada cache per URI); GIF animasi hanya menampilkan frame pertama
- Gambar di dalam tabel tidak ditampilkan, dan gambar di dalam daftar atau kutipan tidak ikut menjorok
- Kode di dalam blok kode belum diwarnai sesuai bahasanya
- Tabel masih berupa teks monospace, belum jadi grid yang bisa diedit
- Garis pemisah tampil sebagai teks `---` pudar di tengah, bukan garis
- Kutipan bersarang (`>>`) tidak ditampilkan lebih menjorok dari kutipan biasa
- Penyorotan memproses ulang seluruh dokumen setiap kali teks berubah, sehingga dokumen yang sangat panjang (puluhan ribu baris) bisa terasa lambat
