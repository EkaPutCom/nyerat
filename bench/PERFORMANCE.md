# Pengukuran optimasi editor — 4 Oktober 2026

Perbandingan baseline yang tersimpan pada commit `a7e4444` dengan hasil optimasi
pada lingkungan yang sama: GJS/GLib/GTK yang sama, backend X11 di Xvfb, 10
pengulangan setelah pemanasan, ukuran GUI 25/50/100 blok. Angka adalah hasil
benchmark sintetis pada mesin ini, bukan jaminan untuk semua perangkat/dokumen.

## Dokumen 100 blok (~30 KB)

Median dalam milidetik; kolom terakhir adalah penurunan waktu.

| Operasi | Sebelum | Sesudah | Penurunan |
| --- | ---: | ---: | ---: |
| setText + sorot + layout | 412.15 | 360.74 | 12% |
| highlight() ulang | 20.19 | 1.04 | 95% |
| ketik per karakter | 20.85 | 2.55 | 88% |
| paste besar + Unicode | 189.36 | 166.45 | 12% |
| hapus teks besar | 42.54 | 4.70 | 89% |
| undo paste besar | 43.24 | 4.54 | 90% |
| redo paste besar | 210.02 | 187.16 | 11% |

Latensi mengetik per karakter: p95 30.14 → 10.32 ms;
maksimum sampel 77.45 → 22.78 ms.
Sampel mentah dan metadata hasil baru tersimpan di [baseline.json](baseline.json).

Pada run lanjutan setelah parsing rentang, median mengetik turun dari 4,91 menjadi
2,55 ms dan penyorotan ulang dari 4,84 menjadi 1,04 ms. Beberapa operasi tercatat
lebih lambat dibanding tahap cache sebelumnya: membuka teks 283,13 → 360,74 ms,
paste 138,60 → 166,45 ms, redo 154,28 → 187,16 ms, dan perpindahan kursor
20 baris 123,63 → 185,87 ms. Pada 50 blok, perpindahan kursor juga naik
61,11 → 151,04 ms. Run ini belum memisahkan derau lingkungan dari regresi;
angka tersebut perlu ditelusuri sebelum menyatakan semua interaksi sudah nyaman.

## Perubahan

- Pakai ulang hasil parsing baris yang tidak berubah, dengan offset relatif.
  Suntingan hanya membaca baris buffer yang berubah dan mengurai rentang sampai
  batas konteks kode/tabel yang aman. Pembatas kode baru memperluas rentang bila perlu.
  Jumlah kata/karakter diperbarui dari rentang itu, tanpa menggabungkan teks lengkap.
- Pertahankan tag tabel/warna kode saat teks di luar blok disunting. GTK sudah
  menggeser tag mengikuti perubahan teks; widget tabel tetap diperbarui posisinya.
- Batalkan penyorotan antre saat `setText()` sudah menyorot langsung, dan gabungkan
  rentang tag yang bersebelahan saat memasang tag pada banyak baris sekaligus.
- Perbarui bagian outline yang berubah; pergeseran nomor baris tidak membangun
  ulang label. Ini juga mengurangi jeda saat heading berubah menjadi paragraf.
- Parser inline membuat salinan karakter/string hanya ketika masking berubah.
  Penghitungan code point tidak lagi membuat array karakter untuk seluruh teks.

## Validasi dan batas cakupan

Tes membandingkan cache dengan parser baru setelah perubahan konteks kode/tabel,
Unicode, undo/redo, dan penghapusan teks. Tes juga memeriksa satu callback setelah
`setText()`, pewarnaan kode setelah offset bergeser, pemakaian ulang outline,
dan klik grid setelah baris bergeser. Rangkaian tes mencakup mouse kanban di Xvfb: **224 lulus, 0 gagal**, tanpa
peringatan kritis pada pemeriksaan log terakhir. Typecheck dan pemeriksaan diff juga lolos.

Tes tambahan membandingkan 200 rangkaian suntingan acak dengan parser penuh,
termasuk tag dan offset Unicode. Pada 50.000 baris tanpa baris kosong, satu suntingan
hanya melakukan satu pembacaan buffer kurang dari 100 karakter dan mengurai paling
banyak empat baris. Ini bukti cakupan parsing, bukan pengukuran latensi GUI.
Suntingan dalam blok kode/tabel mengurai ulang blok terkait; fence yang berubah
dapat memperluasnya sampai akhir dokumen. Array offset/metadata dan pemeriksaan
tag masih membutuhkan pekerjaan sebanding
dengan jumlah baris.

Uji ekstrem 500 blok (~148 KB, 500 grid tabel) masih memicu callback GJS yang
terblokir saat GC dan belum menghasilkan pengukuran lengkap yang valid. Percobaan
mengubah loop, GC paksa, dan referensi widget belum menyelesaikannya dan tidak
masuk perubahan akhir. Jangan menganggap kasus ini sudah responsif. Proses GUI
benchmark kini dibatasi 120 detik (`--timeout=...`) agar macet terdeteksi dan hasil
parsial tidak menjadi baseline. Pengujian batas waktu 1 detik menghasilkan kode
keluar 1 dan tidak menyimpan JSON.

Rendering gambar/diagram asinkron dan latensi interaksi kanban belum dicakup
benchmark. Pemeriksaan kebenaran fitur tersebut tetap ada pada rangkaian tes GUI.

