# Nyerat

Editor Markdown ala [Typora](https://typora.io) untuk desktop Linux, dibuat dengan **GTK 3**, **GtkSourceView 4**, dan **GJS** (JavaScript untuk GNOME). Kodenya ditulis dalam **TypeScript** dan dibundel dengan **Vite**.

Tidak ada panel pratinjau terpisah: teks langsung tampil terformat. Sintaks Markdown seperti `#`, `**`, `` ` `` dan `[](url)` disembunyikan, lalu muncul lagi saat kursor berada di baris tersebut.

Landing page-nya ada di [`docs/`](docs/index.html) (HTML statis; aktifkan GitHub Pages dari folder `/docs` pada branch `main` untuk menayangkannya). Tangkapan layar dibuat oleh [`scripts/capture.ts`](scripts/capture.ts).

## Kebutuhan

- Linux dengan desktop X11 atau Wayland
- GJS (diuji dengan versi 1.80)
- GTK 3 dan GtkSourceView 4 (biasanya sudah terpasang di desktop GNOME)
- WebKitGTK 4.1 dengan binding GObject Introspection (`gir1.2-webkit2-4.1` di Debian/Ubuntu), **hanya untuk diagram Mermaid dan DBML**; tanpanya aplikasi tetap berjalan dan diagram menampilkan pesan galat
- Node.js 20.19+ pada seri 20, atau 22.12+ (syarat Vite), **hanya untuk build** (diuji dengan Node.js 24). Aplikasinya sendiri dijalankan GJS, bukan Node.js.

Di Ubuntu/Debian:

```bash
sudo apt install gjs gir1.2-gtk-3.0 gir1.2-gtksource-4
```

Untuk diagram, tambahkan dependensi opsional:

```bash
sudo apt install gir1.2-webkit2-4.1
```

Gambar dari internet dimuat melalui GIO dan memerlukan backend HTTP/HTTPS GVfs yang tersedia pada sistem.

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

Aplikasi memakai argumen pertama yang bukan opsi sebagai path file atau folder. Setiap pemanggilan membuka proses dan jendela sendiri. Pada pembukaan pertama tanpa file, editor menampilkan dokumen contoh; pembukaan berikutnya dimulai dengan dokumen kosong.

Atau membuka sebuah folder, yang isinya tampil di tab Berkas:

```bash
gjs -m dist/nyerat.js ~/catatan
```

| Perintah | Fungsi |
| --- | --- |
| `npm run build` | Periksa tipe (`tsc --noEmit`), lalu bundel dengan Vite ke `dist/` |
| `npm run dev` | Mode pengembangan: build ulang, periksa tipe, dan buka ulang aplikasi setiap file disimpan |
| `npm run watch` | Hanya build ulang otomatis setiap file disimpan, tanpa membuka aplikasi dan tanpa pemeriksaan tipe |
| `npm run typecheck` | Hanya periksa tipe |
| `npm start` | Build, lalu jalankan aplikasi |
| `npm test` | Build, lalu jalankan semua tes unit, GUI, dan mouse kanban di Xvfb |
| `npm run test:ui` | Build, lalu jalankan rangkaian tes yang sama di desktop X11 |
| `npm run bench` | Build, lalu ukur performa modul Markdown dan editor (setText, penyorotan, mengetik) di Xvfb; opsi: `--size=`, `--runs=`, `--budget=`, `--no-gui` |
| `npm run bench:save` | Jalankan benchmark dan simpan hasilnya ke `bench/<tanggal-waktu>.json` |
| `npm run bench:compare` | Jalankan benchmark dan tampilkan selisih terhadap [`bench/baseline.json`](bench/baseline.json) (hijau = lebih cepat, merah = lebih lambat, abu-abu = selisih < 25%, derau pengukuran) |
| `npm run docs` | Potret aplikasi sungguhan (jendela akan terbuka sebentar), lalu perbarui PNG dan GIF di `docs/assets/` untuk landing page |

Hasil optimasi dan batas cakupannya dicatat di [laporan performa](bench/PERFORMANCE.md).

Benchmark memakai 10 pengulangan setelah pemanasan. Hasil menampilkan median, p95,
dan maksimum dalam milidetik; `--save=...` menyimpan sampel mentah, commit, serta versi
GJS/GLib/GTK dan lingkungan. `--compare=...` hanya membandingkan format, ukuran,
pengulangan, jenis dokumen, mode, dan lingkungan yang setara. Baseline format lama perlu dibuat ulang.

Skenario GUI mencakup membuka teks, penyorotan ulang, mengetik (total 20 karakter dan
latensi per karakter), perpindahan kursor, paste besar dengan emoji dan baris panjang,
hapus, undo, serta redo. Setiap suntingan diverifikasi melalui callback penyorotan.
`--budget=...` berlaku pada median operasi GUI; untuk mengetik, budget berlaku per
karakter. Kegagalan pengukuran mengembalikan kode 1 dan mencegah penyimpanan hasil
parsial; hasil lengkap yang melampaui budget tetap dapat disimpan untuk diagnosis.
Tiap proses GUI dibatasi 120 detik (`--timeout=...`), menggunakan `timeout` dari
GNU coreutils, agar callback yang terblokir GC tidak membuat runner menunggu tanpa batas.
Ukuran GUI dapat diatur dengan `--sizes=25,50,100`; `--size` mengatur ukuran modul
Markdown. `--fixture=long --size=2000 --sizes=2000` menguji dokumen 20.000 baris
tanpa grid tabel; jenis dokumen bawaan adalah `mixed`. Rendering gambar/diagram asinkron dan interaksi papan kanban belum diukur;
kanban saat ini mencakup parsing dan serialisasi model.

### Mode pengembangan

```bash
npm run dev
```

Setiap ada file di `src/` atau `tests/` yang disimpan, `npm run dev` mem-build ulang lalu menutup dan membuka lagi aplikasinya. GJS tidak bisa memuat ulang kode yang sedang berjalan (tidak ada HMR seperti di browser), jadi membuka ulang aplikasi adalah cara untuk melihat perubahan. Bersamaan dengan itu, `tsc --watch` memeriksa tipe dan melaporkan kesalahannya di terminal yang sama dengan label `[tipe]`.

- Jika build gagal (misalnya ada kesalahan sintaks), aplikasi yang lama tetap berjalan sampai kesalahannya diperbaiki.
- Kesalahan tipe hanya dilaporkan, tidak menghentikan build. Vite tetap bisa mem-build kode yang tipenya salah, jadi aplikasi tetap dibuka ulang. Perhatikan baris `[tipe]` di terminal.
- Argumen setelah `--` diteruskan ke aplikasi, misalnya `npm run dev -- catatan.md` atau `npm run dev -- ~/catatan`.
- **Perubahan di editor yang belum disimpan hilang** setiap kali aplikasi dibuka ulang.
- `Ctrl+C` menghentikan semuanya (build, pemeriksaan tipe, dan aplikasi).

Script-nya ada di [`scripts/dev.mjs`](scripts/dev.mjs). Script ini memakai API `build()` milik Vite dalam mode watch, lalu membuka ulang aplikasi setiap event `END`, kecuali jika putaran build itu gagal.

## Fitur

**Penulisan ala Typora**
- Heading, **tebal**, *miring*, ~~coret~~, ==stabilo==, `kode inline`, tautan, dan gambar langsung tampil terformat
- Blok kode, kutipan, dan garis pemisah diberi gaya (kutipan bersarang `>>` makin menjorok, sampai tiga tingkat); baris pembatas ```` ``` ```` disembunyikan di luar blok
- **Papan kanban ala Trello.** File Markdown yang frontmatter-nya memuat `kanban: true` dibuka sebagai papan: heading `##` menjadi daftar, item `- [ ]` menjadi kartu. Seret kartu antar daftar (atau ke posisi lain di daftar yang sama), klik kartu untuk menyunting judul dan catatannya, klik kanan untuk menu (pindahkan, naik/turun, hapus), centang untuk menandai selesai, dan tambah kartu/daftar langsung di papan. `#tag` tampil sebagai label berwarna dan `@{2026-10-20}` sebagai tanggal (merah jika lewat batas). Semua perubahan ditulis ke teks Markdown-nya, dan penanda lama `kanban-plugin:` dari plugin Kanban Obsidian tetap dikenali. `Ctrl+Shift+B` beralih ke tampilan teks dan kembali; menu ☰ → *Papan Kanban Baru* membuat papan kosong
- **Tabel dirender sebagai grid** (garis sel, header tebal, rata kiri/tengah/kanan, dan **tebal**/*miring*/`kode`/tautan di dalam sel). Saat kursor masuk ke tabel, teks mentahnya muncul untuk disunting; klik sebuah sel di grid untuk langsung menyunting sel itu. Tabel yang lebih lebar dari kolom teks dipersempit dan teks yang terpotong diberi "…" (isi lengkapnya muncul sebagai tooltip)
- Di dalam tabel: `Tab` / `Shift+Tab` pindah antar sel (di sel terakhir, `Tab` menambah baris), `Enter` pindah ke baris berikutnya (di baris kosong terakhir, `Enter` keluar dari tabel). Menu ☰ → **Edit Tabel** untuk tambah/hapus baris dan kolom, rata kiri/tengah/kanan, dan merapikan kolom
- Isi blok kode diwarnai sesuai bahasanya (```` ```js ````, ```` ```python ````, ```` ```rust ````, dan ratusan bahasa lain dari GtkSourceView), dengan skema warna yang mengikuti mode terang/gelap
- **Diagram Mermaid.** Blok ```` ```mermaid ```` dirender sebagai diagram (flowchart, sequence, class, state, ER, gantt, pie, dan jenis lain yang didukung Mermaid). Saat kursor di luar blok hanya diagramnya yang terlihat; saat kursor masuk, kodenya muncul dan diagram menjadi pratinjau di bawahnya yang ikut berubah selagi mengetik. Kode yang salah tidak disembunyikan, pesan galatnya muncul di bawah blok. Klik ganda memperbesar diagram, dan warnanya mengikuti mode terang/gelap. Diagram dirender secara lokal (tanpa internet); ekspor HTML memuat Mermaid dari CDN sehingga diagram di file hasil ekspor butuh internet
- **Diagram DBML (dbdiagram).** Blok ```` ```dbml ```` (bahasa skema dbdiagram.io) digambar sebagai diagram ER dengan perilaku yang sama seperti Mermaid. Yang didukung: `Table` (alias, `pk`, `unique`, `note`, `ref:` di dalam kolom, `indexes`), `Ref` satu baris maupun blok dengan relasi `>` `<` `-` `<>`, dan `Enum`/`TableGroup`/`Project`/`Note` yang dilewati. Kolom di sisi "banyak" suatu relasi otomatis bertanda FK. Galat sintaks muncul seketika beserta nomor barisnya. Ekspor HTML menulisnya sebagai diagram ER Mermaid
- Daftar tugas `- [ ]` bisa dicentang dengan mengklik kotaknya
- Tautan dibuka dengan **Ctrl+klik** (path relatif dihitung dari folder file)
- Gambar `![alt](url)` ditampilkan langsung di bawah barisnya, dari file lokal (path relatif dihitung dari folder dokumen) maupun dari internet. Klik gambar untuk memunculkan sintaksnya; **klik ganda** (atau menu ☰ → *Perbesar Gambar* untuk gambar di baris kursor) membuka penampil dengan zoom: roda mouse memperbesar di titik penunjuk, `+`/`−`, `0` untuk 100%, `F` atau tombol *Pas* untuk pas layar, geser dengan drag, `Esc` menutup
- Enter melanjutkan daftar, daftar bernomor, daftar tugas, dan kutipan secara otomatis; Enter di item kosong mengakhirinya
- Tab / Shift+Tab mengatur indentasi item daftar

**Tampilan**
- Sidebar dengan dua tab:
  - **Berkas**: pohon folder yang dibuka (lewat tombol folder di header bar, `Ctrl+Shift+O`, atau dengan memilih folder di dialog Buka File), berisi subfolder dan file Markdown (`.md`, `.markdown`, `.mdown`, `.mkd`). Klik file untuk membukanya; file yang sedang dibuka ikut disorot. File/folder tersembunyi dan `node_modules` tidak ditampilkan. Pohon diperbarui otomatis saat ada file yang ditambah atau dihapus di disk, dan folder terakhir dibuka lagi saat aplikasi dijalankan
  - **Outline**: daftar heading dokumen; klik untuk melompat
- Mode fokus: paragraf selain yang sedang disunting diredupkan
- Mode typewriter: baris aktif selalu di tengah layar
- Mode source: semua sintaks Markdown ditampilkan; widget gambar, grid tabel, dan diagram disembunyikan
- Mode gelap, otomatis mengikuti tema sistem saat pertama dibuka
- Kolom teks dibuat di tengah dengan lebar baca yang nyaman

**Lainnya**
- Cari teks, undo/redo, hitungan kata dan karakter, posisi kursor
- Ekspor ke HTML dengan CSS disertakan. Gambar dan tautan tetap memakai URL/path aslinya; diagram Mermaid/DBML memerlukan internet untuk memuat Mermaid dari CDN
- **Auto save** (menu ☰ → *Auto Save*, aktif bawaan): dokumen yang sudah punya file disimpan otomatis 1 detik setelah berhenti mengetik, dan disimpan tanpa bertanya saat menutup, membuat dokumen baru, atau membuka file lain. Dokumen yang belum pernah disimpan tetap butuh Ctrl+S
- Peringatan sebelum menutup, membuat dokumen baru, atau membuka file lain jika ada perubahan yang belum disimpan (saat auto save mati atau dokumen belum punya file)

## Shortcut

| Shortcut | Fungsi |
| --- | --- |
| Ctrl+N / Ctrl+O | Dokumen baru / buka file |
| Ctrl+Shift+O | Buka folder |
| Ctrl+S / Ctrl+Shift+S | Simpan / simpan sebagai |
| Ctrl+Shift+E | Ekspor HTML |
| Ctrl+F | Cari |
| Ctrl+Z / Ctrl+Shift+Z atau Ctrl+Y | Undo / redo (juga untuk perubahan di papan kanban) |
| Ctrl+Shift+B | Papan kanban: beralih antara tampilan papan dan teks |
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
| Tab / Shift+Tab | Pindah sel (di dalam tabel) |
| Enter | Pindah ke baris berikutnya (di dalam tabel) |
| Ctrl+Shift+T | Rapikan tabel |
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

Pasang dependensi display virtual sekali (Debian/Ubuntu):

```bash
sudo apt install xvfb xauth
```

Ada dua mode untuk menjalankan seluruh tes, termasuk lima tes mouse kanban:

```bash
npm test          # tanpa menampilkan jendela, memakai Xvfb
npm run test:ui   # tampilkan jendela dan drag kartu di desktop
```

`npm test` menjalankan seluruh tes unit, GUI, dan lima tes input mouse kanban di display **Xvfb terpisah**. Tidak membutuhkan sesi desktop; pointer desktop tidak bergerak. Jika Xvfb belum terpasang, perintah gagal dan tes mouse tidak diam-diam dilewati. `npm run docs` tetap memakai jalur capture desktop seperti sebelumnya.

`npm run test:ui` menjalankan rangkaian tes yang sama pada desktop **X11 lokal** (atau XWayland yang menyediakan `DISPLAY` lokal), sehingga jendela tes terlihat. Mode ini tidak membutuhkan Xvfb. Pointer desktop akan bergerak selama tes drag; biarkan mouse dan keyboard sampai selesai. Pointer dikembalikan ke posisi semula setelah bagian tes mouse.

Tes ditulis dalam TypeScript tanpa framework tambahan, dibundel Vite menjadi `dist/run-tests.js`, lalu dijalankan GJS. Script keluar dengan kode `1` jika ada yang gagal. Isinya:

- **Unit**: konversi Markdown → HTML, pengurai format inline, simpan/baca pengaturan, model tabel dan kanban, alias bahasa kode, serta DBML, tanpa GUI
- **Editor**: membuka jendela sungguhan, lalu memeriksa sintaks yang disembunyikan/ditampilkan, Enter dan Tab di daftar, shortcut format, undo, klik kotak tugas, serta simpan dan buka file
- **Tabel**: aturan pengenalan tabel (pemisah satu strip, tanpa pipa di tepi, berhenti di blok lain), pemecahan sel, perataan, merapikan kolom (termasuk lebar CJK dan emoji), operasi baris/kolom, konversi format inline ke markup Pango, lebar kolom; lalu di editor: grid yang muncul dan hilang mengikuti kursor, letak grid di antara paragraf, klik sel, Tab/Shift+Tab/Enter, semua perintah menu, satu perintah = satu langkah undo, mode source, serta tabel beremoji yang tidak membuat GTK gagal menggambar
- **Kanban**: model (mengenali papan, membaca dan menulis dengan hasil yang stabil, operasi kartu dan daftar, tag dan tanggal); di editor: dokumen dibuka sebagai papan, menambah/mencentang/menyunting/memindahkan lewat menu, seret kartu (jatuh di posisi yang ditunjuk, kartu bayangan dan penanda tujuan dibersihkan, tempat asal tidak mengubah apa pun), gulir otomatis di tepi, undo/redo satu langkah per perubahan, beralih ke tampilan teks dan kembali, aksi pengeditan teks ditolak saat papan tampil, dan simpan
- **Diagram Mermaid**: blok dirender menjadi gambar, kode disembunyikan di luar blok dan tampil dengan pratinjau di dalamnya, galat sintaks ditampilkan tanpa menyembunyikan kode, render ulang saat kode diubah, widget dipakai ulang saat baris bergeser, blok kosong/tidak ditutup/bukan mermaid diabaikan, mode source, dan tema gelap (warna latar gambar); serta ekspor HTML-nya
- **Diagram DBML**: penerjemah DBML → Mermaid (tabel, kolom, ref, alias, skema, galat berikut nomor barisnya), blok dbml dirender dan galatnya tampil tanpa menyembunyikan kode, serta ekspor HTML-nya
- **Zoom gambar**: gambar ukuran penuh dari `imageAt()`, klik sekali vs ganda (dengan event GDK tiruan) dan gambar yang tepat jika satu baris memuat beberapa, perintah menu; di penampil: zoom awal, kelipatan 1,25 dan batas 5%–800%, tombol, titik zoom di penunjuk, geser dengan drag, klik ganda, dan tidak ada peringatan GTK/cairo saat menggambar pada zoom besar
- **Warna blok kode**: alias nama bahasa, warna kata kunci/string/komentar, blok tanpa bahasa atau bahasa tak dikenal, pewarnaan ulang saat mengetik, emoji sebelum blok, skema terang/gelap, dan mode fokus yang tetap meredupkan blok kode
- **Folder**: isi pohon dan urutannya, file tersembunyi dan non-Markdown yang disaring, isi subfolder yang baru dibaca saat dibuka, membuka file dengan klik, sorotan file aktif, pembaruan otomatis saat file ditambah/dihapus di disk, serta folder dari argumen dan dari pengaturan
- **Dokumen contoh lengkap**: membuka `tests/samples/semua-format.md`, lalu memeriksa tag setiap format, kasus-kasus sulit, dan hasil ekspor HTML-nya
- **Ukuran jendela**: membuka file kedua tidak memperbesar jendela, jendela bisa diperbesar lalu diperkecil, dan gambar dibatasi lebar kolom teks
- **Ketahanan**: kursor disapu ke semua baris, mengetik di tiap baris, dan dokumen dihapus sedikit demi sedikit untuk mencari crash

Opsi tambahan, dijalankan setelah `npm run build`:

```bash
gjs -m dist/run-tests.js --mouse
```

Tes seret kartu lewat input mouse dari server X11 (tekan → gerak bertahap → lepas) termasuk dalam kedua mode: `npm test` dan `npm run test:ui`.

`npm test` memakai Xvfb dengan ekstensi XTest; `npm run test:ui` memakai display desktop. Seluruh kode tes dan helper ditulis dalam **TypeScript**, dibundel Vite dan dijalankan GJS; tidak ada dependensi Python atau `xdotool`. Helper memakai Gio untuk terhubung ke socket X11 dan membaca autentikasi dari `XAUTHORITY` (atau `~/.Xauthority`). Posisi pointer dikembalikan sesudah tes mouse, dan tombol kiri dilepas bila pengujian gagal. Pengaturan dan dokumen uji memakai folder sementara.

Lima skenario memeriksa perpindahan antar daftar beserta catatan/emoji, urutan dalam satu daftar, tujuan kosong, jatuh di posisi asal, serta klik tanpa drag. Pengujian juga memeriksa event tekan/gerak/lepas yang diterima GTK, pembersihan bayangan dan penanda tujuan, Markdown, satu langkah undo/redo, serta hasil simpan. Input dikirim langsung lewat permintaan **FakeInput** dalam [protokol XTest](https://xorg.freedesktop.org/archive/X11R7.6/doc/xextproto/xtest.html), bukan memanggil handler kartu atau membuat objek event tiruan. Inputnya tetap otomatis; ini tidak membuktikan pengujian manual dengan perangkat mouse fisik atau sesi Wayland. Jika input tidak diterima GTK, tes **gagal** (kode keluar `1`), bukan dilewati atau dianggap lulus.

| Opsi | Fungsi |
| --- | --- |
| `--no-gui` | Semua tes unit, tanpa membuka jendela |
| `--mouse` | Tambah klik mouse sungguhan lewat XTest (pointer akan bergerak sendiri). Dilewati dengan keterangan jika lingkungan Anda tidak meneruskan tombol mouse XTest ke GTK (terjadi di XFCE/X11 yang dipakai mengembangkan ini); gerak pointer saja tidak dihitung sebagai tes |
| `--with-kanban-mouse` | Tambahkan lima tes input mouse kanban ke seluruh tes unit dan GUI; dipakai oleh `npm test` di Xvfb dan `npm run test:ui` di desktop. Tidak bisa digabung dengan `--no-gui` |
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
scripts/dev.mjs           npm run dev: build ulang + buka ulang aplikasi + cek tipe
scripts/capture.ts        potret editor dan buat PNG/GIF untuk docs/assets/
scripts/gifenc.d.ts       deklarasi tipe gifenc untuk script capture
docs/                     landing page statis dan aset tangkapan layar
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
│   ├── table.ts          tabel: mengenali blok, memecah sel, rapikan, tambah/hapus baris dan kolom
│   ├── kanban.ts         papan kanban: membaca/menulis Markdown, operasi kartu dan daftar, tag dan tanggal
│   ├── pango.ts          isi sel tabel (Markdown inline) → markup Pango untuk Gtk.Label
│   ├── dbml.ts           penerjemah DBML (dbdiagram.io) → diagram ER Mermaid
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
│   ├── images.ts         menampilkan gambar di bawah barisnya, dan menerima klik/klik ganda
│   ├── tablelayer.ts     merender tabel sebagai grid yang muncul/hilang mengikuti kursor
│   ├── mermaid.ts        menampilkan blok ```mermaid dan ```dbml sebagai diagram (pola yang sama dengan tabel)
│   ├── mermaidrender.ts  merender kode Mermaid menjadi pixbuf lewat WebKitGTK tak terlihat
│   ├── tableedit.ts      Tab/Enter di tabel dan perintah menu Edit Tabel
│   ├── codehighlight.ts  mewarnai isi blok kode sesuai bahasanya
│   ├── tagsync.ts        memasang tag dengan selisih (hanya rentang/baris yang berubah)
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
    ├── imageviewer.ts    penampil gambar dengan zoom (cairo)
    ├── kanban.ts         tampilan papan kanban: daftar, kartu, menu, seret-lepas
    └── theme.ts          palet warna, font, CSS terang/gelap
tests/
├── run-tests.ts          titik masuk dan pendaftaran tes unit/GUI
├── framework.ts          asersi, hasil tes, opsi CLI, folder sementara
├── fixtures.ts           data papan kanban bersama untuk tes model dan GUI
├── unit/                 tes tanpa jendela: inline, HTML, settings, tabel, kanban, bahasa kode, DBML
│   └── helpers.ts        helper untuk mengambil isi body HTML hasil konversi
├── gui/                  tes editor, file/folder, gambar, tabel, diagram, kanban, ukuran, ketahanan
│   ├── context.ts        konteks jendela/editor dan helper tes GUI
│   ├── kanban-mouse.ts   lima tes seret/klik lewat input mouse X11
│   └── mouse-input.ts    klien X11/XTest TypeScript melalui Gio
└── samples/
    ├── semua-format.md   dokumen berisi semua format, untuk tes dan pemeriksaan manual
    ├── papan-kanban.md   contoh papan kanban untuk dicoba
    └── gambar/contoh.png gambar lokal yang dirujuk dokumen itu
```

### Build: TypeScript + Vite

Vite dipakai sebagai **bundler** saja (mode library di [`vite.config.ts`](vite.config.ts)). Dev server dan HMR-nya tidak dipakai, karena ini aplikasi GTK yang dijalankan GJS, bukan halaman web.

```
src/main.ts ─────────┐                        ┌─► dist/nyerat.js         (aplikasi)
tests/run-tests.ts ──┼─► tsc --noEmit ─► vite ┼─► dist/run-tests.js      (tes)
scripts/capture.ts ──┘   (cek tipe)   (bundel)├─► dist/capture.js        (capture docs)
                                             └─► dist/chunks/*.js       (kode bersama)
node_modules/mermaid/dist/mermaid.min.js ────────► dist/mermaid.min.js     (salinan skrip browser)
```

- **Dua langkah build.** Vite mengubah TypeScript menjadi JavaScript tanpa memeriksa tipe. Karena itu `npm run build` menjalankan `tsc --noEmit` lebih dulu, dan build berhenti jika ada kesalahan tipe.
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
                                          ├─ tablelayer.ts    perbarui blok tabel
                                          ├─ codehighlight.ts warnai isi blok kode
                                          ├─ mermaid.ts       perbarui diagram Mermaid/DBML
                                          ├─ images.ts        tampilkan gambar yang ditemukan
                                          ├─ onHighlighted()  → outline, status bar
                                          └─ updateCursor(true)

Kursor pindah ──► queueCursorUpdate() ──► updateCursor()
                                          ├─ decorations.ts   sembunyikan marker di luar
                                          │                   baris aktif, redupkan (fokus)
                                          ├─ tablelayer.ts   tampilkan grid atau teks mentah
                                          ├─ mermaid.ts      tampilkan diagram atau kode + pratinjau
                                          ├─ typewriter     gulir baris aktif ke tengah
                                          └─ onCursorMoved() → status bar
```

Keduanya ditunda dengan `GLib.idle_add(PRIORITY_HIGH_IDLE)`. Beberapa perubahan beruntun (misalnya saat menempel teks) digabung jadi satu proses, dan prosesnya selesai sebelum GTK menggambar ulang layar sehingga tidak berkedip.

### Cara kerja efek "ala Typora"

1. **`highlighter.ts`** membaca seluruh dokumen saat pertama dibuka, lalu hanya rentang suntingan saat teks berubah. Untuk setiap sintaks, ia memasang tag gaya pada isinya (misalnya `bold` pada "tebal" di `**tebal**`) dan mencatat posisi penandanya (`**`) sebagai **marker**.
2. Setiap marker menyimpan rentang baris tempat ia "aktif": `[awal, akhir, barisPertama, barisTerakhir, baris]`. Untuk format inline, rentangnya hanya barisnya sendiri. Untuk pembatas ```` ``` ````, rentangnya seluruh blok kode, jadi pembatas muncul selama kursor ada di dalam blok.
3. **`decorations.ts`** memasang tag `hidden` pada semua marker yang rentang barisnya tidak memuat kursor. Begitu kursor pindah baris, hanya langkah ini yang diulang; penyorotan penuh tidak perlu dijalankan lagi.

**Tag dipasang dengan selisih (`editor/tagsync.ts`).** Menghapus tag di seluruh buffer lalu memasangnya lagi membuat GTK menata ulang seluruh dokumen (tag heading, `hidden`, dan jarak tabel/gambar mengubah ukuran baris), dan itu yang paling mahal di dokumen panjang. Karena itu:

- Penyorotan membaca hanya baris buffer yang berubah, lalu mengurai rentang di antara batas konteks kode/tabel yang aman. Hasil di luar rentang itu dipakai ulang dengan offset yang disesuaikan. Suntingan di dalam kode/tabel mengurai ulang blok terkait; pembatas kode baru dapat memperpanjang parsing hingga akhir dokumen. Snapshot menyimpan hasil dokumen saat ini; cache token tambahan dibatasi 10.000 entri dan 4 Mi unit UTF-16, tanpa menyimpan baris di atas 4.096 unit.
- Jumlah kata/karakter diperbarui dari rentang suntingan. Teks lengkap baru digabung saat diminta, sehingga status bar tidak membaca dan menghitung ulang seluruh dokumen.
- Tag sintaks dan `hidden` dipasang lewat `LineTagger`, yang mengingat tag terakhir di tiap baris. `MarkdownView` mencatat rentang yang disunting (sinyal `insert-text`/`delete-range`, disimpan sebagai dua `GtkTextMark`), jadi saat menyorot ulang hanya baris yang disunting atau yang tag-nya berbeda yang disentuh. Baris lain cukup dibiarkan: tag ikut bergeser bersama teksnya.
- Saat membuka atau menempel banyak baris, rentang tag yang bersebelahan digabung sebelum dipasang, sehingga GTK menerima lebih sedikit operasi. Penyorotan langsung dari `setText()` membatalkan callback penyorotan yang masih antre.
- Tabel dan warna blok kode yang tidak berubah mempertahankan tag yang sudah bergeser bersama teks di GTK. Outline mempertahankan label saat hanya nomor baris heading berubah; tujuan klik tetap diperbarui.
- Tag yang rentangnya sedikit (`dim`, `tablehide`, `mermaidhide`, jarak tabel/gambar/diagram, warna blok kode) dipasang dengan `setTagRanges()`: rentang yang sudah terpasang dibaca dari buffer, lalu hanya selisihnya yang dihapus atau ditambahkan.
- Tes "penyorotan bertahap sama dengan penyorotan dari awal" (`tests/gui/robust.ts`) menyunting dokumen contoh secara acak dan memastikan hasilnya sama dengan menyorot dari awal.

`parseInline()` di `markdown/inline.ts` membuat salinan karakter hanya ketika masking diperlukan, dan memakai ulang string hasil masking selama tidak ada perubahan. Ia memakai teknik **masking**: setelah suatu bagian dikenali (misalnya kode inline), karakternya diganti `\0` agar tidak dikenali lagi oleh pola berikutnya. Itu sebabnya `` `**bukan tebal**` `` tetap tampil sebagai kode.

### Hal teknis yang perlu diketahui

**Posisi teks (`editor/offsets.ts`).** GtkTextBuffer menghitung posisi per karakter Unicode, sedangkan string JavaScript menghitung per unit UTF-16. Emoji 🎉 bernilai 1 di GTK tetapi 2 di JavaScript. Penyorot bekerja dengan posisi JavaScript, lalu mengonversinya dengan `makeCpMap()` tepat sebelum menyentuh buffer.

**Menyembunyikan teks tanpa `invisible` (`editor/tags.ts`).** Atribut `invisible` milik GtkTextView di GTK 3 bisa memicu crash *"Byte index is off the end of the line"*. Karena itu tag `hidden` membuat teks sangat kecil dan berwarna sama dengan latar. Hasilnya di layar sama, tapi jalur kode GTK yang bermasalah tidak tersentuh.

Ukurannya **bukan 1** (satuan Pango, 1/1024 pt) melainkan 256 (`TINY` di `editor/tags.ts`). Font emoji berwarna adalah font bitmap, dan pada ukuran 1 skalanya menjadi nol sehingga GTK gagal menggambar seluruh jendela (*"invalid matrix (not invertible)"*). Ini ketahuan saat tabel berisi emoji dikecilkan; ada tes yang menjaganya.

**Kolom teks di tengah (`editor/view.ts`).** Margin kiri/kanan dihitung dari lebar ScrolledWindow, dan ScrolledWindow memakai `hscrollbar_policy: EXTERNAL`, bukan `NEVER`. Lebar minimum GtkTextView yang dibungkus sama dengan lebarnya saat ini ditambah margin. Dengan `NEVER`, lebar minimum itu diteruskan ke jendela, sehingga jendela tidak bisa mengecil dan terus membesar setiap margin dihitung ulang.

### Cara kerja gambar (`editor/images.ts`)

Gambar tidak dimasukkan ke buffer teks. Jika memakai `GtkTextChildAnchor`, setiap gambar akan menambah karakter ke dokumen dan ke riwayat undo. Sebagai gantinya:

1. `highlighter.ts` mencatat setiap gambar beserta barisnya: `{ line, url, alt }`.
2. `ImageLayer` memuat gambar secara async lewat GIO (file lokal, atau http/https lewat gvfs) dan menyimpannya di cache per URI. Mengetik tidak memuat ulang gambar yang sama.
3. Di bawah baris gambar disediakan ruang kosong dengan tag `pixels_below_lines` setinggi gambarnya.
4. Widget gambar ditempel di atas ruang itu dengan `add_child_in_window()`. Posisinya dalam koordinat buffer sehingga ikut bergulir, dan dihitung ulang dari `get_line_yrange()` setiap kali tata letak berubah.
5. Widget dicocokkan berdasarkan URI, bukan nomor baris. Jika ada baris baru di atasnya, widget yang sama hanya dipindahkan, tidak dibuat ulang.

Seperti format lain, seluruh `![alt](url)` didaftarkan sebagai marker, jadi sintaksnya tersembunyi kecuali di baris aktif.

### Cara kerja tabel (`editor/tablelayer.ts`, `tableedit.ts`, `markdown/table.ts`)

Tabel memakai cara yang sama dengan gambar: widget ditempel di atas ruang kosong di dalam teks, sehingga isi dokumen tidak berubah. Bedanya, tabel punya dua keadaan yang mengikuti kursor:

| Kursor | Teks tabel | Grid |
| --- | --- | --- |
| di luar tabel | dikecilkan jadi ~1 px per baris (tag `tablehide`) | tampil, di ruang yang disediakan di bawah baris terakhir |
| di dalam tabel | tampil sebagai teks mentah, untuk disunting | hilang |

1. `markdown/table.ts` mengenali blok tabel (`findTables()`), dan itu satu-satunya tempat aturan tabel ditulis: penyorot, perintah edit, dan ekspor HTML semuanya memakainya.
2. `highlighter.ts` meneruskan rentang baris tiap tabel ke `TableLayer`.
3. Saat tabel perlu tampil sebagai grid, `TableLayer` memecah isinya (`parseTable()`), membuat `Gtk.Label` untuk setiap sel dengan markup Pango dari `markdown/pango.ts` (tebal, miring, kode, tautan), lalu menyusunnya di `Gtk.Grid`. Grid baru dibuat saat dibutuhkan, jadi mengetik di dalam tabel tidak membangun ulang apa pun.
4. Ruang kosong disediakan lewat tag `pixels_below_lines` di baris terakhir tabel setinggi grid, lalu grid ditempel di atasnya dengan `add_child_in_window()`. Posisinya dihitung ulang dari `get_line_yrange()` setiap tata letak berubah.
5. Lebar kolom sebesar teks terpanjang. Jika jumlahnya melebihi lebar kolom teks, kolom yang sempit dibiarkan dan sisa ruang dibagi ke kolom yang lebar (`fitColumns()`), lalu teksnya dipotong dengan "…". Lebarnya harus dipaksa dengan `set_size_request`, karena TextView hanya memberi anak widget ukuran minimumnya.
6. Klik sel menaruh kursor di sel itu pada teks mentah (`cellStart()`), yang otomatis membuka tabelnya.
7. `tableedit.ts` membaca ulang dokumen dari buffer setiap kali dipakai (bukan dari hasil penyorotan terakhir), lalu menulis ulang baris tabel dalam satu langkah undo. Perintah menu selalu menghasilkan tabel yang dirapikan, karena menambah atau menghapus kolom mengubah lebar kolom.

### Cara kerja diagram Mermaid (`editor/mermaid.ts`, `mermaidrender.ts`)

Mermaid hanya berjalan di browser (butuh DOM dan pengukuran teks), jadi tidak bisa dipanggil langsung dari GJS.

1. **Perender (`mermaidrender.ts`).** Satu `WebKitWebView` di dalam `GtkOffscreenWindow` (tidak pernah tampil) memuat `mermaid.min.js`. Skrip itu disalin dari `node_modules/mermaid` ke `dist/` oleh plugin kecil di `vite.config.ts`. Untuk tiap diagram, halaman menjalankan `mermaid.render()` lalu mengirim ukurannya kembali lewat *script message handler*; jendela diubah seukuran diagram, diambil snapshot-nya, dan dipotong menjadi `GdkPixbuf`. Snapshot dipilih daripada SVG + librsvg karena label Mermaid memakai `<foreignObject>` yang tidak didukung librsvg.
2. WebKitGTK dimuat dengan `import()` dan WebView baru dibuat saat diagram pertama dibutuhkan, jadi dokumen tanpa diagram tidak membayar biayanya (dan aplikasi tetap jalan tanpa WebKitGTK). Diagram dirender satu per satu, hasilnya disimpan di cache per (tema, kode).
3. **Lapisan (`mermaid.ts`)** meniru `TableLayer`: gambar ditempel di ruang kosong di bawah baris penutup blok (`pixels_below_lines`). Saat kursor di luar blok, semua barisnya dikecilkan dengan tag `mermaidhide`; saat di dalam, kode tampil dan diagram menjadi pratinjau di bawahnya. Tag-nya terpisah dari `tablehide` karena tiap lapisan menghapus tag-nya di seluruh dokumen saat sinkron.
4. Render ditunda 400 ms setelah kode berubah; diagram lama tetap tampil selama dirender ulang. Blok yang gagal dirender (galat sintaks) tidak pernah disembunyikan.
5. **DBML** memakai jalur yang sama: `markdown/dbml.ts` (`dbmlToMermaid()`) mengurai DBML dan menulisnya sebagai `erDiagram`, lalu hasilnya dirender seperti kode Mermaid biasa. Galat DBML dilempar sebagai `DbmlError` (berisi nomor baris) dan ditampilkan seketika oleh lapisan tanpa melewati WebKit.

### Cara kerja papan kanban (`markdown/kanban.ts`, `ui/kanban.ts`)

**Format.** Papan adalah file Markdown biasa:

```markdown
---
kanban: true
---

## Rencana

- [ ] Tulis laporan #penting @{2026-10-20}
  catatan kartu (baris yang diindentasi)
- [ ] Kirim undangan

## Selesai

- [x] Pesan tempat
```

Frontmatter `kanban: true` (juga `kanban: yes`, tanpa membedakan huruf besar/kecil, boleh dikutip) menandai dokumen sebagai papan; penanda dicari dalam 40 baris pertama sebelum penutup frontmatter. Dokumen tanpa penanda tetap dibuka sebagai teks biasa. Penanda lama `kanban-plugin: …` (dari plugin Kanban Obsidian, nilai satu token tidak kosong) juga dikenali, dan frontmatter yang sudah ada dipertahankan apa adanya saat disimpan. Heading `##` adalah daftar, item daftar adalah kartu (`[x]` = selesai, tanpa kotak = item biasa), dan baris yang diindentasi di bawah kartu adalah catatannya. Hal yang tidak dikenali (judul papan di atas, baris biasa di dalam daftar seperti `**Complete**` atau `***`, dan blok `%% kanban:settings` di akhir) dipertahankan apa adanya, jadi file dari Obsidian tidak rusak.

**Alur data.** Teks dokumen di buffer adalah satu-satunya sumber kebenaran:

```
buffer teks ──parseBoard()──► KanbanBoard (model + tampilan)
     ▲                              │ commit(papan baru)
     └──── replaceText() ◄── serializeBoard() ◄──┘   (satu langkah undo)
```

1. Saat dokumen kanban dibuka, `MainWindow.syncMode()` mengganti editor dengan papan (`Gtk.Stack`) dan membaca teksnya dengan `parseBoard()`.
2. Setiap perubahan dari papan lewat `commit()`: model baru ditulis dengan `serializeBoard()` lalu dimasukkan ke buffer lewat `MarkdownView.replaceText()`, yang hanya mengganti bagian tengah teks yang berbeda dan menjadikannya satu langkah undo.
3. Undo/redo (aksi `undo`/`redo`, `Ctrl+Z`) mengubah buffer. Perubahan yang bukan dari papan sendiri dikenali dengan membandingkan teks dengan yang terakhir ditulis papan, lalu papan membaca ulang teksnya.
4. Semua operasi atas model (`addCard`, `moveCard`, `moveColumn`, …) murni dan tidak mengubah papan asal, sehingga mudah diuji. `moveCard` memakai posisi *akhir* kartu di daftar tujuan, jadi memindahkan ke bawah di daftar yang sama tidak butuh penyesuaian.

**Menyeret.** Tidak memakai drag-and-drop bawaan GTK, melainkan penunjuk sendiri: tekan di kartu, gerakkan lebih dari 6 piksel, lepas. Selama menyeret, kartu bayangan (jendela kecil berisi tangkapan kartu) mengikuti penunjuk, kartu asal diredupkan, dan penanda putus-putus menunjukkan tujuan. Tujuan dihitung dari posisi penunjuk: daftar yang melingkupinya (atau yang terdekat), lalu `dropIndex()` menghitung berapa kartu lain yang titik tengahnya di atas penunjuk. Dekat tepi, papan atau daftar tujuan digulir otomatis. Gerakan di bawah 6 piksel dianggap klik biasa dan membuka dialog sunting. Cara ini dipilih supaya perilakunya terkendali dan bisa diuji dengan event penunjuk tiruan.

**Dialog** (`editCardDialog`, `promptDialog`, `confirmDialog`) menahan program sampai ditutup, jadi `KanbanBoard.dialogs` bisa diganti, dan tes memakai pengganti.

### Cara kerja zoom gambar (`ui/imageviewer.ts`)

1. Setiap gambar di editor dibungkus `Gtk.EventBox` sendiri, sehingga klik ganda tahu gambar mana yang dimaksud jika satu baris memuat beberapa gambar. Satu klik tetap membuka sintaksnya (`onActivate`); klik ganda (`DOUBLE_BUTTON_PRESS` dari GDK) memanggil `onZoom`, dan menu *Perbesar Gambar* memanggil `MarkdownView.zoomImage()` untuk baris kursor.
2. `ImageLayer.imageAt()` memberikan **pixbuf ukuran penuh** dari cache (gambar di editor hanya salinan yang diperkecil), jadi penampil menampilkan resolusi aslinya.
3. `MarkdownView` tidak membuka jendela sendiri. Ia memanggil `onViewImage`, dan `MainWindow` yang membuka `ImageViewer`, sehingga lapisan `editor/` tetap tidak bergantung pada `ui/`.
4. `ImageViewer` menggambar dengan cairo pada skala zoom di `Gtk.DrawingArea`, bukan membuat salinan yang diperbesar, jadi zoom 800% pada foto besar tidak menghabiskan memori. Zoom mulai 300% memakai filter `NEAREST` supaya piksel tampil apa adanya.
5. Zoom dibatasi 5%–800%, berkelipatan 1,25. Saat roda mouse diputar di atas gambar, titik gambar di bawah penunjuk dijaga tidak bergeser: titik itu dihitung dalam koordinat gambar, lalu posisi gulir diatur ulang setelah tata letak selesai.
6. Gambar dibuka dalam mode "pas layar tapi tidak diperbesar melebihi 100%", dan mengikuti ukuran jendela selama zoom belum diubah.

### Cara kerja warna blok kode (`editor/codehighlight.ts`)

Nyerat tidak punya pewarna kode sendiri. Pekerjaannya diserahkan ke GtkSourceView, yang sudah punya definisi untuk ratusan bahasa dan beberapa skema warna:

1. `highlighter.ts` mencatat setiap blok kode: bahasanya (teks setelah ```` ``` ````), posisi awal isinya, dan isinya.
2. Nama bahasa diterjemahkan ke id GtkSourceView lewat `resolveLanguage()`. Alias yang lazim ditangani langsung (`javascript` → `js`, `py` → `python3`, `bash` → `sh`); nama lain dicoba sebagai id, lalu sebagai ekstensi file (`rs` → `rust`, `kt` → `kotlin`).
3. Isi blok disalin ke `GtkSource.Buffer` tersembunyi (satu per bahasa), lalu `ensure_highlight()` menyorotinya saat itu juga.
4. Tag hasil sorotan dibaca rentang demi rentang. Warna, tebal, miring, garis bawah, dan coret disalin menjadi tag `syntax:…` di buffer editor. Latar belakang tidak disalin, supaya blok kode tetap memakai latar dari tema aplikasi.
5. Hasilnya disimpan di cache per (skema, bahasa, isi blok). Mengetik di luar blok kode, atau di blok lain, tidak membuat blok ini disorot ulang.

Skema warnanya `tango` untuk mode terang dan `cobalt` untuk mode gelap (diatur di `codeScheme` pada `ui/theme.ts`). Karena tag warna kode dibuat belakangan, prioritasnya otomatis di atas `codeblock`. Setiap kali tag warna baru dibuat, `dim` (mode fokus) dan `hidden` dinaikkan lagi ke paling atas, supaya keduanya tetap menang atas warna kode.

### Urutan membaca kode

Untuk mempelajari kodenya, urutan berikut bergerak dari yang paling sederhana:

1. `src/markdown/syntax.ts` → `inline.ts` → `html.ts`: aturan Markdown, tanpa GTK
2. `src/editor/tags.ts` → `highlighter.ts` → `decorations.ts`: inti efek Typora
3. `src/editor/view.ts`: bagaimana semuanya digerakkan oleh sinyal GTK
4. `src/editor/editing.ts`, `lists.ts`, `clicks.ts`: interaksi pengguna
5. `src/editor/images.ts`, `codehighlight.ts`, dan `tablelayer.ts`: gambar, warna kode, dan tabel (`markdown/table.ts` lebih dulu)
6. `src/ui/*`: komponen antarmuka
7. `src/window.ts` dan `src/actions.ts`: bagaimana semuanya disatukan
8. `tests/run-tests.ts`: contoh pemakaian setiap bagian

### Menambah fitur

Contoh menambah format baru, misalnya `^superskrip^`:

1. Tambahkan pola di `EMPHASIS` (`src/markdown/syntax.ts`), misalnya `['sup', /(\^)(?=\S)([\s\S]*?\S)\^/g, 1]`, lalu tambahkan `'sup'` ke tipe `EmphasisTag` di file yang sama
2. Tambahkan tag `sup` di `TAG_DEFS` (`src/editor/tags.ts`), misalnya `{ rise: 4000, scale: 0.8 }`
3. Tambahkan konversinya di `emphHtml()` (`src/markdown/html.ts`)
4. Jika perlu shortcut, daftarkan di `src/actions.ts`: `action('sup', ['<Control><Shift>p'], () => wrapSelection(buf, '^'))`
5. Tambahkan contohnya di `tests/samples/semua-format.md`, tes penguraian/ekspor di `tests/unit/`, dan tes tampilan/interaksi di `tests/gui/`. Daftarkan modul tes baru di `tests/run-tests.ts`

## Pengaturan

Disimpan di `$XDG_CONFIG_HOME/nyerat/settings.json` (bawaan `~/.config/nyerat/settings.json`): mode gelap, sidebar dan tab yang terakhir dipilih, folder yang terakhir dibuka, mode fokus, mode typewriter, auto save, ukuran jendela, dan penanda bahwa dokumen contoh sudah pernah ditampilkan.

Nilai bawaan: sidebar terbuka pada tab Outline, fokus/typewriter mati, ukuran jendela 1100 × 760 piksel, dan mode gelap mengikuti tema sistem (`dark: null`). Setelah mode gelap dipilih lewat menu, pilihan itu disimpan. Ukuran awal jendela dibatasi ke area kerja monitor. Mode source dan pilihan tampilan papan/teks tidak disimpan antar proses.

## Keterbatasan

- Gambar yang diubah di disk tidak dimuat ulang sampai aplikasi dibuka lagi (ada cache per URI); GIF animasi hanya menampilkan frame pertama, termasuk di penampil zoom
- **Seret kartu telah diuji lewat input mouse X11/XTest.** `npm test` dan `npm run test:ui` memeriksa lima skenario melalui event yang benar-benar diterima GTK, termasuk perubahan Markdown, undo/redo, dan simpan. Jalur input ini berhasil di lingkungan pengembangan, sementara helper klik lama `Gdk.test_simulate_button` tidak meneruskan tombol dengan andal. Pengujian manual dengan mouse fisik dan sesi Wayland masih belum terverifikasi
- Papan: hanya item daftar di tingkat atas yang menjadi kartu (daftar bersarang dipertahankan sebagai catatan kartu); baris biasa di antara dua kartu dipindahkan ke akhir daftar saat disimpan. Belum ada arsip, pemilih tanggal, atau penyuntingan label lewat antarmuka (tulis `#tag` dan `@{YYYY-MM-DD}` di judul kartu), dan memindahkan kartu dengan keyboard hanya lewat menu klik kanan
- Di tampilan teks, frontmatter papan tampil seperti Markdown biasa (garis `---` dan teks)
- Klik pertama pada gambar membuka sintaksnya, sehingga gambar bergeser sekitar satu baris ke bawah. Klik ganda yang jatuh di strip tipis tepi atas gambar karenanya bisa meleset ke teks di atasnya
- Gambar di dalam sel tabel tidak ditampilkan (hanya teks alt-nya), dan gambar di dalam daftar atau kutipan tidak ikut menjorok
- Ekspor papan kanban menghasilkan Markdown yang dikonversi menjadi heading dan daftar HTML, bukan tampilan papan. Frontmatter tidak diproses khusus; DBML yang salah sintaks diekspor sebagai blok kode biasa
- Ekspor HTML tidak menyalin atau menyematkan gambar lokal, dan tidak menyesuaikan path relatif jika hasil ekspor disimpan di folder lain
- Warna blok kode belum ikut ke hasil Ekspor HTML; di HTML blok kode hanya diberi kelas `language-…`
- Sel tabel disunting di teks mentahnya (klik sel atau gerakkan kursor ke dalam tabel), bukan langsung di grid
- Teks sel yang terlalu panjang dipotong dengan "…", tidak dibungkus ke baris berikutnya, dan isi sel hanya satu baris
- Merapikan tabel (`Ctrl+Shift+T` dan semua perintah di menu Edit Tabel) membuang sel yang berlebih dibanding baris judul, sesuai aturan GFM
- Tabel yang kursornya di dalamnya tampil mentah; jika seluruh dokumen hanya berisi satu tabel dan kursor ada di dalamnya, grid baru tampil setelah kursor keluar
- Garis pemisah tampil sebagai teks `---` pudar di tengah, bukan garis
- Parsing suntingan sudah bertahap, tetapi penyesuaian array offset/metadata dan pemeriksaan tag masih sebanding dengan jumlah baris. Membuka dokumen atau mengubah konteks fence sampai akhir tetap dapat mengurai seluruh dokumen; kenyamanan GUI pada puluhan ribu baris belum terverifikasi karena benchmark ekstrem masih menemui callback GJS yang terblokir saat GC.
