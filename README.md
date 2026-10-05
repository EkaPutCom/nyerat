# Nyerat

Nyerat dikembangkan menuju **personal workbench AI agent** untuk desktop Linux: ruang kerja pribadi untuk mengolah catatan, dokumen, riset, rencana, dan tugas bersama agent AI yang memahami konteks kerja Anda. Fondasi yang tersedia saat ini adalah editor Markdown dengan tampilan langsung terformat, papan kanban, riwayat Git, dan asisten AI baca-saja. Dibuat dengan **GTK 4**, **GtkSourceView 5**, dan **GJS** (JavaScript untuk GNOME). Kodenya ditulis dalam **TypeScript** dan dibundel dengan **Vite**.

Tidak ada panel pratinjau terpisah: teks langsung tampil terformat. Sintaks Markdown seperti `#`, `**`, `` ` `` dan `[](url)` disembunyikan, lalu muncul lagi saat kursor berada di baris tersebut.

Landing page-nya ada di [`docs/`](docs/index.html) (HTML statis; aktifkan GitHub Pages dari folder `/docs` pada branch `main` untuk menayangkannya). Tangkapan layar dibuat oleh [`scripts/capture.ts`](scripts/capture.ts).

## Goal: personal workbench AI agent

Tujuan Nyerat adalah menjadi ruang kerja pribadi tempat pengguna dan agent AI bekerja dengan konteks yang sama: catatan, dokumen, riset, keputusan, rencana, dan tugas dalam satu folder kerja. Agent membantu memahami informasi, menyusun rencana, dan menuntaskan pekerjaan dengan hasil yang dapat diperiksa pengguna. Menulis tetap menjadi salah satu alur kerja utama. Prinsip pengembangannya:

- **Konteks datang dari ruang kerja.** Dokumen yang terbuka (termasuk yang belum disimpan), pilihan, posisi kursor, dan peta seluruh folder disusun otomatis; model juga menelusuri berkas sendiri dengan alat baca-saja
- **Transparan.** Setiap jawaban memperlihatkan konteks apa yang dikirim, penelusuran apa yang dilakukan, dan berapa token yang terpakai
- **Pengguna memegang kendali.** Agent membaca bebas, tetapi tidak pernah menulis sendiri: ia hanya bisa mengusulkan berkas baru atau perubahan, dan berkas baru tersentuh setelah Anda menekan *Terapkan* pada selisihnya. Kemampuan tindakan berikutnya harus menyediakan batas akses yang jelas dan hasil yang dapat ditinjau; tindakan yang membutuhkan persetujuan menunggu persetujuan pengguna. Dokumen yang dikirim ke penyedia model bisa dibatasi lewat saklar, dan API key milik Anda sendiri
- **Teks tetap milik Anda.** Semua berupa Markdown biasa di berkas biasa (bisa di-diff dan di-commit ke Git); tanpa format tertutup dan tanpa akun

Keadaan sekarang: editor Markdown, kanban, riwayat Git, dan chat dengan DeepSeek yang menelusuri dokumen serta menjawab dengan kutipan berkas dan nomor baris. Agent juga bisa mengusulkan berkas baru dan perubahan teks yang Anda setujui lewat kartu selisih di panel. Tindakan lain (menjalankan tugas, mengubah kanban, menjalankan perintah) belum tersedia.

Arah pengembangan berikutnya adalah memperluas konteks dari naskah ke pekerjaan pribadi, menghubungkan percakapan dengan rencana dan hasil kerja, serta menambahkan tindakan agent yang dapat ditinjau dan dikendalikan pengguna. Pemeriksaan konsistensi otomatis, usulan untuk papan kanban dan tindakan selain menulis Markdown, dan penyedia model selain DeepSeek juga belum tersedia (lihat *Keterbatasan*).

## Arti nama

**Nyerat** berasal dari kata dalam bahasa Sunda dan Jawa yang berarti *menulis*. Menulis menjadi fondasi ruang kerja ini: catatan, rencana, dan hasil kerja tetap tersimpan sebagai dokumen yang mudah dibaca dan disunting, dengan tampilan bersih agar pengguna bisa fokus pada pekerjaannya.

## Kebutuhan

- Linux dengan desktop X11 atau Wayland
- GJS (diuji dengan versi 1.80)
- GTK 4 (diuji dengan 4.14) dan GtkSourceView 5. Pustaka GTK 4 biasanya sudah ada di desktop modern (juga di XFCE, yang sendiri memakai GTK 3); yang perlu dipasang hanya binding GObject Introspection-nya. GTK 3 dan GTK 4 terpasang berdampingan tanpa saling mengganti.
- WebKitGTK 6.0 dengan binding GObject Introspection (`gir1.2-webkit-6.0` di Debian/Ubuntu), **hanya untuk diagram Mermaid dan DBML**; tanpanya aplikasi tetap berjalan dan diagram menampilkan pesan galat
- Node.js 20.19+ pada seri 20, atau 22.12+ (syarat Vite), **hanya untuk build** (diuji dengan Node.js 24). Aplikasinya sendiri dijalankan GJS, bukan Node.js.

Di Ubuntu/Debian:

```bash
sudo apt install gjs gir1.2-gtk-4.0 gir1.2-gtksource-5
```

Untuk diagram, tambahkan dependensi opsional:

```bash
sudo apt install gir1.2-webkit-6.0
```

Untuk **asisten (chat dengan AI)**, tambahkan libsoup 3 (hampir pasti sudah ada karena dipakai WebKitGTK) dan, opsional, libsecret untuk menyimpan API key di keyring:

```bash
sudo apt install gir1.2-soup-3.0 gir1.2-secret-1
```

Tanpa libsoup hanya asisten yang tidak berfungsi; tanpa libsecret, key disimpan di file berizin 0600.

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

Aplikasi memakai argumen pertama yang bukan opsi sebagai path file atau folder. Setiap pemanggilan membuka proses dan jendela sendiri; di dalam jendela itu file lain dibuka sebagai tab. Tanpa argumen, tab berfile yang terbuka saat jendela terakhir ditutup dibuka lagi. Pada pembukaan pertama tanpa file, editor menampilkan dokumen contoh; jika tidak ada tab untuk dipulihkan, pembukaan berikutnya dimulai dengan dokumen kosong.

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
| `npm run test:live` | Build, lalu jalankan tes langsung ke API DeepSeek atas naskah contoh (butuh `DEEPSEEK_API_KEY` di `.env`, lihat `.env.example`; tidak ikut `npm test`) |
| `npm run bench` | Build, lalu ukur performa modul Markdown dan editor (setText, penyorotan, mengetik) di Xvfb; opsi: `--size=`, `--runs=`, `--budget=`, `--no-gui` |
| `npm run bench:save` | Jalankan benchmark dan simpan hasilnya ke `bench/<tanggal-waktu>.json` |
| `npm run bench:compare` | Jalankan benchmark dan tampilkan selisih terhadap [`bench/baseline.json`](bench/baseline.json) (hijau = lebih cepat, merah = lebih lambat, abu-abu = selisih < 25%, derau pengukuran) |
| `npm run docs` | Potret aplikasi sungguhan (jendela akan terbuka sebentar), lalu perbarui PNG dan GIF di `docs/assets/` untuk landing page |

Hasil optimasi dan batas cakupannya dicatat di [laporan performa](bench/PERFORMANCE.md).

Benchmark memakai 10 pengulangan setelah pemanasan. Hasil menampilkan median, p95,
dan maksimum dalam milidetik; `--save=...` menyimpan sampel mentah, commit, serta versi
GJS/GLib/GTK dan lingkungan. `--compare=...` hanya membandingkan format, ukuran,
pengulangan, jenis dokumen, mode, dan lingkungan yang setara. Baseline format lama perlu dibuat ulang.

Skenario GUI mencakup membuka teks (total sampai tata letak selesai dan jeda terpanjang
main loop, yaitu yang terasa sebagai "membeku"), penyorotan ulang, mengetik (total 20
karakter, latensi per karakter, dan lewat sinyal keybinding TextView di akhir paragraf
panjang), Enter, perpindahan kursor, paste besar dengan emoji dan baris panjang,
hapus, undo, redo, serta auto save (tulis sinkron dan bagian thread utama auto save latar). Setiap suntingan diverifikasi melalui callback penyorotan.
`--budget=...` berlaku pada median operasi GUI; untuk mengetik, budget berlaku per
karakter. Kegagalan pengukuran mengembalikan kode 1 dan mencegah penyimpanan hasil
parsial; hasil lengkap yang melampaui budget tetap dapat disimpan untuk diagnosis.
Tiap proses GUI dibatasi 120 detik (`--timeout=...`), menggunakan `timeout` dari
GNU coreutils, agar callback yang terblokir GC tidak membuat runner menunggu tanpa batas.
Ukuran GUI dapat diatur dengan `--sizes=25,50,100`; `--size` mengatur ukuran modul
Markdown. `--fixture=long --size=2000 --sizes=2000` menguji dokumen 20.000 baris
tanpa grid tabel, dan `--fixture=buku --size=400 --sizes=50,200,400` menguji naskah buku
(paragraf panjang yang dibungkus, dialog, *miring*/**tebal**, ±1,6 KB per blok; 400 blok ≈ 650 KB,
sekitar 100.000 kata); jenis dokumen bawaan adalah `mixed`. Rendering gambar/diagram asinkron dan interaksi papan kanban belum diukur;
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

**Penulisan langsung terformat**
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
- **Banyak dokumen dalam satu jendela (tab).** Baris tab muncul di atas editor begitu ada dua dokumen atau lebih. Mengklik file di pohon Berkas atau memilihnya di dialog *Buka File* membuka tab baru (atau pindah ke tabnya jika file itu sudah terbuka; dokumen kosong yang belum disimpan dipakai ulang), dan *Baru* (`Ctrl+N`) membuat tab kosong. Tiap tab punya riwayat undo, kursor, dan posisi gulirnya sendiri; mode Fokus/Typewriter/Source dan tema berlaku untuk semua tab. Tanda `•` pada judul tab berarti belum disimpan, `Ctrl+W` menutup tab (bertanya jika ada perubahan; menutup tab terakhir mengosongkan dokumennya), dan `Ctrl+Tab` / `Ctrl+Shift+Tab` (atau `Ctrl+PgDn` / `Ctrl+PgUp`) berpindah tab. Dengan auto save aktif, meninggalkan tab langsung menyimpannya. Outline, hitungan kata, pencarian, dan tab Riwayat mengikuti tab aktif, dan asisten membaca isi tab lain yang belum disimpan, bukan versi di disk. **Tab dipulihkan**: saat aplikasi dibuka lagi tanpa argumen, tab berfile dari sesi terakhir dibuka kembali dengan urutan, tab aktif, dan posisi kursornya; file yang sudah tidak ada dilewati (dengan pesan di status bar). Membuka file atau folder dari baris perintah tidak memulihkan tab
- Sidebar dengan tiga tab:
  - **Berkas**: pohon folder yang dibuka (lewat tombol folder di header bar, `Ctrl+Shift+O`, atau dengan memilih folder di dialog Buka File), berisi subfolder dan file Markdown (`.md`, `.markdown`, `.mdown`, `.mkd`). Klik file untuk membukanya; file yang sedang dibuka ikut disorot. File/folder tersembunyi dan `node_modules` tidak ditampilkan. **Klik kanan** pada folder, file, atau area kosong membuka menu *File Baru…* dan *Folder Baru…* (pada folder/file ditambah *Ganti Nama…* dan *Hapus*; hapus meminta konfirmasi dan memindahkan ke Tempat Sampah, bukan menghapus permanen; jika dokumen yang terbuka dihapus, isinya tetap di editor dan ditandai belum disimpan; ganti nama file tetap berekstensi Markdown, dan dokumen yang terbuka mengikuti nama barunya): item dibuat di folder yang diklik (untuk file: di folder induknya; untuk area kosong: di folder root). Nama file tanpa ekstensi Markdown diberi `.md`, nama yang kosong, memuat `/`, diawali titik, atau sudah ada ditolak dengan pesan galat; file baru langsung dibuka di editor. **Seret dan lepas** memindahkan file atau folder: lepas di sebuah folder untuk memasukkannya ke sana (folder tertutup yang ditahan sebentar terbuka sendiri), lepas di file untuk memindahkannya ke folder file itu, atau lepas di judul pohon/area kosong untuk mengeluarkannya ke folder root. Folder tidak bisa dipindah ke dalam dirinya sendiri, dan nama yang bentrok di folder tujuan ditolak tanpa menimpa. Jika dokumen yang terbuka (atau folder induknya) dipindah, dokumen tetap terbuka dengan path barunya. Pohon diperbarui otomatis saat ada file yang ditambah atau dihapus di disk, dan folder terakhir dibuka lagi saat aplikasi dijalankan
  - **Outline**: daftar heading dokumen; klik untuk melompat
  - **Riwayat**: commit git yang menyentuh file yang sedang dibuka, terbaru dulu (hash pendek, pesan, penulis, waktu relatif; riwayat mengikuti file yang di-rename). Jika file berbeda dari commit terakhir (atau belum dilacak), tombol *Perubahan belum di-commit* muncul di atas daftar dan membuka diff terhadap HEAD (file baru ditampilkan seluruhnya sebagai tambahan). Di bawahnya, daftar *Belum di-commit (N)* memuat semua file di repositori yang sedang berubah (M diubah, A baru di-stage, D dihapus, R diganti nama, U belum dilacak); klik salah satu untuk membuka diff-nya di jendela yang sama (juga bisa di-commit dari sana). Tiap baris punya kotak centang (semua tercentang awalnya); isi pesan lalu tekan *Commit N file* untuk meng-commit beberapa file sekaligus (`git add --all` + `git commit --only` pada file terpilih; dokumen yang terbuka disimpan dulu). Daftar ini juga tampil saat belum ada file terbuka tetapi sebuah folder sudah dibuka. Klik commit untuk membuka jendela baca dengan dua tab: *Perubahan* (diff terhadap commit sebelumnya, baris tambah/hapus berwarna) dan *Isi versi ini* (file lengkap pada commit itu). Jendela perubahan belum di-commit juga punya kolom pesan dan tombol *Commit file ini*: dokumen disimpan dulu, lalu hanya file itu yang di-commit (`git add` + `git commit --only`; file lain tidak ikut, hook git tidak dijalankan). Selain itu aplikasi tidak pernah mengubah repositori. Riwayat dimuat saat tab terlihat, 100 commit sekali muat (tombol *Muat lebih banyak*), dan dimuat ulang saat berganti file, saat jendela kembali aktif, atau lewat tombol muat ulang. Butuh `git` terpasang; file di luar repositori atau yang belum di-commit menampilkan pesan di tab
- Mode fokus: paragraf selain yang sedang disunting diredupkan
- Mode typewriter: baris aktif selalu di tengah layar
- Mode source: semua sintaks Markdown ditampilkan; widget gambar, grid tabel, dan diagram disembunyikan
- Mode gelap, otomatis mengikuti tema sistem saat pertama dibuka
- Kolom teks dibuat di tengah dengan lebar baca yang nyaman

**Asisten (chat dengan AI)**
- Panel di sisi kanan (`Ctrl+Shift+A` atau tombol gelembung di header bar) untuk bertanya tentang naskah ke model **DeepSeek** (`deepseek-flash` atau `deepseek-v4-pro`, dipilih di pengaturan panel; kotak *Berpikir mendalam* menyalakan mode berpikir yang lebih teliti tetapi lebih lambat dan mahal). Jawaban mengalir saat dibuat, tampil dengan format Markdown, dan proses berpikir model bisa dibuka terpisah. Asisten hanya membaca: ia tidak pernah mengubah berkas, usulannya berupa teks yang Anda salin sendiri
- **Konteks disusun otomatis dari naskah**: dokumen yang terbuka (isi editor, termasuk yang belum disimpan; jika terlalu panjang, bagian di sekitar kursor), teks yang sedang dipilih, posisi kursor, peta seluruh berkas Markdown di folder yang dibuka (nama, jumlah kata, heading), dan potongan paling relevan dari berkas lain (dicari dari pertanyaan, pilihan, dan dua pertanyaan sebelumnya). `@namaberkas` di pesan (opsional) langsung melampirkan berkas utuh di pesan pertama, jadi model tidak perlu satu putaran penelusuran untuk membacanya; tanpa itu pun model mencari dan membaca berkas lain sendiri lewat alat Tombol **Konteks** di bawah panel merinci apa yang akan dikirim beserta perkiraan tokennya dan punya tiga saklar (dokumen aktif, pilihan, berkas lain)
- **Asisten menelusuri naskah sendiri (function calling).** Konteks awal hanya bagian yang dipilih otomatis, jadi model juga diberi empat alat baca-saja: `daftar_berkas`, `cari_dokumen` (topik), `cari_teks` (teks persis, mis. nama tokoh), dan `baca_berkas` (isi berkas per rentang baris). Untuk pertanyaan seperti "adakah kontradiksi usia Raka?", model mengumpulkan semua kemunculannya sendiri, membaca bagian sekitarnya, lalu menjawab dengan kutipan berkas dan nomor baris. Tiap penelusuran tampil sebagai baris kecil di atas jawaban (mis. *Mencari teks “Raka” → 3 baris*). Alat memakai isi editor untuk dokumen yang terbuka, hanya membaca berkas Markdown di folder yang dibuka, dan ikut saklar *Berkas lain di folder*: dimatikan, tidak ada alat sama sekali
- **Usulan perubahan dengan persetujuan.** Bila Anda memintanya, model juga bisa memanggil `buat_berkas` (berkas Markdown baru) dan `ubah_berkas` (ganti satu potongan teks persis yang muncul tepat sekali). Alat ini tidak menulis apa pun: jendela tinjau terbuka otomatis dengan tampilan seperti diff riwayat Git (alasan di atas, selisih berwarna dengan nomor baris dan tiga baris konteks) dan tombol *Tolak* serta *Terapkan*; di panel tertinggal kartu ringkas berstatus dengan tombol *Tinjau perubahan* untuk membukanya lagi. Menutup jendela sama dengan menolak. Terapkan pada berkas yang terbuka mengubah editornya dalam satu langkah undo (`Ctrl+Z`); pada berkas lain, atau berkas baru, langsung ditulis ke disk (berkas baru dibuka di tab). Penerapan dibatalkan dengan galat bila isi berkas sudah berubah sejak diusulkan, dan nama di luar folder kerja, bertitik, atau berisi `..` ditolak. Hasil Tolak, galat, atau Hentikan dikirim balik ke model supaya tidak memaksa. Alat ini hanya ada bila saklar *Berkas lain di folder* menyala.
- Tiap jawaban diberi rincian konteks yang dikirim dan pemakaian token (termasuk bagian yang dilayani dari cache, dan jumlah penelusuran). **Naskah yang disertakan dikirim ke server DeepSeek**; matikan saklar *Berkas lain di folder* dan *Dokumen yang sedang dibuka* untuk bertanya tanpa mengirim naskah
- **Riwayat percakapan tersimpan per folder.** Tiap percakapan ditulis sebagai satu berkas Markdown di `<folder naskah>/.nyerat/chats/` (mis. `2026-10-04-adakah-kontradiksi-usia-raka.md`, berisi frontmatter `judul`/`model`/`dibuat` lalu giliran `## Anda` dan `## Asisten`), diperbarui setelah tiap giliran. Tombol jam di kepala panel membuka daftar percakapan di folder itu (terbaru dulu): klik untuk memulihkannya dan melanjutkan di berkas yang sama (riwayatnya ikut dikirim ke model), atau ikon sampah untuk membuangnya ke Tempat Sampah. *Percakapan baru* (ikon sapu) memulai berkas baru. Riwayat berisi kutipan naskah, jadi `.nyerat/` otomatis diberi `.gitignore` berisi `*` (hapus berkas itu bila ingin meng-commit-nya); folder bertitik tidak tampil di pohon Berkas dan tidak dibaca asisten sebagai naskah. Saklar *Simpan riwayat percakapan di folder* di pengaturan panel (roda gigi) mematikannya; tanpa folder yang dibuka tidak ada yang disimpan
- API key diambil dari variabel lingkungan `DEEPSEEK_API_KEY`, atau diisi di pengaturan panel (ikon roda gigi) dan disimpan di keyring sistem; jika keyring tidak tersedia, di `~/.config/nyerat/deepseek.key` (mode 0600). Key tidak ditulis ke `settings.json`