Fixture `long` juga menguji 20.000 baris (~1,3 MB) tanpa grid tabel. Pengukuran GUI
setelah perubahan parsing masih menemui callback GJS yang terblokir saat GC dan
tidak menyimpan baseline parsial. Hasil tersebut belum membuktikan latensi GUI
yang nyaman pada dokumen sebesar ini.

## Auto save (2026-10-04)

Skenario baru `auto save (tulis file)` mengukur `MainWindow.autosave()`: menulis seluruh
dokumen ke disk setelah satu ketukan. Handler `changed` hanya mencatat waktu; timer tidak
dibuat ulang per ketukan, sehingga `ketik per karakter` tidak berubah berarti. Hasil
(Xvfb, 10 pengulangan): fixture `mixed` median 4,0/4,9/5,6 ms (7/15/30 KB), p95 sampai
38 ms; fixture `long` median 3,5/3,6/3,9 ms (16/32/64 KB), p95 sampai 24 ms. Lonjakan
p95 berasal dari penulisan file yang sinkron di thread utama dan terjadi sekali per
jeda mengetik, bukan per ketukan. Skenario lain dalam `bench:compare` tetap dalam
rentang derau (mis. `hapus teks besar` 7 KB berfluktuasi 11–14 ms antar-run). Baseline
belum diperbarui; skenario baru belum punya pembanding. Dokumen ≥1 MB belum diukur.


## Menulis buku (2026-10-04)

Fixture baru `buku` meniru naskah novel: paragraf satu baris panjang yang dibungkus editor,
dialog, kutipan, `*miring*`/`**tebal**`, bab tiap 10 adegan. 400 blok ≈ 651 KB ≈ 100.000 kata
(seukuran novel dalam satu file). Skenario baru: `buka: jeda terpanjang` (jeda main loop
terpanjang sejak setText sampai GTK selesai menata, yaitu yang terasa sebagai membeku),
`ketik lewat view (paragraf)` (sinyal keybinding TextView di akhir paragraf panjang, jalur
yang sama dengan tombol sungguhan), `Enter paragraf baru`, dan `auto save latar (thread utama)`.

Sebelum/sesudah pada 651 KB (Xvfb, 10 pengulangan, median; p95 dalam kurung). Kolom "sebelum"
diukur dengan kode `src/` commit `ce74a34` dan bench yang sama.

| Operasi | Sebelum | Sesudah |
| --- | ---: | ---: |
| buka: jeda terpanjang | 668.9 (671.0) | 162.4 (171.2) |
| setText + sorot + layout | 1434.1 | 761.1 |
| ketik per karakter | 2.91 (5.99) | 1.82 (5.00) |
| ketik lewat view (paragraf) | 3.53 (12.94) | 2.61 (11.59) |
| Enter paragraf baru | 6.05 (14.81) | 3.25 (12.62) |
| pindah kursor 20 baris | 24.01 | 11.93 |
| auto save, bagian thread utama | 9.59 (17.07)¹ | 5.33 (7.46) |

¹ Sebelumnya auto save menulis dan fsync secara sinkron. Di NVMe mesin ini hanya ±4 ms,
tetapi di disk lambat atau sibuk fsync bisa puluhan milidetik, tepat saat pengguna lanjut mengetik.

Pada mixed 100 blok (`bench:compare`): ketik per karakter 2.55 → 1.39 ms, setText 360.74 →
227.23 ms, pindah kursor 50 blok 151.04 → 71.80 ms; skenario lain dalam rentang derau.
`markdownToHtml` sempat tercatat +37% pada satu run, padahal `src/markdown/` tidak berubah;
tiga run ulang memberi 7.2–8.0 ms (baseline 7.26 ms), jadi itu derau.

### Penyebab dan perbaikan

- **Membuka dokumen membeku ±0,6 detik.** GTK 3 memberi tinggi 0 pada baris yang belum
  ditata. Gambar pertama setelah `set_text` (cache piksel TextView menggambar setengah layar
  ekstra; `bottom_margin` memperpanjang kanvas) mencakup area di bawah baris yang sudah ditata,
  sehingga `gtk_text_layout_draw` menata semua baris sampai akhir dokumen sekaligus. Terbukti
  dengan TextView polos (tanpa kode Nyerat): `bottom_margin` 1 px saja sudah cukup memicunya.
  `replaceAllText()` menolkan gulir lalu mengantre gulir ke kursor, sehingga GTK lebih dulu
  menata dua layar di sekitar kursor dan sisanya di latar. Sisa 162 ms adalah penyorotan
  penuh yang sinkron (sekali saat membuka). Percobaan melepas `bottom_margin` sementara
  ditolak: `set_bottom_margin()` membuat GTK menata ulang seluruh dokumen, dan paste 12 KB
  di naskah 650 KB menjadi lebih dari 1 detik kerja latar.
- **Marker tersembunyi dihitung untuk semua baris tiap ketukan/perpindahan kursor** (±1 ms dan
  ribuan array baru di 650 KB). Kini `MarkerConcealer` hanya memeriksa baris aktif lama/baru,
  baris yang diurai ulang, dan baris yang belum diketahui.
- **Penggabungan cache penyorot** membuat beberapa salinan array seukuran dokumen dan satu
  tuple baru per marker setelah suntingan (±1 ms). Kini satu salinan per array, pencarian
  biner, dan pergeseran di tempat (±0,4 ms).
- **Outline** membuat string JSON semua heading tiap ketukan; kini dibandingkan langsung.
- **Auto save** dari timer menulis lewat Gio di thread pekerja; penulisan sinkron berikutnya
  ke path yang sama menunggu penulisan latar (tesnya memastikan isi lama tidak menimpa isi baru).

