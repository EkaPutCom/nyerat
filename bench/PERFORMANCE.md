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