**Lainnya**
- Cari teks, undo/redo, hitungan kata dan karakter, posisi kursor
- Ekspor ke HTML dengan CSS disertakan. Gambar dan tautan tetap memakai URL/path aslinya; diagram Mermaid/DBML memerlukan internet untuk memuat Mermaid dari CDN
- **Auto save** (menu ☰ → *Auto Save*, aktif bawaan): dokumen yang sudah punya file disimpan otomatis 1 detik setelah berhenti mengetik (penulisan ke disk berjalan di latar, jadi tidak menahan ketikan), dan disimpan tanpa bertanya saat menutup, membuat dokumen baru, atau membuka file lain. Dokumen yang belum pernah disimpan tetap butuh Ctrl+S
- Peringatan sebelum menutup, membuat dokumen baru, atau membuka file lain jika ada perubahan yang belum disimpan (saat auto save mati atau dokumen belum punya file)

## Shortcut

| Shortcut | Fungsi |
| --- | --- |
| Ctrl+N / Ctrl+O | Dokumen baru / buka file (keduanya di tab baru) |
| Ctrl+W | Tutup tab |
| Ctrl+Tab / Ctrl+Shift+Tab atau Ctrl+PgDn / Ctrl+PgUp | Tab berikutnya / sebelumnya |
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
| Ctrl+Shift+A | Tampilkan/sembunyikan panel Asisten |
| Enter / Shift+Enter | Di kotak pesan Asisten: kirim / baris baru |

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