### Batas pengukuran

Bench mengukur sampai main loop menganggur (penyorotan dan tata letak), tidak termasuk
menggambar layar. Di Xvfb tanpa window manager, sinyal `draw` TextView tidak selalu muncul,
jadi waktu menggambar tidak bisa diukur andal; lonjakan p95 ±10–12 ms pada `ketik lewat view`
muncul juga di 50 blok (tidak sebanding panjang dokumen) dan cocok dengan frame clock yang
menggambar di tengah pengukuran. Penyorotan penuh saat membuka masih sebanding panjang
dokumen; dokumen ≥1 MB dan dokumen yang sangat banyak tabelnya (perpindahan kursor ±7 ms per
baris pada mixed 100 blok, dari lapisan tabel) belum dioptimasi.

Baseline: [baseline.json](baseline.json) (mixed, bawaan `bench:compare`) dan
[baseline-buku.json](baseline-buku.json); bandingkan naskah buku dengan
`gjs -m dist/bench.js --fixture=buku --size=400 --sizes=50,200,400 --timeout=400 --compare=bench/baseline-buku.json`.

## Penyorotan bertahap saat membuka (2026-10-04)

Profil membuka naskah 650 KB yang berbeda dari dokumen sebelumnya (outline ikut dibangun
ulang): `set_text` GTK 29 ms, penguraian 31 ms, tag sintaks seluruh buffer 60 ms, outline
440 baris 54 ms, marker tersembunyi 33 ms, sehingga ±207 ms tertahan. Skenario
`buka: jeda terpanjang` kini bergantian antara dua dokumen dengan heading berbeda supaya
biaya outline ikut terukur (sebelumnya dokumen yang sama dibuka ulang, outline tidak berubah).

Perubahan: tag sintaks dan marker tersembunyi hanya dipasang untuk 200 baris pertama; sisanya
dicicil per ≤8 ms di idle berprioritas di antara menggambar (120) dan penataan latar GTK (125),
mendahulukan baris di sekitar kursor dan yang terlihat. Outline dibangun 50 baris per giliran. Penguraian tetap
penuh dan sinkron.

Hasil (median, Xvfb, 10 pengulangan; "sebelum" = baseline commit `472c298`, skenario lama
yang membuka dokumen yang sama, jadi penurunannya sebenarnya lebih besar):

| Dokumen | buka: jeda terpanjang sebelum | sesudah |
| --- | ---: | ---: |
| buku 81 KB | 18.47 | 13.01 |
| buku 325 KB | 70.99 | 34.49 |
| buku 651 KB | 162.41 | 71.45 (p95 79.50) |
| mixed 30 KB | 134.41 | 46.75 |

Skenario lain dalam rentang derau. Biaya: total sampai semua tag terpasang dan GTK selesai
menata naik ±10% (buku 651 KB: 761 → 820 ms) karena kerja dicicil, dan `highlight() ulang`
tanpa suntingan 0.41 → 0.6–0.9 ms karena pemeriksaan baris yang ditunda; keduanya tidak
terasa saat mengetik. Sisa jeda membuka adalah `set_text` GTK dan penguraian penuh.

## Perpindahan kursor pada dokumen bertabel (2026-10-04)

Lapisan tabel kini mengubah tag hanya pada tabel yang berganti antara grid dan teks
mentah saat kursor/seleksi berpindah. Tidak lagi menelusuri rentang tag semua tabel
atau membuat string signature seluruh tabel pada setiap perpindahan. Perhitungan
posisi `get_line_yrange()` dibatasi pada grid yang terlihat: grid di luar layar
disembunyikan, ruangnya tetap dipertahankan oleh tag, dan posisinya diperbarui saat
gulir berubah. Sebelumnya permintaan posisi semua grid memaksa GTK menata ulang
baris sampai jauh di luar layar setelah tinggi satu tabel berubah.

Pengukuran sebelum/sesudah dalam sesi yang sama, fixture `mixed`, X11/Xvfb,
GJS 1.80.2, GTK 3.24.41, 10 pengulangan setelah pemanasan. Semua angka dalam ms;
p95 dan maksimum sama karena skenario ini hanya memiliki 10 sampel.

| Dokumen | Median sebelum → sesudah | p95 sebelum → sesudah | Maksimum sebelum → sesudah |
| --- | ---: | ---: | ---: |
| mixed 7 KB, pindah kursor 20 baris | 44.29 → 19.30 | 49.88 → 26.45 | 49.88 → 26.45 |
| mixed 15 KB, pindah kursor 20 baris | 66.66 → 27.50 | 78.25 → 32.29 | 78.25 → 32.29 |
| mixed 30 KB, pindah kursor 20 baris | 132.52 → 29.59 | 150.00 → 42.65 | 150.00 → 42.65 |

Untuk mixed 30 KB, median turun 78% terhadap pengukuran sebelum dalam sesi ini,
atau 80% terhadap baseline tersimpan (145.26 ms, p95/maksimum 155.38 ms).
Ketik per karakter tetap 1.47 → 1.51 ms (p95 5.98 → 5.79, maksimum 23.42 → 15.27).
Hapus teks besar 4.43 → 2.77 ms, undo 3.96 → 3.05 ms.

