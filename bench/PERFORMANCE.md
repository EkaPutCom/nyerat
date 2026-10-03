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