Di Xvfb, tes memakai rendering perangkat lunak Mesa (`LIBGL_ALWAYS_SOFTWARE=1`) serta menonaktifkan compositing GPU dan perender DMA-BUF WebKitGTK (`WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1`) karena display virtual tidak menyediakan perangkat DRI3. Ini menghindari peringatan libEGL saat tes diagram Mermaid dan DBML; pengaturan ini hanya berlaku untuk `npm test`.

`npm run test:ui` menjalankan rangkaian tes yang sama pada desktop **X11 lokal** (atau XWayland yang menyediakan `DISPLAY` lokal), sehingga jendela tes terlihat. Mode ini tidak membutuhkan Xvfb. Pointer desktop akan bergerak selama tes drag; biarkan mouse dan keyboard sampai selesai. Pointer dikembalikan ke posisi semula setelah bagian tes mouse.

Tes ditulis dalam TypeScript tanpa framework tambahan, dibundel Vite menjadi `dist/run-tests.js`, lalu dijalankan GJS. Script keluar dengan kode `1` jika ada yang gagal. Isinya:

- **Unit**: konversi Markdown → HTML, pengurai format inline, simpan/baca pengaturan, model tabel dan kanban, alias bahasa kode, DBML, operasi berkas (buat/ganti nama/hapus/pindah), pengurai keluaran git, serta asisten, tanpa GUI
- **Editor**: membuka jendela sungguhan, lalu memeriksa sintaks yang disembunyikan/ditampilkan, Enter dan Tab di daftar, shortcut format, undo, klik kotak tugas, serta simpan dan buka file
- **Tabel**: aturan pengenalan tabel (pemisah satu strip, tanpa pipa di tepi, berhenti di blok lain), pemecahan sel, perataan, merapikan kolom (termasuk lebar CJK dan emoji), operasi baris/kolom, konversi format inline ke markup Pango, lebar kolom; lalu di editor: grid yang muncul dan hilang mengikuti kursor, letak grid di antara paragraf, klik sel, Tab/Shift+Tab/Enter, semua perintah menu, satu perintah = satu langkah undo, mode source, serta tabel beremoji yang tidak membuat GTK gagal menggambar
- **Kanban**: model (mengenali papan, membaca dan menulis dengan hasil yang stabil, operasi kartu dan daftar, tag dan tanggal); di editor: dokumen dibuka sebagai papan, menambah/mencentang/menyunting/memindahkan lewat menu, seret kartu (jatuh di posisi yang ditunjuk, kartu bayangan dan penanda tujuan dibersihkan, tempat asal tidak mengubah apa pun), gulir otomatis di tepi, undo/redo satu langkah per perubahan, beralih ke tampilan teks dan kembali, aksi pengeditan teks ditolak saat papan tampil, dan simpan
- **Diagram Mermaid**: blok dirender menjadi gambar, kode disembunyikan di luar blok dan tampil dengan pratinjau di dalamnya, galat sintaks ditampilkan tanpa menyembunyikan kode, render ulang saat kode diubah, widget dipakai ulang saat baris bergeser, blok kosong/tidak ditutup/bukan mermaid diabaikan, mode source, dan tema gelap (warna latar gambar); serta ekspor HTML-nya
- **Diagram DBML**: penerjemah DBML → Mermaid (tabel, kolom, ref, alias, skema, galat berikut nomor barisnya), blok dbml dirender dan galatnya tampil tanpa menyembunyikan kode, serta ekspor HTML-nya
- **Zoom gambar**: gambar ukuran penuh dari `imageAt()`, klik sekali vs ganda (lewat `GestureClick` yang dipicu tes) dan gambar yang tepat jika satu baris memuat beberapa, perintah menu; di penampil: zoom awal, kelipatan 1,25 dan batas 5%–800%, tombol, titik zoom di penunjuk, geser dengan drag, klik ganda, dan tidak ada peringatan GTK/cairo saat menggambar pada zoom besar
- **Warna blok kode**: alias nama bahasa, warna kata kunci/string/komentar, blok tanpa bahasa atau bahasa tak dikenal, pewarnaan ulang saat mengetik, emoji sebelum blok, skema terang/gelap, dan mode fokus yang tetap meredupkan blok kode
- **Riwayat git**: pengurai log/diff dan waktu relatif (unit); di GUI, daftar commit file aktif, tombol perubahan belum di-commit, daftar *Belum di-commit* dengan kotak centang, commit satu atau beberapa file sekaligus di repositori sementara, serta jendela baca commit (tab *Perubahan* dan *Isi versi ini*)
- **Folder**: isi pohon dan urutannya, file tersembunyi dan non-Markdown yang disaring, isi subfolder yang baru dibaca saat dibuka, membuka file dengan klik, sorotan file aktif, pembaruan otomatis saat file ditambah/dihapus di disk, serta folder dari argumen dan dari pengaturan; menu klik kanan *File Baru*/*Folder Baru* (di root, folder, dan sebelah file), pemindahan file/folder masuk dan keluar folder, penolakan nama tidak valid/bentrok/pindah ke diri sendiri, dokumen terbuka yang ikut berpindah path, dan seret-lepas dengan mouse X11 sungguhan
- **Tes langsung ke API** (`npm run test:live`, butuh `DEEPSEEK_API_KEY` di `.env`, tidak ikut `npm test`): empat skenario atas naskah `tests/samples/buku-contoh` yang sengaja berisi kontradiksi, termasuk satu dengan anggaran konteks 900 token supaya model wajib memakai alat; `-- --thinking` untuk mode berpikir dan `-- --model=...` untuk model lain
- **Asisten**: penyusunan konteks (pemecahan per heading, BM25, anggaran token, jendela di sekitar kursor, @lampiran, prefiks `system` yang stabil, pemangkasan riwayat), pembacaan aliran SSE dan pesan galat, markup jawaban, klien DeepSeek terhadap server tiruan, lalu alat penelusuran (hasil, batas, galat), loop agen (alat dikirim balik, penalaran dikembalikan, batas putaran dan anggaran, pembatalan), pembentukan pesan alat untuk API, lalu panel: pesan terkirim dengan dokumen/pilihan/potongan yang benar, langkah penelusuran tampil, jawaban terformat beserta token, riwayat, `@nama`, saklar konteks, galat dan pembatalan, Enter/Shift+Enter, serta pengaturan key dan model (semua dengan penyedia palsu; tanpa jaringan)
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
├── gtkutil.ts            pembantu GTK 4 untuk semua lapisan: iter baris, anak widget, klik/tombol, dialog modal (runModal), pack()
├── app.ts                membuat Gtk.Application dan jendela
├── window.ts             MainWindow: menyusun komponen, mengelola dokumen/tab, buka/simpan/ekspor
├── actions.ts            semua aksi menu dan shortcut keyboard
├── config.ts             nama, ID, versi aplikasi, dan font
├── settings.ts           baca/tulis ~/.config/nyerat/settings.json
├── files.ts              baca/tulis file teks UTF-8
├── fileops.ts            buat, ganti nama, hapus (ke sampah), dan pindahkan file/folder di disk (tanpa GTK; dipakai pohon berkas)
├── git.ts                riwayat git sebuah file dan daftar file yang belum di-commit lewat perintah `git` (async; hanya membaca, kecuali commit file terpilih)
├── gitlog.ts             pengurai keluaran git: log, diff, waktu relatif (murni, tanpa GTK)
├── welcome.ts            dokumen contoh saat pertama dibuka
│
├── agent/                asisten AI: konteks naskah dan klien model (tanpa GTK, kecuali yang tertulis)
│   ├── tools.ts          murni: alat penelusuran untuk model (daftar_berkas, cari_dokumen, cari_teks, baca_berkas)
│   ├── context.ts        murni: memecah naskah per heading, pencarian BM25, menyusun konteks dalam anggaran token, memangkas riwayat
│   ├── session.ts        murni: satu percakapan (riwayat) dan loop agen satu giliran (model ↔ alat, termasuk menunggu persetujuan usulan)
│   ├── changes.ts        murni: alat `buat_berkas`/`ubah_berkas`, validasi usulan menjadi `Change`, dan pratinjau selisih; tidak pernah menulis
│   ├── transcript.ts     murni: percakapan ↔ teks Markdown (frontmatter + `## Anda` / `## Asisten`), judul dan nama berkas
│   ├── chatstore.ts      simpan, daftar, muat, dan buang percakapan di `<folder>/.nyerat/chats` (Gio)
│   ├── provider.ts       antarmuka Provider (dipakai klien sungguhan dan penyedia palsu di tes)
│   ├── sse.ts            murni: baca baris aliran SSE (teks, penalaran, potongan pemanggilan alat, usage) dan pesan galat HTTP
│   ├── deepseek.ts       klien DeepSeek lewat libsoup 3 (GIO/GLib; dimuat saat dipakai)
│   ├── project.ts        baca berkas Markdown di folder proyek dengan cache (GLib/GIO)
│   └── apikey.ts         API key: variabel lingkungan, keyring (libsecret), atau file 0600
│
├── markdown/             memahami Markdown (TypeScript murni, tanpa GTK)
│   ├── syntax.ts         regex untuk heading, daftar, kutipan, tabel, penekanan
│   ├── inline.ts         parseInline(): format di dalam satu baris
│   ├── table.ts          tabel: mengenali blok, memecah sel, rapikan, tambah/hapus baris dan kolom
│   ├── kanban.ts         papan kanban: membaca/menulis Markdown, operasi kartu dan daftar, tag dan tanggal
│   ├── pango.ts          isi sel tabel (Markdown inline) → markup Pango untuk Gtk.Label
│   ├── chatmarkup.ts     jawaban asisten (heading, daftar, kutipan, blok kode, inline) → markup Pango
│   ├── dbml.ts           penerjemah DBML (dbdiagram.io) → diagram ER Mermaid
│   └── html.ts           markdownToHtml(): untuk Ekspor HTML
│
├── editor/               mesin editor
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
│   ├── overlays.ts       slot widget overlay yang dipakai ulang oleh gambar, tabel, dan diagram
│   ├── tableedit.ts      Tab/Enter di tabel dan perintah menu Edit Tabel
│   ├── codehighlight.ts  mewarnai isi blok kode sesuai bahasanya
│   ├── tagsync.ts        memasang tag dengan selisih (hanya rentang/baris yang berubah)
│   └── offsets.ts        konversi posisi UTF-16 ↔ code point
│
└── ui/                   komponen antarmuka
    ├── headerbar.ts      tombol dan menu ☰
    ├── sidebar.ts        sidebar bertab: Berkas, Outline, dan Riwayat
    ├── filetree.ts       tab Berkas: pohon folder, menu klik kanan, seret-lepas, dipantau dengan Gio.FileMonitor
    ├── outline.ts        tab Outline: daftar heading
    ├── history.ts        tab Riwayat: commit git untuk file aktif
    ├── historyviewer.ts  jendela baca satu commit: diff dan isi versi itu
    ├── proposalviewer.ts jendela tinjau usulan perubahan agent: diff yang sama, tombol Tolak/Terapkan
    ├── findbar.ts        bilah pencarian (targetnya berpindah mengikuti tab aktif)
    ├── tabbar.ts         baris tab dokumen (tampil jika ada ≥ 2 dokumen)
    ├── statusbar.ts      hitungan kata, posisi kursor, pesan singkat
    ├── dialogs.ts        pilih file, konfirmasi simpan, error, tentang
    ├── menu.ts           menu konteks sebagai data (MenuEntry) → Gtk.PopoverMenu
    ├── imageviewer.ts    penampil gambar dengan zoom (cairo)
    ├── kanban.ts         tampilan papan kanban: daftar, kartu, menu, seret-lepas
    ├── chat.ts           panel Asisten di kanan: pesan, tombol Konteks, pengaturan key dan model
    └── theme.ts          palet warna, font, CSS terang/gelap
tests/
├── run-tests.ts          titik masuk dan pendaftaran tes unit/GUI
├── framework.ts          asersi, hasil tes, opsi CLI, folder sementara
├── fixtures.ts           data papan kanban bersama untuk tes model dan GUI
├── widgets.ts            pembantu tes GUI: tangkapan layar widget, anak widget, klik tiruan lewat GestureClick, posisi layar X11
├── unit/                 tes tanpa jendela: inline, HTML, settings, tabel, kanban, bahasa kode, DBML, operasi berkas, asisten (konteks, SSE, sesi), format berkas percakapan, klien DeepSeek (server tiruan)
│   └── helpers.ts        helper untuk mengambil isi body HTML hasil konversi
├── gui/                  tes editor, file/folder, gambar, tabel, diagram, kanban, riwayat, asisten, ukuran, ketahanan
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
- **Tipe untuk GTK, GLib, dan lainnya** berasal dari paket `@girs/*` (proyek ts-for-gir). Paket-paket itu didaftarkan di [`src/env.d.ts`](src/env.d.ts), sehingga `import Gtk from 'gi://Gtk?version=4.0'` dikenali TypeScript. Paket ini hanya dipakai saat pengecekan tipe dan tidak ikut ke `dist/`.
- **Import antarmodul tetap memakai akhiran `.js`** (misalnya `'./tags.js'`), meskipun filenya `.ts`. TypeScript dan Vite sama-sama memetakannya ke file `.ts`.
- **Input lewat controller GTK 4.** Sinyal `key-press-event`/`button-press-event` GTK 3 sudah tidak ada. Tombol dan klik ditangkap `Gtk.EventControllerKey` dan `Gtk.GestureClick` lewat pembantu `onKeyPress()`/`onClick()` di [`src/gtkutil.ts`](src/gtkutil.ts). Handler-nya menerima angka biasa (keyval, modifier, jumlah klik, posisi), bukan objek event, jadi tes bisa memanggilnya langsung (`MarkdownView.onKey(keyval, state)`, `onClick(n, x, y, state)`).

### Lapisan dan arah ketergantungan

Kode dibagi menjadi lapisan. Setiap lapisan hanya boleh memakai lapisan di bawahnya, tidak pernah ke atas:

```
 app.ts
   └─ window.ts ── actions.ts
        ├─ ui/*            komponen antarmuka
        ├─ editor/*        mesin editor
        │    └─ markdown/* aturan Markdown (tanpa GTK)
        ├─ agent/*         konteks naskah dan klien model (tanpa GTK)
        └─ settings.ts, files.ts, git.ts, gitlog.ts, config.ts
```

- **`agent/`** juga tanpa GTK. `ui/chat.ts` memakainya, dan jendela hanya memberinya cara mengambil naskah (`ChatHost`: dokumen aktif, pilihan, berkas proyek, folder naskah). `agent/` tidak tahu soal editor atau widget.
- **`markdown/`** tidak meng-import GTK sama sekali. Isinya hanya fungsi string → data, jadi paling mudah dipelajari dan diuji.
- **`editor/`** tidak tahu apa-apa soal file, menu, atau sidebar. `MarkdownView` hanya memberi kabar lewat callback (`onHighlighted`, `onCursorMoved`, `onMessage`).
- **`ui/`** berisi komponen yang berdiri sendiri. `Outline` tidak kenal editor; ia hanya menerima daftar heading dan memanggil `onJump(baris)` saat diklik. Begitu juga `FileTree`: ia hanya menampilkan folder dan memanggil `onOpenFile(path)`; yang memutuskan cara membuka file (tab baru, pindah ke tab yang sudah ada, atau memakai ulang dokumen kosong) adalah jendela.
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

### Cara kerja efek sintaks tersembunyi

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

**Menyembunyikan teks tanpa `invisible` (`editor/tags.ts`).** Atribut `invisible` milik GtkTextView di GTK 3 bisa memicu crash *"Byte index is off the end of the line"*. Karena itu tag `hidden` membuat teks sangat kecil dan berwarna sama dengan latar. Hasilnya di layar sama, tapi jalur kode GTK yang bermasalah tidak tersentuh. Cara ini dipertahankan setelah pindah ke GTK 4 karena seluruh tata letak tabel, diagram, dan marker bertumpu padanya.

Ukurannya **bukan 1** (satuan Pango, 1/1024 pt) melainkan 256 (`TINY` di `editor/tags.ts`). Font emoji berwarna adalah font bitmap, dan pada ukuran 1 skalanya menjadi nol sehingga GTK gagal menggambar seluruh jendela (*"invalid matrix (not invertible)"*). Ini ketahuan saat tabel berisi emoji dikecilkan; ada tes yang menjaganya.

**Kolom teks di tengah (`editor/view.ts`).** Margin kiri/kanan dihitung dari lebar area yang terlihat, yaitu `page_size` adjustment horizontal yang diisi TextView saat dialokasikan (GTK 4 tidak punya sinyal `size-allocate`). ScrolledWindow memakai `hscrollbar_policy: EXTERNAL`, bukan `NEVER`. Lebar minimum GtkTextView yang dibungkus sama dengan lebarnya saat ini ditambah margin. Dengan `NEVER`, lebar minimum itu diteruskan ke jendela, sehingga jendela tidak bisa mengecil dan terus membesar setiap margin dihitung ulang.

**Membuka dokumen panjang tanpa membeku (`replaceAllText()` di `editor/view.ts`).** GTK memberi tinggi 0 pada baris yang belum ditata. Jika gambar pertama setelah teks diganti mencakup area di bawah baris yang sudah ditata (cache piksel TextView menggambar setengah layar ekstra, dan `bottom_margin` memperpanjang kanvas), GTK menata *semua* baris sampai akhir dokumen sekaligus di thread utama; naskah 650 KB dulu membeku ±0,6 detik saat dibuka. `replaceAllText()` menolkan posisi gulir lalu mengantre gulir ke kursor, sehingga GTK lebih dulu menata dua layar di sekitar kursor dan sisanya sedikit demi sedikit di latar. Pakai fungsi ini setiap kali mengganti seluruh isi TextView yang bisa panjang (editor, penampil riwayat). Jangan mengubah `bottom_margin` saat runtime: setiap perubahan membuat GTK menata ulang seluruh dokumen. Gulir ke kursor hanya diantre jika TextView sudah punya ukuran: sebelum itu (jendela belum tampil, tab baru di `Gtk.Stack`) GTK 4 menyimpan gulirnya lalu menjalankannya dengan geometri kosong, sehingga dokumen terbuka di tengah atau akhir. Tes `file panjang di tab baru terbuka dari awal` di `tests/gui/tabs.ts` menjaganya.

**Penyorotan bertahap saat membuka (`queueFill()` di `editor/view.ts`).** `setText()` tetap mengurai seluruh dokumen (struktur baris, heading, dan offset dibutuhkan langsung), tetapi tag sintaks dan marker tersembunyi hanya dipasang untuk 200 baris pertama. Sisanya dicicil oleh idle berprioritas `HIGH_IDLE + 22` (≤8 ms per giliran): di atas penataan latar GtkTextView (125) supaya baris ditata sekali dengan tag akhirnya, di bawah menggambar (120) supaya layar tetap diperbarui. Tiap giliran mendahulukan baris di sekitar kursor dan yang terlihat (sebelum GTK selesai menata, area terlihat belum bisa dipercaya karena baris yang belum ditata setinggi 0), jadi melompat ke akhir dokumen tetap menampilkan teks terformat. `LineTagger.defer()`/`fill()` melewati baris yang ditunda; suntingan selama cicilan tetap disorot seperti biasa. Outline juga dibangun 50 baris per giliran. Tes yang memeriksa tag dokumen panjang menunggu `MarkdownView.highlightComplete`.

**Marker tersembunyi bertahap (`MarkerConcealer` di `editor/decorations.ts`).** Tiap ketukan dan perpindahan kursor hanya memeriksa baris aktif lama dan baru, baris yang diurai ulang penyorot (`reparsed` di hasil `highlight()`), dan baris yang tagnya belum diketahui. Pembatas ``` baru bisa mengubah marker baris di bawahnya tanpa menyunting baris itu, karena itu rentang `reparsed` wajib diteruskan. Marker di hasil penyorot urut menurut barisnya (dicari dengan pencarian biner), dan marker/heading/gambar setelah suntingan digeser di tempat karena snapshot lama tidak dipakai lagi.

**Auto save di latar (`writeTextFileAsync()` di `files.ts`).** Auto save dari timer menulis lewat Gio di thread pekerja (file sementara, fsync, lalu rename atomik), jadi jeda fsync di disk lambat tidak terasa saat pengguna lanjut mengetik. Semua penulisan sinkron, pemindahan, dan pembuangan file lewat `files.ts`/`fileops.ts` lebih dulu menunggu penulisan latar ke path yang sama (`waitForWrites()`), supaya isi lama tidak menimpa yang baru. Status *modified* hanya direset jika teks tidak berubah selama ditulis.

### Catatan GTK 4

Nyerat berjalan di GTK 4, GtkSourceView 5, dan WebKitGTK 6.0. Beberapa perilaku GTK 4 (lewat GJS) memengaruhi cara kode ditulis:

- **Sinyal `destroy` tidak berbunyi untuk widget yang masih dipegang JavaScript.** Widget anak baru di-*dispose* saat referensi terakhirnya hilang, dan GJS memegang referensi selama objek JavaScript-nya hidup. Karena itu pembersihan dilakukan eksplisit: `MarkdownView.destroy()` (dipanggil saat tab ditutup) menghentikan idle/timer editor beserta lapisan gambar, tabel, dan diagram; `MainWindow` memanggil `destroy()` semua komponennya saat jendelanya di-*unrealize* (sinyal yang memang berbunyi ketika jendela dihancurkan). Jendela kecil (riwayat, penampil gambar) menandai dirinya tertutup lewat `unrealize` juga.
- **Anak overlay GtkTextView tidak bisa dilepas.** Di GTK 4.14, `gtk_text_view_remove()` tidak mengenal anak yang ditambahkan dengan `add_overlay()` (berakhir dengan *"GtkBox is not a child of GtkSourceView"*). `editor/overlays.ts` meminjamkan slot (`Gtk.Box` yang sudah menjadi overlay) ke gambar, tabel, dan diagram; slot yang dikembalikan dikosongkan, disembunyikan, lalu dipakai blok berikutnya. Penerima klik dipasang di isi slot, bukan di slotnya.
- **Overlay GtkTextView tidak ikut bergulir sendiri.** Posisinya koordinat buffer, dan wadah overlay (`GtkTextViewChild`) menguranginya dengan offset gulir saat dialokasikan. Tetapi di GTK 4.14 offset itu hanya diperbarui di `size_allocate` TextView, dan menggulir tidak mengalokasikan ulang apa pun: gambar, tabel, dan diagram tertinggal di letak lama (tidak tampil atau melayang di atas teks). `OverlaySlots` karena itu meminta alokasi ulang TextView **dan** wadahnya setiap adjustment bergulir (GTK melewati alokasi wadah yang ukurannya tidak berubah). Biaya per langkah gulir tidak terukur (median ±0,22 ms dengan maupun tanpa). Tes `gambar di bawah dokumen panjang tampil di tempatnya setelah digulir` dan tes grid tabel memeriksa letak widget sebenarnya, bukan angka yang disimpan lapisan.
- **`ListBox.remove_all()` ikut membuang placeholder** di GTK 4.14; `removeChildren()` (`gtkutil.ts`) membuang baris satu per satu.
- **Dialog modal lewat main loop bersarang.** `gtk_dialog_run()` sudah tidak ada. `runModal()` (`gtkutil.ts`) menjalankan `GLib.MainLoop` sampai dialog menjawab, sehingga `chooseFile()`, `askSaveChanges()`, dan dialog kanban tetap mengembalikan jawabannya langsung. Pemilih berkas memakai `Gtk.FileDialog` (sudah menanyakan sebelum menimpa; di desktop yang punya xdg-desktop-portal, dialognya dibuka portal). Pesan dan formulir (sunting kartu, prompt) adalah `Gtk.Window` modal sendiri (`modalWindow()` di `ui/dialogs.ts`), bukan `Gtk.AlertDialog` dan tanpa `destroy_with_parent`: keduanya menghubungkan dialog ke sinyal `destroy` jendela induk, dan saat proses keluar GJS bisa memfinalisasi induk lebih dulu sehingga muncul GLib-GObject-CRITICAL.
- **`hexpand`/`vexpand` diteruskan ke atas.** Di GTK 4, widget yang punya anak mengembang ikut mengembang. Sidebar, tab Riwayat, tab Berkas, dan panel Asisten diberi `hexpand: false` eksplisit, supaya tidak ikut dibagi ruang sisa jendela (dijaga tes `tab riwayat tidak membuat sidebar mengembang`). `pack(box, child, expand)` di `gtkutil.ts` menggantikan `pack_start()` dan menyetel ekspansi sesuai orientasi box.
- **Seleksi jangan sampai kosong di tengah suntingan.** Di X11, seleksi yang sempat kosong melepas clipboard PRIMARY, dan GTK 4 membatalkan seleksi berikutnya begitu server mengonfirmasi pelepasan itu. `wrapSelection()` (`editor/editing.ts`) karena itu hanya menyisipkan/menghapus penanda di kedua ujung, tanpa menghapus seluruh seleksi dulu; tanpa itu Ctrl+B kedua tidak melepas `**`.
- **Pohon berkas (GtkTreeView) dan seret-lepas.** Seret memakai `Gtk.DragSource`/`Gtk.DropTarget` sendiri, bukan DnD model TreeView (yang akan memindahkan baris model, padahal yang dipindah berkas di disk). Penanda tujuan memakai seleksi baris, **bukan** `set_drag_dest_row()`: tanpa DnD model, GTK 4.14 crash (segfault) saat menggambar penanda itu. Ikon drag diambil dari tema ikon; widget sebagai ikon (`GtkDragIcon`) memicu Gtk-CRITICAL saat drag selesai.
- **Menu konteks sebagai data.** `Gtk.Menu` sudah tidak ada. Menu klik kanan (pohon berkas, kartu, daftar) dibangun sebagai `MenuEntry[]` (`ui/menu.ts`) lalu diubah menjadi `Gtk.PopoverMenu` beraksi `menu.*`; tes cukup mencari entri dan memanggil `run()`.
- **Tangkapan layar.** `gdk_pixbuf_get_from_window()` sudah tidak ada. `tests/widgets.ts` menggambar widget lewat `Gtk.WidgetPaintable` lalu merendernya menjadi tekstur dengan renderer jendelanya (dipakai `--screenshot` dan `scripts/capture.ts`).

### Cara kerja gambar (`editor/images.ts`)

Gambar tidak dimasukkan ke buffer teks. Jika memakai `GtkTextChildAnchor`, setiap gambar akan menambah karakter ke dokumen dan ke riwayat undo. Sebagai gantinya:

1. `highlighter.ts` mencatat setiap gambar beserta barisnya: `{ line, url, alt }`.
2. `ImageLayer` memuat gambar secara async lewat GIO (file lokal, atau http/https lewat gvfs) dan menyimpannya di cache per URI. Mengetik tidak memuat ulang gambar yang sama.
3. Di bawah baris gambar disediakan ruang kosong dengan tag `pixels_below_lines` setinggi gambarnya.
4. Widget gambar ditempel di atas ruang itu sebagai overlay TextView (slot dari `editor/overlays.ts`, posisinya diatur dengan `move_overlay()`). Posisinya dalam koordinat buffer sehingga ikut bergulir, dan dihitung ulang dari `get_line_yrange()` setiap kali tata letak berubah (perubahan terlihat dari adjustment vertikal).
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
3. Saat tabel perlu tampil sebagai grid, `TableLayer` memecah isinya (`parseTable()`), membuat `Gtk.Label` untuk setiap sel dengan markup Pango dari `markdown/pango.ts` (tebal, miring, kode, tautan), lalu menyusunnya di `Gtk.Grid`. Ukuran tabel diukur dengan dua sel GTK yang dipakai ulang; grid lengkap baru dibuat ketika tabel terlihat. Ukuran disimpan pada blok tabel aktif; cache yang dipakai bersama dibatasi 256 tabel dan 1.024 sel, masing-masing maksimal 1 Mi unit UTF-16 kunci. Mengetik di dalam tabel tidak membangun grid.
4. Ruang kosong disediakan lewat tag `pixels_below_lines` di baris terakhir tabel setinggi grid, lalu grid ditempel di atasnya sebagai overlay (slot dari `editor/overlays.ts`). Saat kursor atau seleksi berpindah, hanya tag tabel yang berganti keadaan yang diubah. Posisi dihitung ulang dari `get_line_yrange()` hanya untuk grid yang terlihat; grid di luar layar disembunyikan tanpa menghapus ruangnya, lalu diposisikan ketika digulir ke layar. Ini mencegah perpindahan kursor memaksa GTK menata seluruh dokumen. Mengubah lebar kolom memakai ulang grid dan mengatur ulang lebar sel tanpa membongkar widget; ellipsize menjaga tinggi tabel tetap sama.
5. Lebar kolom sebesar teks terpanjang. Jika jumlahnya melebihi lebar kolom teks, kolom yang sempit dibiarkan dan sisa ruang dibagi ke kolom yang lebar (`fitColumns()`), lalu teksnya dipotong dengan "…". Lebarnya harus dipaksa dengan `set_size_request`, karena TextView hanya memberi anak widget ukuran minimumnya.
6. Klik sel menaruh kursor di sel itu pada teks mentah (`cellStart()`), yang otomatis membuka tabelnya.
7. `tableedit.ts` membaca ulang dokumen dari buffer setiap kali dipakai (bukan dari hasil penyorotan terakhir), lalu menulis ulang baris tabel dalam satu langkah undo. Perintah menu selalu menghasilkan tabel yang dirapikan, karena menambah atau menghapus kolom mengubah lebar kolom.

### Cara kerja diagram Mermaid (`editor/mermaid.ts`, `mermaidrender.ts`)

Mermaid hanya berjalan di browser (butuh DOM dan pengukuran teks), jadi tidak bisa dipanggil langsung dari GJS.

1. **Perender (`mermaidrender.ts`).** Satu `WebKitWebView` (WebKitGTK 6.0) yang tidak pernah dipasang di jendela memuat `mermaid.min.js`. Skrip itu disalin dari `node_modules/mermaid` ke `dist/` oleh plugin kecil di `vite.config.ts`. Untuk tiap diagram, halaman menjalankan `mermaid.render()` lalu mengirim ukurannya kembali lewat *script message handler*; snapshot seluruh dokumen (WebKit menggambarnya walau view tidak tampil, dan ukurannya mengikuti isi halaman) dipotong seukuran diagram menjadi `GdkPixbuf`. Snapshot dipilih daripada SVG + librsvg karena label Mermaid memakai `<foreignObject>` yang tidak didukung librsvg.
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

**Menyeret.** Tidak memakai drag-and-drop bawaan GTK, melainkan penunjuk sendiri (`Gtk.GestureDrag` di tiap kartu): tekan di kartu, gerakkan lebih dari 6 piksel, lepas. Selama menyeret, kartu bayangan (gambar diam kartu dari `Gtk.WidgetPaintable`, di lapisan `Gtk.Overlay` di atas papan, karena GTK 4 tidak bisa memindahkan jendela popup sendiri) mengikuti penunjuk, kartu asal diredupkan, dan penanda putus-putus menunjukkan tujuan. Tujuan dihitung dari posisi penunjuk: daftar yang melingkupinya (atau yang terdekat), lalu `dropIndex()` menghitung berapa kartu lain yang titik tengahnya di atas penunjuk. Dekat tepi, papan atau daftar tujuan digulir otomatis. Gerakan di bawah 6 piksel dianggap klik biasa dan membuka dialog sunting. Cara ini dipilih supaya perilakunya terkendali dan bisa diuji dengan memanggil `onCardPress()`/`onCardMotion()`/`onCardRelease()` langsung (koordinat kartu).

**Dialog** (`editCardDialog`, `promptDialog`, `confirmDialog`) menahan program sampai ditutup, jadi `KanbanBoard.dialogs` bisa diganti, dan tes memakai pengganti.

### Cara kerja asisten (`agent/*`, `ui/chat.ts`)

Model hanya tahu apa yang dikirim, jadi mutu jawaban ditentukan oleh `agent/context.ts`. Tiap pertanyaan membangun konteks baru (naskah bisa berubah di antara pertanyaan) dalam anggaran token (`DEFAULT_BUDGET` = 48.000 token; 1 token ≈ 3 karakter, sengaja boros). Konteks dibagi dua supaya cache prefiks DeepSeek terpakai:

```
pesan system  (stabil)   instruksi + <peta_proyek> + <dokumen_aktif>     ← sama antar-pertanyaan, jadi prefiksnya di-cache
riwayat       (dipangkas) pertanyaan dan jawaban sebelumnya, tanpa konteks lamanya
pesan user    (berubah)  <konteks_tambahan> + pertanyaan                ← pilihan, kursor, @lampiran, potongan relevan
```

Semua baris naskah yang dikirim diberi nomor di depannya (`12│ teks`, nomor asli di berkasnya, juga pada jendela di sekitar kursor dan pada potongan), sama dengan keluaran `baca_berkas`. Tanpa nomor, model menebak lokasi dan sering meleset; instruksinya melarang mengutip nomor itu sebagai bagian naskah. Tes langsung (`npm run test:live`) memeriksa bahwa tiap kutipan `berkas.md:N` di jawaban menunjuk baris yang benar.

Urutan prioritas dan batas anggarannya: pilihan teks (8%), dokumen aktif (40%; bila lebih panjang diambil jendela baris di sekitar kursor dan sisanya ikut dicari lewat potongan), berkas `@mention` (20% per berkas), peta proyek (6%; makin ringkas jika berkasnya banyak), lalu potongan relevan (40%, paling banyak 10). Potongan berasal dari memecah tiap berkas per heading (bagian panjang dipecah di baris kosong) dan diurutkan dengan BM25 atas kata kunci pertanyaan (bobot 1), pilihan (0,5), dan dua pertanyaan sebelumnya (0,4); kata umum dibuang dan akhiran seperti *-nya*/*-kan* dikupas seadanya. Tidak ada embedding, jadi tanpa unduhan model dan tanpa pengiriman naskah hanya untuk pencarian. Riwayat dibatasi 25% anggaran, dibuang berpasangan dari yang tertua.