Ada kenaikan yang dicatat: total membuka mixed 30 KB 245.42 → 264.53 ms
(p95/maksimum 271.92 → 285.35), paste 135.67 → 148.99 ms
(p95/maksimum 180.92 → 162.10), dan redo 155.49 → 165.72 ms
(p95/maksimum 216.64 → 174.14). Pembuatan awal seluruh grid dan sinkronisasi tag
setelah suntingan masih dilakukan; optimasi ini berfokus pada perpindahan kursor.
Hasil tahap antara yang berjalan bersama tes GUI tidak dipakai untuk angka akhir.
Baseline lama tetap dipertahankan agar kenaikan ini tetap terlihat dalam `bench:compare`.

Validasi: `npm test` **383 lulus, 0 gagal**, termasuk pemeriksaan tag tabel lain
tidak disentuh, seleksi lintas tabel, pemakaian ulang widget, serta gulir ke grid
akhir dan kembali tanpa mengubah tinggi dokumen. Log lengkap diperiksa, tanpa
peringatan/galat runtime. Typecheck dan pemeriksaan diff lolos. Screenshot tema
terang dan gelap diperiksa saat kedua tabel bergantian menjadi teks mentah dan
kembali ke grid; grid dan paragraf tidak bertumpuk. `test:ui` pada desktop tidak
dijalankan karena mode tes yang ditampilkan tidak diminta (aturan lingkungan tes
AGENT.md); tes mouse dijalankan pada Xvfb. Kasus ekstrem 500 grid dan dokumen
20.000 baris belum diukur ulang; perbaikan ini tidak membuktikan masalah GC pada
kasus tersebut selesai.

Pemeriksaan regresi fixture `buku` juga selesai untuk 50/200/400 blok, 10
pengulangan, X11/Xvfb dan lingkungan baseline yang sama. Pada buku 651 KB:

| Operasi | Median baseline → sesudah | p95 baseline → sesudah | Maksimum baseline → sesudah |
| --- | ---: | ---: | ---: |
| pindah kursor 20 baris | 14.67 → 13.69 | 17.09 → 16.68 | 17.09 → 16.68 |
| ketik per karakter | 2.03 → 2.08 | 4.65 → 4.99 | 15.46 → 16.07 |
| buka: jeda terpanjang | 71.45 → 72.25 | 79.50 → 81.41 | 79.50 → 81.41 |
| setText + sorot + layout | 820.16 → 843.38 | 869.32 → 889.24 | 869.32 → 889.24 |

Perubahan utama buku berada dalam ±7% median; belum ada bukti regresi berarti
untuk kursor/mengetik. Ini pembanding terhadap baseline tersimpan, bukan pengukuran
sebelum baru untuk fixture buku. Log benchmark mixed dan buku bersih. Pengukuran
tetap sampai main loop menganggur, bukan durasi lengkap menggambar layar.

Run ulang terpisah mixed 100 blok (10 pengulangan, lingkungan sama) mengonfirmasi:
kursor median **29.06 ms**, p95/maksimum **41.24 ms**; setText median **260.76 ms**,
p95/maksimum **292.79 ms**; paste median **146.02 ms**, p95/maksimum **159.53 ms**.
Dengan demikian perbaikan kursor konsisten, sedangkan kenaikan total membuka
sekitar 7–9% terhadap baseline tersimpan tetap terlihat dan tidak dihapus lewat
penggantian baseline. Kenaikan ini kecil tetapi belum dipisahkan antara biaya
menyembunyikan grid awal dan derau lingkungan. Pemeriksaan log run ulang juga bersih.

## Pembuatan grid tabel saat membuka (2026-10-04)

Grid lengkap sekarang dibuat ketika tabel masuk ke layar. Dua sel GTK pengukur
memakai CSS yang sama untuk menyediakan tinggi tabel sebelum grid dibuat;
ukuran dan markup disimpan pada blok aktif. Cache bersama dibatasi 256 tabel,
1.024 sel, dan masing-masing 1 Mi unit UTF-16 kunci. Perubahan lebar memakai
ulang sel dengan ellipsize, sehingga tidak membongkar grid atau memasang ulang
tag tinggi. Pergantian palet menghapus hasil pengukuran. Penyorotan bertahap
juga tidak lagi mempercayai rentang ribuan baris yang dianggap terlihat sebelum
GTK memvalidasi tinggi baris.

Pembanding membuka pertama memakai tiga proses GJS/Xvfb terpisah per varian,
satu jendela baru per proses, 500 blok fixture mixed, lalu `setText` ulang isi
yang sama. Varian berbeda mengganti satu sel pada tiap tabel. Sumber sebelum
adalah `tablelayer.ts` dan `view.ts` pada HEAD `7080c4e`; sumber sesudah adalah
working tree perubahan ini. GJS 1.80.2, GTK 3.24.41, X11/Xvfb, host c640.
Timer main loop 1 ms mengukur jeda terpanjang; total sampai idle GTK dan
penyorotan selesai, bukan sampai semua piksel layar selesai digambar.
GC dipanggil sebelum pengukuran. Sampel mentah beserta jumlah panggilan ada di
[table-opening-profile.json](table-opening-profile.json). Waktu metode bersifat
inklusif, sehingga tidak boleh dijumlahkan.

Semua angka ms. Untuk tiga sampel, p95 dengan nearest rank sama dengan maksimum;
sampel kecil ini merupakan diagnosis, bukan estimasi distribusi produksi.

