# Diagnosis callback GC pada benchmark ekstrem — 4 Oktober 2026

Penyebab langsung kegagalan lama adalah **callback JavaScript yang dibuang oleh
penjaga GC GJS**, bukan sekadar GC yang membutuhkan waktu lama. Reproduksi versi
lama pada 500 grid menghasilkan `SourceFunc()` yang ditolak saat GLib hendak
menjalankan pekerjaan idle. Callback yang hilang dapat menghentikan penyorotan
atau penyelesaian Promise `idle()`, sehingga benchmark menunggu sampai timeout.
Belum ada perubahan kode runtime atau baseline dari pemeriksaan ini.

## Bukti

- Lingkungan: GJS 1.80.2 / SpiderMonkey 115, GLib 2.80.0, GTK 3.24.41,
  X11/Xvfb pada mesin yang sama.
- Log lama `/tmp/nyerat-perf-large-no-gc.log` dan
  `/tmp/nyerat-perf-large-async-no-gc.log` memuat `mark-set` pada
  `GtkSourceBuffer`, `changed` pada `GtkAdjustment`, `size-allocate`, dan
  `SourceFunc()` yang diblokir. Buffer dan view tersebut masih dipakai benchmark.
- Checkout commit `9f324c7` diekstrak ke `/tmp/nyerat-gc-old`, dibangun dengan
  dependensi yang sama, lalu dijalankan melalui GDB dengan
  `G_DEBUG=fatal-criticals`. Pada mixed 500 blok, 1 pengulangan, peringatan pertama
  muncul setelah `highlight() ulang`, sebelum laporan mengetik selesai.
- Native stack pada peringatan pertama:
  `g_application_run → g_main_context_iteration → GLib source dispatch → libffi → libgjs → g_log`.
  Tidak terdapat `gtk_widget_destroy`, disposal widget, atau frame finalizer GC
  pada stack thread utama itu. Ini tidak cocok dengan dugaan bahwa callback
  `destroy` suatu widget yang sedang dikoleksi adalah pemicu langsung.
- Reproduksi tersebut ada di `/tmp/nyerat-gc-old-mixed-gdb.log`.
  Run versi lama untuk long 2000 blok, 3 pengulangan, justru selesai di bawah
  debugger. Kegagalan bergantung pada waktu/keadaan GC; tidak terjadi pada setiap run.
- Reproduksi kedua mixed 500 blok juga gagal, kali ini setelah redo, pada
  `changed` milik `GtkAdjustment`. GDB mengidentifikasi sumber main loop
  berprioritas **120**, bernama **`[gtk+] gdk_frame_clock_paint_idle`**:
  GTK sedang menjalankan frame/tata letak biasa, bukan callback `destroy`.
  Bukti ini ada di `/tmp/nyerat-gc-old-source-gdb.log`. Dengan demikian jalur
  yang terkena bukan hanya callback benchmark, tetapi juga sinyal tata letak GTK.

## Penjelasan runtime dan batas kepastian

Di [penjaga callback GJS 1.80.2](https://github.com/GNOME/gjs/blob/1.80.2/gi/function.cpp#L291),
`gjs->sweeping()` menyebabkan callback ditolak sebelum fungsi JavaScript dipanggil.
Penjaga [sinyal GObject](https://github.com/GNOME/gjs/blob/1.80.2/gi/value.cpp#L220)
melakukan hal yang sama. Pesan tentang penghancuran widget adalah teks umum dari
penjaga tersebut; pesannya bukan identifikasi widget yang bermasalah.

[Pengelolaan status GC](https://github.com/GNOME/gjs/blob/1.80.2/gjs/context.cpp#L888)
mengaktifkan `m_in_gc_sweep` pada persiapan grup dan baru mematikannya saat
seluruh koleksi berakhir. **Dugaan terkuat** adalah flag ini masih aktif di sela
GC bertahap ketika main loop sudah kembali menjalankan callback biasa. Native
stack reproduksi mendukung dugaan itu, tetapi status GC internal belum diperiksa
langsung dengan simbol debug, dan GJS belum diuji dengan patch/versi lain.
Jadi bug integrasi GC bertahap adalah dugaan beralasan, bukan kesimpulan upstream
yang sudah terverifikasi.

Sumber tekanan alokasi pada kode lama terlihat di `concealMarkers()`:
`starts.map(() => [])` membuat array untuk setiap baris tiap ketukan/perpindahan
kursor, kemudian marker seluruh dokumen membuat tuple tag baru. Pada long ada
sekitar 20.000 array per pembaruan, ditambah penggabungan cache penyorot seukuran
dokumen. Lapisan tabel lama juga menelusuri semua tabel/tag dan meminta posisi
semua grid. Versi sekarang telah mengurangi pekerjaan ini lewat `MarkerConcealer`,
penggabungan cache yang lebih ringan, penyorotan bertahap, dan perhitungan posisi
grid yang terlihat. Hubungan penurunan alokasi dengan hilangnya gejala belum
isolasi A/B per perubahan; jangan menganggap masalah GC dijamin selesai.

Uji minimal satu `Gtk.TextBuffer` aktif dengan 30 putaran alokasi masing-masing
10 × 100.000 array/objek selesai dengan seluruh 600 sinyal kursor diterima.
Tidak ada widget yang dihancurkan. Ini menunjukkan tekanan alokasi saja pada
uji tersebut belum cukup untuk mereproduksi masalah, bukan bukti bahwa GJS bebas
masalah GC.

## Keadaan kode terbaru (`44cbc11`)

| Kasus | Pengulangan | Hasil |
| --- | ---: | --- |
| long 2000 blok, sekitar 1,3 MB | 3 | Semua 14 operasi GUI selesai, JSON tersimpan, tanpa warning/critical |
| mixed 500 grid, sekitar 148 KB | 10 | Timeout 180 detik sesudah laporan Enter; tidak ada warning/critical, JSON tidak disimpan |
| mixed 500 grid, sekitar 148 KB | 1 | Semua 14 operasi GUI selesai, JSON tersimpan, tanpa warning/critical |

Run mixed 10 pengulangan masih menunjukkan kemajuan antar-tahap dan penggunaan
CPU tinggi. Bukti saat ini lebih cocok dengan durasi total yang melampaui batas,
bukan pengulangan callback GC yang diblokir seperti log lama. Pembukaan tetap
mahal: run 10 mencatat total setText sekitar 2,7 detik dan jeda terpanjang sekitar
0,9 detik. Hasil 1 pengulangan hanya diagnostik, bukan baseline performa baru.
Beberapa eksperimen debugger berjalan bersamaan dengan benchmark diagnostik;
angka waktunya tidak dipakai untuk klaim perbaikan sebelum/sesudah.

Log dan sampel terbaru:

- `/tmp/nyerat-gc-long2000.log`, `/tmp/nyerat-gc-long2000.json`
- `/tmp/nyerat-gc-mixed500.log` (run 10 yang timeout, hasil tidak lengkap)
- `/tmp/nyerat-gc-mixed500-one.log`, `/tmp/nyerat-gc-mixed500-one.json`
- `/tmp/nyerat-gc-minimal.log`

Pemeriksaan selanjutnya yang paling membedakan dugaan adalah menangkap status
GC internal pada callback yang ditolak, atau menguji reproduksi lama dengan
runtime yang mengubah cakupan flag sweeping. Untuk performa 500 tabel, masalah
pembuatan awal seluruh grid perlu diprofilkan terpisah dari kegagalan callback GC.