`ChatSession.ask()` membangun konteks lalu menjalankan **loop agen**: memanggil `Provider.chat()` dengan empat alat baca (ditambah `buat_berkas` dan `ubah_berkas` bila ada handler `onProposal`); jika model meminta alat (`toolCalls`), `runTool()` menjalankannya atas daftar berkas (isi editor untuk dokumen aktif, bukan versi disk), hasilnya ditambahkan sebagai pesan `tool`, dan model dipanggil lagi, sampai ia menjawab. Batasnya: 10 putaran per pertanyaan (putaran terakhir dipanggil tanpa alat supaya selalu berakhir dengan jawaban), 6.000 token per hasil alat (berkas panjang dipotong dengan petunjuk `dari_baris` berikutnya), dan total hasil alat per pertanyaan sebesar anggaran konteks; setelah itu alat menjawab "anggaran habis". Argumen yang salah atau berkas yang tidak ada dikembalikan sebagai teks sehingga model bisa memperbaikinya, bukan galat. Pemanggilan alat dan hasilnya hanya hidup selama giliran itu; riwayat tetap hanya pertanyaan dan jawaban. Saat mode berpikir menyala, `reasoning_content` dikembalikan bersama `tool_calls` seperti yang diwajibkan API DeepSeek. Setelah selesai, pasangan tanya-jawab disimpan ke riwayat (galat tidak menambah riwayat; jawaban yang dihentikan di tengah tetap disimpan), lalu `ChatPanel.persist()` menulis seluruh riwayat ke berkas percakapan lewat `chatstore.ts`; `openChat()` memulihkannya lewat `ChatSession.restore()`. `DeepSeek` memanggil `POST /chat/completions` dengan `stream: true` lewat libsoup 3 dan membaca aliran SSE baris demi baris (`Gio.DataInputStream`); pembatalan lewat `Gio.Cancellable`. Panel menggabungkan pembaruan jawaban (±15 kali per detik) dan menampilkan jawaban lewat `chatMarkup()`, yang tahan terhadap teks yang terpotong di tengah blok kode atau penebalan. Tes memakai `Provider` palsu, dan klien sungguhan diuji terhadap server SSE tiruan di 127.0.0.1.