| Skenario | Median sebelum → sesudah | p95/maksimum sebelum → sesudah |
| --- | ---: | ---: |
| 500 tabel identik, buka pertama: total | 8249.69 → 2019.03 | 8274.09 → 2044.20 |
| 500 tabel identik, buka pertama: jeda | 1916.57 → 256.49 | 1931.16 → 262.93 |
| 500 tabel berbeda, buka pertama: total | 8304.25 → 2153.29 | 8643.93 → 2158.40 |
| 500 tabel berbeda, buka pertama: jeda | 1927.89 → 353.56 | 1963.84 → 364.34 |
| 500 tabel identik, buka ulang: total | 3395.40 → 1699.07 | 3415.86 → 1725.12 |
| 500 tabel identik, buka ulang: jeda | 641.19 → 556.91 | 660.89 → 577.63 |
| 500 tabel berbeda, buka ulang: total | 3400.55 → 1702.07 | 3503.12 → 1823.32 |
| 500 tabel berbeda, buka ulang: jeda | 641.82 → 572.32 | 645.41 → 581.96 |

Pada kedua varian, membuka pertama membuat **1 grid** untuk 1 tabel terlihat,
sebelumnya 500 grid. Panggilan `build` turun **1000 → 1**: implementasi lama
membangun semua grid lagi ketika lebar awal 700 berubah menjadi 781 px.
Total membuka pertama turun 76% untuk tabel identik dan 74% untuk tabel berbeda.
Widget yang pernah terlihat tetap dipakai ulang; ini belum membatasi jumlah
widget setelah pengguna menggulir seluruh dokumen.

Benchmark GUI mixed 500 blok sesudah pemanasan berhasil menyelesaikan seluruh
14 operasi dengan 10 pengulangan, hasil di [tables-500.json](tables-500.json).

| Operasi | Median | p95 | Maksimum |
| --- | ---: | ---: | ---: |
| setText + sorot + layout | 1679.04 | 1827.03 | 1827.03 |
| buka: jeda terpanjang | 605.28 | 741.70 | 741.70 |
| ketik per karakter | 3.91 | 10.29 | 18.71 |
| ketik lewat view | 14.90 | 25.86 | 28.77 |
| Enter paragraf | 12.45 | 14.44 | 14.44 |
| paste besar + Unicode | 157.20 | 168.30 | 168.30 |
| hapus teks besar | 5.40 | 6.46 | 6.46 |
| undo paste besar | 5.09 | 6.75 | 6.75 |
| redo paste besar | 177.00 | 191.11 | 191.11 |
| pindah kursor 20 baris | 27.76 | 42.95 | 42.95 |

Proses lengkap ini memerlukan sekitar **198 detik**, memakai batas subprocess
diagnostik 900 detik dan `--child` untuk melewati batas runner induk. Run lama
berbatas 180 detik yang berhenti di tengah tidak dipakai sebagai baseline.
Dengan demikian perbaikan pembuatan grid terbukti, tetapi jeda membuka ulang
sekitar 0,6 detik dan lamanya rangkaian 500 blok masih perlu ditangani; ini bukan
bukti seluruh masalah freeze/GC atau timeout selesai.

`npm run bench:compare` lengkap dijalankan dua kali, tanpa tes GUI bersamaan.
Pada mixed 100 blok, total 229.44/213.61 ms, jeda 40.00/43.74 ms, mengetik
1.24/1.51 ms per karakter. Baseline kursor yang lebih tua sudah mendahului
optimasi kursor sebelumnya; penurunan kursor terhadap baseline itu tidak boleh
seluruhnya diatribusikan pada perubahan ini. Variasi masih terlihat: mixed 25
paste 200.45 lalu 158.80 ms (baseline 134.21), mengetik lewat view 3.75 lalu
2.98 ms (baseline 1.95), sedangkan redo mixed 50 mencapai 203.44 ms pada run
ulang (baseline 151.07). Modul Markdown murni tidak berubah, tetapi
`markdownToHtml` juga bergeser 10.27 → 8.35 ms dan `findTables` 0.43 → 0.27 ms;
ini menunjukkan variasi lingkungan, bukan alasan menghapus kenaikan operasi GUI.

Fixture buku diperiksa lengkap pada 50/200/400 blok, masing-masing 10
pengulangan. Pada buku 651 KB, median/p95/maksimum jeda membuka
**65.78/79.59/79.59 ms**, mengetik **1.87/4.76/15.09 ms** per karakter.
Kenaikan terhadap baseline tersimpan tetap dicatat: total membuka
820.16 → 904.69 ms (p95/maksimum 869.32 → 944.62), Enter
3.35 → 5.05 ms (p95/maksimum 11.59 sesudah), dan redo
165.55 → 183.47 ms (p95/maksimum 196.63 sesudah). Ini belum membuktikan
peningkatan total membuka dokumen tanpa tabel.

Fixture long 2.000 blok (~1,3 MB) diukur sebelum/sesudah secara berurutan,
masing-masing tiga pengulangan, bukan hanya dibanding baseline historis:

| Operasi | Median sebelum → sesudah | p95/maksimum sebelum → sesudah |
| --- | ---: | ---: |
| setText + sorot + layout | 1925.10 → 2031.42 | 1991.04 → 2083.39 |
| buka: jeda terpanjang | 127.73 → 141.62 | 133.74 → 143.03 |
| Enter paragraf | 13.43 → 8.69 | 15.89 → 15.98 |
| paste besar + Unicode | 159.26 → 163.48 | 168.55 → 176.29 |
| redo paste besar | 189.82 → 199.13 | 196.53 → 215.36 |
| pindah kursor 20 baris | 26.13 → 27.94 | 30.00 → 28.09 |