### Cara kerja zoom gambar (`ui/imageviewer.ts`)

1. Setiap gambar di editor (`Gtk.Picture`) punya `Gtk.GestureClick` sendiri, sehingga klik ganda tahu gambar mana yang dimaksud jika satu baris memuat beberapa gambar. Satu klik tetap membuka sintaksnya (`onActivate`); klik ganda (klik ke-2 dari gesture) memanggil `onZoom`, dan menu *Perbesar Gambar* memanggil `MarkdownView.zoomImage()` untuk baris kursor.
2. `ImageLayer.imageAt()` memberikan **pixbuf ukuran penuh** dari cache (gambar di editor hanya salinan yang diperkecil), jadi penampil menampilkan resolusi aslinya.
3. `MarkdownView` tidak membuka jendela sendiri. Ia memanggil `onViewImage`, dan `MainWindow` yang membuka `ImageViewer`, sehingga lapisan `editor/` tetap tidak bergantung pada `ui/`.
4. `ImageViewer` menggambar dengan cairo pada skala zoom di `Gtk.DrawingArea` (`set_draw_func()`), bukan membuat salinan yang diperbesar, jadi zoom 800% pada foto besar tidak menghabiskan memori. Zoom mulai 300% memakai filter `NEAREST` supaya piksel tampil apa adanya.
5. Zoom dibatasi 5%–800%, berkelipatan 1,25 (roda mouse lewat `Gtk.EventControllerScroll`; geser lewat `Gtk.GestureDrag` di ScrolledWindow yang tidak ikut bergeser). Saat roda mouse diputar di atas gambar, titik gambar di bawah penunjuk dijaga tidak bergeser: titik itu dihitung dalam koordinat gambar, lalu posisi gulir diatur ulang setelah tata letak selesai.
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
2. `src/editor/tags.ts` → `highlighter.ts` → `decorations.ts`: inti efek sintaks tersembunyi
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