Mengetik per karakter long 5.74 → 4.90 ms, p95 16.18 → 7.99,
maksimum 30.56 → 26.11. Total membuka long naik 5,5% dan jeda naik 10,9%
(~14 ms). Pembatasan prioritas tag dapat mengubah jadwal penyelesaian, tetapi
pengukuran ini belum memisahkan biaya tersebut dari variasi lingkungan.
Baseline mixed/buku tidak diganti dan tidak ada klaim semua operasi membaik.

Validasi: `npm test` **384 lulus, 0 gagal**. Log lengkap dibaca dan bersih dari
peringatan, critical, serta galat runtime. Typecheck dan pemeriksaan diff lolos.
Tes mencakup grid yang belum dibuat di luar layar, tinggi reservasi dibanding
tinggi GTK, kestabilan tinggi dokumen setelah gulir, isi Unicode, tema, dan
identitas widget setelah lebar berubah. Tes mouse menyelesaikan GC sebelum
memutar main loop bersarang agar callback destroy GJS tidak ditolak oleh GC.
Screenshot tema terang/gelap di awal dan akhir dokumen diperiksa: grid,
paragraf, dan sidebar tampil tanpa tumpang tindih. `test:ui` desktop tidak
dijalankan karena mode tes yang ditampilkan tidak diminta, sesuai bagian
Lingkungan tes di AGENT.md; tes GUI/mouse berjalan di Xvfb.

Pemeriksaan terarah terakhir mixed 25 memakai sumber sebelum/sesudah final,
masing-masing 10 pengulangan dalam proses terpisah, dijalankan berurutan:

| Operasi | Median sebelum → sesudah | p95/maksimum sebelum → sesudah |
| --- | ---: | ---: |
| setText + sorot + layout | 69.29 → 69.00 | 86.75 → 79.89 |
| buka: jeda terpanjang | 20.82 → 19.92 | 34.18 → 23.67 |
| ketik lewat view | 2.23 → 2.10 | 11.79 → 10.73 |
| Enter paragraf | 3.67 → 3.73 | 14.16 → 14.75 |
| paste besar + Unicode | 162.08 → 205.09 | 297.03 → 322.80 |
| redo paste besar | 180.69 → 177.23 | 197.29 → 182.45 |

Maksimum ketik lewat view 14.22 → 14.81 ms. Regresi redo terhadap baseline
historis tidak muncul pada pembanding ini, tetapi paste **naik 26,5%**.
Skenario paste memasukkan 100 baris Unicode dan satu baris 10.000 karakter,
lalu menunggu sorot/layout selesai; sumber runtime yang berubah adalah lapisan
tabel dan pemilihan baris prioritas untuk cicilan tag. Run sesudah final lain
memberi paste 158.80 ms, sehingga variasinya besar dan biaya tambahan belum
diisolasi pada salah satu jalur. Kenaikan paste ini tetap menjadi keterbatasan
perubahan, bukan dianggap lulus hanya karena total membuka pertama jauh turun.
Semua log benchmark akhir lengkap dan bersih dari galat/peringatan runtime.


## Migrasi ke GTK 4 (GTK 4.14.5, GtkSourceView 5, WebKitGTK 6.0)

Aplikasi pindah dari GTK 3.24.41 ke GTK 4.14.5. Pembanding diukur berdampingan pada
mesin yang sama (GJS 1.80.2, X11/Xvfb, host c640): versi GTK 3 dibangun dari `main`
di worktree terpisah, lalu kedua versi dijalankan bergantian dengan fixture, ukuran,
dan 10 pengulangan yang sama. Kolom GTK 4 (cairo) memakai `GSK_RENDERER=cairo` untuk
memisahkan biaya renderer dari biaya GTK 4 sendiri. Semua angka median dalam ms.

| Operasi (mixed 100 blok, 30 KB) | GTK 3 | GTK 4 (GL) | GTK 4 (cairo) | p95/maks GTK 3 → GTK 4 (GL) |
| --- | ---: | ---: | ---: | ---: |
| setText + sorot + layout | 216.24 | 283.81 | 244.91 | 228.05/228.05 → 308.27/308.27 |
| buka: jeda terpanjang | 37.16 | 44.13 | 41.37 | 41.44/41.44 → 49.44/49.44 |
| ketik per karakter | 1.26 | 1.69 | 1.54 | 2.98/12.58 → 11.65/19.31 |
| ketik lewat view (paragraf) | 1.95 | 3.31 | 2.54 | 11.51/16.00 → 14.18/15.02 |
| Enter paragraf baru | 2.30 | 3.22 | 2.23 | 10.42/10.42 → 14.12/14.12 |
| paste besar + Unicode | 142.25 | 156.32 | 152.72 | 145.11/145.11 → 186.08/186.08 |
| redo paste besar | 155.65 | 157.22 | 157.81 | 172.16/172.16 → 179.80/179.80 |
| pindah kursor 20 baris | 21.32 | 41.35 | 29.17 | 26.06/26.06 → 45.17/45.17 |