Disimpan di `$XDG_CONFIG_HOME/nyerat/settings.json` (bawaan `~/.config/nyerat/settings.json`): mode gelap, sidebar dan tab yang terakhir dipilih (Berkas, Outline, atau Riwayat), folder yang terakhir dibuka, tab berfile yang terbuka saat jendela ditutup (urutan, tab aktif, dan posisi kursor), mode fokus, mode typewriter, auto save, ukuran jendela, panel Asisten (terbuka atau tidak) beserta model dan mode berpikirnya, dan penanda bahwa dokumen contoh sudah pernah ditampilkan.

Nilai bawaan: sidebar terbuka pada tab Outline, panel Asisten tertutup dengan model `deepseek-flash` tanpa mode berpikir, fokus/typewriter mati, ukuran jendela 1100 × 760 piksel, dan mode gelap mengikuti tema sistem (`dark: null`). Setelah mode gelap dipilih lewat menu, pilihan itu disimpan. Ukuran awal jendela dibatasi ke area kerja monitor. Mode source dan pilihan tampilan papan/teks tidak disimpan antar proses.

## Keterbatasan

- Asisten: hanya DeepSeek, chat dengan usulan perubahan yang disetujui (belum ada pemeriksaan kontradiksi otomatis; kontradiksi bisa ditanyakan lewat chat dan model menelusurinya sendiri). Usulan perubahan: hanya Markdown di folder kerja dan hanya satu penggantian persis per panggilan (tanpa hapus, ganti nama, atau pindah berkas); usulan yang disetujui tidak tercatat di riwayat percakapan selain lewat jawaban model. Riwayat percakapan hanya disimpan teksnya (pertanyaan dan jawaban): rincian konteks, penelusuran, proses berpikir, dan pemakaian token tidak ikut, jadi tidak tampil lagi saat percakapan dibuka. Riwayat tidak bisa dicari dari panel (cari lewat berkasnya), dan percakapan yang dipindah ke folder lain di tengah jalan dilanjutkan sebagai berkas baru di folder tujuan. Pencarian (`cari_dokumen` dan potongan otomatis) berbasis kata kunci (BM25), bukan makna, jadi kualitas penelusuran bergantung pada kata kunci yang dipilih model; `cari_teks` mencari teks persis dan tidak mengenali sinonim atau ejaan berbeda. Penelusuran memakan putaran model sehingga pertanyaan yang luas lebih lambat dan memakai lebih banyak token. Nama model mengikuti dokumentasi DeepSeek saat ini; jika API menolak nama model, galatnya tampil di panel. Perkiraan token kasar (3 karakter per token). Jawaban tampil sebagai teks terformat, bukan Markdown penuh (tanpa tabel dan gambar)
- Tab: hanya tab berfile yang dipulihkan (dokumen yang belum pernah disimpan tidak), dan daftarnya dicatat saat jendela ditutup, jadi jika aplikasi berhenti mendadak yang dipulihkan adalah sesi sebelumnya. Dengan beberapa jendela, jendela yang terakhir ditutup yang menentukan. Riwayat undo, posisi gulir persis, dan tampilan teks/papan tidak ikut dipulihkan (gulir mengikuti kursor), dan semua tab dibuka penuh saat aplikasi dimulai. Belum ada tampilan berdampingan atau pengurutan tab dengan seret, dan semua tab berbagi satu tampilan papan kanban (posisi gulir papan hilang saat berpindah tab). Baris perintah hanya membuka satu file atau folder
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
- Parsing suntingan sudah bertahap, tetapi penyesuaian array offset/metadata masih sebanding dengan jumlah baris (salinan array sekali per ketukan; ±0,4 ms pada naskah 650 KB). Membuka dokumen atau mengubah konteks fence sampai akhir tetap mengurai seluruh dokumen secara sinkron (membuka naskah 650 KB: jeda terpanjang ±70 ms, yaitu `set_text` GTK ±30 ms dan penguraian ±30 ms; pemasangan tag dicicil); kenyamanan GUI pada puluhan ribu baris dengan banyak tabel belum terverifikasi karena benchmark ekstrem masih menemui callback GJS yang terblokir saat GC.