| Operasi (buku 400 blok, 651 KB) | GTK 3 | GTK 4 (GL) | GTK 4 (cairo) | p95/maks GTK 3 → GTK 4 (GL) |
| --- | ---: | ---: | ---: | ---: |
| setText + sorot + layout | 852.68 | 2394.35 | 1787.85 | 871.32/871.32 → 2716.54/2716.54 |
| buka: jeda terpanjang | 64.51 | 97.44 | 92.18 | 81.16/81.16 → 116.75/116.75 |
| ketik per karakter | 1.95 | 2.87 | 2.29 | 4.39/14.38 → 15.06/36.74 |
| ketik lewat view (paragraf) | 2.72 | 6.24 | 4.20 | 12.93/14.73 → 17.60/18.94 |
| Enter paragraf baru | 3.37 | 18.02 | 4.17 | 12.30/12.30 → 31.26/31.26 |
| paste besar + Unicode | 140.34 | 191.69 | 151.21 | 155.24/155.24 → 205.06/205.06 |
| redo paste besar | 168.62 | 197.66 | 230.56 | 178.64/178.64 → 216.48/216.48 |
| pindah kursor 20 baris | 14.69 | 43.89 | 47.53 | 21.96/21.96 → 59.41/59.41 |

Temuan dan penyebabnya:

- **Penggambaran mendominasi selisih di Xvfb.** Xvfb tidak punya GPU, jadi renderer
  OpenGL bawaan GTK 4 berjalan di llvmpipe (Mesa, perangkat lunak), sedangkan GTK 3
  menggambar dengan cairo. Dengan `GSK_RENDERER=cairo` sebagian besar selisih hilang
  (mis. Enter di buku 18.02 → 4.17, ketik lewat view di buku 6.24 → 4.20). Mesin
  pengembangan punya GPU Intel UHD; di desktop sungguhan GTK 4 memakai OpenGL
  perangkat keras, jadi angka Xvfb ini kasus terburuk (setara mesin tanpa GPU).
- **Jeda terpanjang membuka buku 651 KB naik 64.51 → 97.44 ms** (p95 81.16 → 116.75).
  Jeda itu seluruhnya `setText()` sinkron. Diukur terpisah: `highlight()` setara
  (±40–45 ms di kedua versi), tetapi `GtkTextBuffer.set_text()` yang menggantikan isi
  lama naik dari ±27 ms (GTK 3) menjadi ±45–58 ms (GTK 4). Mematikan undo atau memakai
  aksi tak terbatalkan tidak mengubahnya; melepas buffer dari view selama `set_text()`
  memberi hasil tidak stabil dan menambah jeda ±25–46 ms sesudahnya, jadi tidak dipakai.
  Ini biaya GTK 4.14 sendiri, bukan kode Nyerat.
- **Total membuka (sampai seluruh layout selesai) naik 2–2,8×** di buku. Penataan latar
  dan penggambaran berjalan di idle; jendela tetap merespons (lihat jeda terpanjang).
- **Pindah kursor 20 baris naik ±3×** di buku pada kedua renderer. Diukur di editor
  tersendiri, `updateCursor()` (marker tersembunyi, mode fokus) tetap ±0,25 ms per
  gerakan; sisanya siklus frame GTK 4 yang ikut tertunggu `idle(PRIORITY_LOW)` di
  pengukuran. Per gerakan tetap ±2 ms, jauh di bawah satu frame 16 ms.
- Model Markdown (tanpa GTK) tidak berubah: markdownToHtml 7.75 → 7.80 ms,
  parseInline 2.59 → 2.75 ms.

Proses anak buku 400 blok GTK 4 (GL) butuh ±230 detik di Xvfb, melebihi batas bawaan
120 detik; ukur buku dengan `--timeout=600`.

**Baseline diganti** dengan hasil GTK 4 (GL) yang lengkap dan valid ini:
`bench/baseline.json` (mixed) dan `bench/baseline-buku.json` (buku, `--timeout=600`).
Baseline lama memakai GTK 3.24.41, sehingga `bench:compare` sudah menganggapnya tidak
setara dan melewati selisihnya; baseline baru menjaga regresi berikutnya di GTK 4.
Regresi di atas tetap tercatat sebagai keterbatasan migrasi, bukan disembunyikan.

Keterbatasan: belum diukur di Wayland (desktop dengan GPU: lihat subbagian berikut). Validasi fungsi: `npm test` **391 lulus, 0 gagal**, dua kali
berturut-turut, log lengkap bersih dari peringatan, critical, dan galat.

### Desktop dengan GPU (X11, Intel UHD, OpenGL perangkat keras)

Diukur berdampingan di desktop XFCE/X11 (bukan Xvfb); renderer bawaan GTK 4 memakai
OpenGL perangkat keras (Mesa Intel UHD CML GT2). 10 pengulangan, `--timeout=600`:

| Operasi (mixed 100 blok, 30 KB) | GTK 3 | GTK 4 | p95/maks GTK 3 → GTK 4 |
| --- | ---: | ---: | ---: |
| setText + sorot + layout | 202.22 | 207.55 | 223.16/223.16 → 220.06/220.06 |
| buka: jeda terpanjang | 36.84 | 42.03 | 50.57/50.57 → 48.24/48.24 |
| ketik per karakter | 1.22 | 1.51 | 3.66/10.41 → 3.70/6.50 |
| ketik lewat view (paragraf) | 2.13 | 2.52 | 10.51/15.12 → 6.96/13.79 |
| Enter paragraf baru | 2.62 | 2.90 | 10.92/10.92 → 5.70/5.70 |
| paste besar + Unicode | 137.82 | 134.04 | 139.49/139.49 → 143.97/143.97 |
| redo paste besar | 154.06 | 165.13 | 167.35/167.35 → 178.09/178.09 |
| pindah kursor 20 baris | 18.97 | 19.94 | 24.48/24.48 → 23.22/23.22 |

| Operasi (buku 400 blok, 651 KB) | GTK 3 | GTK 4 | p95/maks GTK 3 → GTK 4 |
| --- | ---: | ---: | ---: |
| setText + sorot + layout | 799.29 | 920.37 | 834.25/834.25 → 972.52/972.52 |
| buka: jeda terpanjang | 71.03 | 85.09 | 80.98/80.98 → 95.93/95.93 |
| ketik per karakter | 1.92 | 2.23 | 5.07/13.28 → 5.66/9.76 |
| ketik lewat view (paragraf) | 2.69 | 3.63 | 7.26/11.67 → 8.03/9.18 |
| Enter paragraf baru | 3.70 | 3.83 | 9.80/9.80 → 6.06/6.06 |
| paste besar + Unicode | 148.61 | 137.94 | 151.61/151.61 → 151.00/151.00 |
| redo paste besar | 166.45 | 164.58 | 180.00/180.00 → 177.19/177.19 |
| pindah kursor 20 baris | 14.13 | 22.34 | 15.01/15.01 → 24.31/24.31 |

Dengan GPU, sebagian besar regresi Xvfb hilang: dokumen campuran setara GTK 3 (p95
mengetik dan Enter bahkan lebih rendah), dan buku 651 KB tinggal **jeda membuka
71.03 → 85.09 ms** (sumbernya `set_text()` GTK 4, lihat di atas), total membuka +15%,
serta pindah kursor 20 baris 14.13 → 22.34 ms (±1,1 ms per gerakan). Baseline tetap
dari Xvfb (lingkungan `npm run bench:compare`); angka desktop ini hanya pembanding.
Validasi: `npm run test:ui` di desktop **391 lulus, 0 gagal**, log bersih.

## Pemeriksaan regresi setelah fitur baru (2026-10-07)

61 commit sejak baseline GTK 4 (inbox, Beranda, wikilink, indentasi daftar, blok kode sebagai
kotak gulir, penyesuaian GNOME, dst.). `bench:compare` dan fixture buku dijalankan terhadap
`baseline.json`/`baseline-buku.json` (X11/Xvfb, GTK 4.14.5, 10 pengulangan). Regresi besar:

| Operasi | Baseline | Sebelum perbaikan | Sesudah perbaikan |
| --- | ---: | ---: | ---: |
| mixed 30 KB, buka: jeda terpanjang | 44.13 | 67.65 | 53.42–54.34 |
| mixed 30 KB, pindah kursor 20 baris | 41.35 | 80.32 | 45.40–52.69 |
| mixed 30 KB, hapus teks besar | 3.05 | 8.07 | 3.49–3.79 |
| mixed 30 KB, undo paste besar | 3.64 | 8.05 | 3.79–4.19 |
| buku 325 KB, buka: jeda terpanjang | 46.66 | 90.02 | 49.13–51.10 |
| buku 651 KB, buka: jeda terpanjang | 97.44 | 139.75 | 95.10–107.42 |

Kolom "sesudah" adalah dua run penuh terpisah. Bisect di worktree (mixed 100 blok, 5 pengulangan)
dan profil per metode menunjukkan dua sumber:

- **Lapisan blok kode (`codelayer.ts`, d21cfb0)** menjalankan `sync()` penuh (iter per blok,
  diff tag seluruh buffer) setiap kursor masuk/keluar satu blok dan setiap suntingan yang hanya
  menggeser baris: ±4 ms per panggilan pada 100 blok, ditambah GTK menata ulang. Kini sama dengan
  `TableLayer`: `setCursor()` hanya memasang/melepas tag blok yang berganti, dan pergeseran baris
  tanpa perubahan isi cukup memindahkan widget (tag GTK ikut bergeser). Profil 80 perpindahan
  kursor: `CodeLayer.sync` 73.9 ms → 0.
- **Outline (`Gio.ListStore`, b51c43b)** membuat semua item sekaligus saat membuka dokumen lain
  (±0,1 ms per item, ±20 ms untuk 440 heading di naskah 651 KB), di dalam jeda membuka. Perubahan
  kecil (≤ 8 item, mis. menyunting satu heading) tetap langsung; perubahan besar dicicil 25 item
  per giliran di idle `HIGH_IDLE + 21`, setelah frame digambar dan sebelum cicilan tag editor.

Sisa selisih yang tidak dianggap regresi kode:

- **Enter paragraf baru** ±14–16 ms (baseline 2.5–3.2) juga di buku tanpa blok kode/tabel.
  Profil JS ±2,6 ms per Enter. Dengan `GSK_RENDERER=cairo` (buku 50 blok) Enter 2.72 ms
  (p95 7.30) vs GL 10.31 ms (p95 29.38): itu frame yang digambar llvmpipe di tengah pengukuran,
  seperti yang tercatat di bagian migrasi GTK 4. Angka Enter Xvfb-GL bimodal antar-run.
- **setText + sorot + layout** (total sampai idle) +15–24% di mixed: biaya awal lapisan kode
  baru (`CodeLayer.sync` dan `CodeHighlighter.apply` ±4 ms per buka pada 100 blok) dan
  penataan kotak; jeda terpanjang tetap mendekati baseline.

Validasi: `npm test` **574 lulus, 0 gagal**, log bersih; tes baru memeriksa tag `codehide`
tepat di baris tiap blok setelah kursor keluar-masuk dan baris disisipkan di atas blok.
Baseline tidak diganti.
