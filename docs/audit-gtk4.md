# Audit GTK4 Nyerat — 5 Oktober 2026

Nyerat sudah memakai runtime GTK4 sepenuhnya: tidak ditemukan import GTK3/GDK3,
GtkSourceView 4, atau WebKit2GTK pada kode aplikasi, tes, skrip, dan dependensi.
Namun migrasinya belum sepenuhnya memakai pola modern GTK4: beberapa API
deprecated dan penyesuaian pola GTK3 masih dipertahankan.

Audit ini tidak mengubah kode aplikasi. Pemeriksaan meliputi dependensi dan
binding, import, widget, input, dialog, koordinat, gambar, tema, overlay,
pembersihan komponen, serta runner tes. API dicocokkan dengan binding lokal
dan dokumentasi resmi GTK. Modul Markdown dan agen diperiksa dalam kaitannya
dengan dependensi runtime dan callback UI; ini bukan audit keamanan atau
pembuktian kebenaran seluruh algoritma aplikasi.

## Hasil pemeriksaan

- Lingkungan: GTK 4.14.5, GJS 1.80.2, X11 melalui Xvfb 1280×800.
- `npm test`: build/typecheck berhasil; **392 lulus, 0 gagal**, termasuk tes mouse
  kanban dan pohon berkas. Seluruh log dibaca dan diperiksa; tidak ditemukan
  peringatan GTK/GJS/GLib, critical, atau stack trace pada eksekusi lengkap.
- Percobaan awal dalam sandbox berhenti pada server HTTP tiruan karena socket
  localhost diblokir. Eksekusi lengkap di luar sandbox berhasil; tidak memakai
  API DeepSeek sungguhan.
- Probe tambahan memakai konfigurasi `/tmp`, penyedia/key store tiruan, dan
  callback Mermaid tertunda. Probe mereproduksi tiga celah penutupan komponen
  di bawah. Log probe akhirnya bersih; yang teramati adalah callback/timer
  sesudah penutupan, bukan crash yang sudah terbukti.
- Wayland, HiDPI, dialog portal sungguhan, dan GTK versi lain belum diuji.
  `test:ui` tidak dijalankan karena pengguna tidak meminta tes di desktop yang
  menggerakkan pointer. Benchmark tidak dijalankan karena kode runtime tidak
  berubah; tidak ada klaim peningkatan atau regresi performa dari audit ini.

## Temuan perilaku yang didahulukan

### 1. P2 — Kanban tidak membersihkan timer saat jendela ditutup

Lokasi: `src/ui/kanban.ts:141`, `:163`, `:459`, `:526`;
`src/window.ts:845`.

`KanbanBoard` membuat idle render, idle pemulihan gulir, dan timeout autoscroll
40 ms, tetapi tidak menyediakan `destroy()`. `MainWindow.dispose()` juga tidak
membersihkan papan. Saat drag masih aktif lalu jendela dihancurkan, probe
menunjukkan `dragging === true` dan empat panggilan autoscroll dalam 180 ms
setelah penutupan. Sumber GLib tetap memegang papan dan terus mengakses widget.

Tambahkan pembersihan eksplisit: hentikan drag, simpan/hapus ID idle, beri
penanda disposed, dan panggil pembersihannya dari `MainWindow.dispose()`.
Tes penutupan saat drag dan saat render masih antre perlu ditambahkan.

### 2. P2 — Hasil render Mermaid tetap diterapkan pada editor yang ditutup

Lokasi: `src/editor/mermaid.ts:91`, `:195`.

`destroy()` menghentikan debounce dan slot, tetapi callback hasil renderer hanya
memeriksa kode, tema, dan keanggotaan blok. Blok tetap berada di `this.blocks`
setelah editor ditutup, sehingga pemeriksaan itu lolos. Probe callback tertunda
menghasilkan satu pemanggilan `render()` sesudah penutupan.

Periksa `this.destroyed` di callback dan hentikan/invalidasi pekerjaan per lapisan
tanpa mematikan renderer bersama yang masih digunakan tab lain. Uji penutupan
tab/jendela ketika WebKit masih merender.

### 3. P2 — Promise chat dan API key tidak mengikuti masa hidup panel

Lokasi: `src/ui/chat.ts:246`, `:305`, `:353`, `:533`.

`destroy()` membatalkan permintaan yang sudah mempunyai `Gio.Cancellable` dan
timer yang sudah ada. Namun `send()` menunggu key sebelum membuat cancellable;
hasilnya tetap diproses setelah panel ditutup. Probe menahan Promise key,
menutup jendela, lalu menyelesaikannya dengan `null`: `addNote()` tetap dipanggil
sekali setelah penutupan. Callback streaming, `finally`, serta operasi key
asinkron juga belum memeriksa status disposed.

Tambahkan status disposed/token generasi, periksa setelah setiap `await` dan
sebelum callback mengakses UI, serta cegah pembuatan timer baru setelah
pembersihan. Pembatalan jaringan sendiri belum membatalkan kelanjutan Promise.

### 4. P2 — Syarat versi GTK minimum belum jelas

Lokasi: `src/ui/theme.ts:121`, `src/ui/dialogs.ts:35`,
`src/editor/view.ts:567`, `README.md:28`.

Dokumentasi menyebut GTK4 dan versi yang diuji, tetapi belum memberi minimum
yang tegas atau pemeriksaan versi saat startup. `load_from_string()` baru ada
sejak GTK 4.12 dan dipanggil ketika tema awal dipasang. Karena itu aplikasi saat
ini membutuhkan **setidaknya GTK 4.12**; memasang GTK4 versi 4.8/4.10 saja belum
memadai. `FileDialog` dan `UriLauncher` juga membutuhkan 4.10.

Nyatakan minimum yang didukung, tambahkan pesan startup yang jelas atau jalur
kompatibilitas jika versi lebih lama memang hendak didukung. Binding TypeScript
yang lebih baru tidak menjamin simbol tersebut ada di mesin pengguna.
[Dokumentasi `load_from_string`](https://docs.gtk.org/gtk4/method.CssProvider.load_from_string.html).

## Modernisasi GTK4

| Bagian | Kondisi sekarang | Perbaikan yang disarankan |
| --- | --- | --- |
| ~~Pohon berkas~~ (selesai: kini `Gio.ListStore` + `TreeListModel` + `ListView`) | `TreeStore`, `TreeView`, `TreeViewColumn`, `CellRendererPixbuf/Text`; keluarga ini deprecated sejak 4.10 | `Gio.ListStore` + `Gtk.TreeListModel`, selection model, `Gtk.ListView`, `Gtk.TreeExpander`, dan factory widget. Pertahankan lazy loading, pemantauan folder, reveal, menu, dan DnD. |
| Pemilih model (`src/ui/chat.ts:143`) | `Gtk.ComboBoxText`, deprecated sejak 4.10 | `Gtk.DropDown` + `Gtk.StringList`, dengan pemetaan indeks ke ID model. |
| Dialog (`src/gtkutil.ts:52`, `src/ui/dialogs.ts:35,78`) | Widgetnya GTK4, tetapi `runModal()` mengembalikan pola blocking lewat `GLib.MainLoop` bersarang | Ubah antarmuka ke Promise/callback dan alur open/save/close menjadi asinkron. Jendela formulir modal khusus tetap dapat dipakai; tidak wajib beralih ke `AlertDialog` yang punya masalah terdokumentasi pada lingkungan proyek. |
| Gambar (`src/editor/images.ts:256`, `src/editor/mermaid.ts:323`) | `Gtk.Picture.new_for_pixbuf`, deprecated sejak 4.12; resize membuat pixbuf baru | Gunakan `Picture` dengan `Gdk.Paintable/Texture`, cache hasil konversi, dan ukur jalur resize/HiDPI sebelum mengganti strategi skala. Untuk target 4.14, texture dari pixbuf bisa menjadi tahap transisi; API konversi itu sendiri deprecated sejak 4.20. |
| Koordinat kanban (`src/ui/kanban.ts:465–545`) | `translate_coordinates`, `get_allocated_width/height`, deprecated sejak 4.12 | `compute_point`, `get_width/get_height`; periksa boolean keberhasilan konversi. Jangan mengganti getter secara mekanis tanpa memeriksa margin dan sistem koordinat. |
| Posisi tab (`src/ui/tabbar.ts:102`) | `get_allocation`, deprecated sejak 4.12 | `compute_bounds` terhadap isi scroller dan getter ukuran yang sesuai. |
| Visibilitas chat (`src/ui/chat.ts:292` dan pemanggilan serupa) | `Gtk.Widget.show()/hide()`, deprecated sejak 4.10 | `set_visible(true/false)`. Metode `show()` milik kelas aplikasi yang memanggil `Window.present()` tidak termasuk masalah ini. |
| Tema (`src/ui/theme.ts:36,114`) | Deteksi gelap dari nama tema, hanya ketika startup; preferensi gelap GTK deprecated sejak 4.20 | Ambil preferensi sistem yang sesungguhnya dan dengarkan perubahannya ketika pilihan pengguna masih `null`. Sesuaikan API tema dengan rentang versi yang didukung. |

Status API: [TreeView](https://docs.gtk.org/gtk4/class.TreeView.html),
[ComboBoxText](https://docs.gtk.org/gtk4/class.ComboBoxText.html),
[panduan dialog asinkron](https://docs.gtk.org/gtk4/migrating-3to4.html#stop-using-blocking-dialog-functions),
[Picture dari pixbuf](https://docs.gtk.org/gtk4/ctor.Picture.new_for_pixbuf.html),
[Texture dari pixbuf](https://docs.gtk.org/gdk4/ctor.Texture.new_for_pixbuf.html),
[koordinat](https://docs.gtk.org/gtk4/method.Widget.translate_coordinates.html),
[alokasi](https://docs.gtk.org/gtk4/method.Widget.get_allocation.html),
[visibilitas](https://docs.gtk.org/gtk4/method.Widget.show.html),
[preferensi tema](https://docs.gtk.org/gtk4/property.Settings.gtk-application-prefer-dark-theme.html).

Deprecated berarti masih merupakan API GTK4 yang berjalan pada versi uji,
tetapi bukan arah pengembangan yang dianjurkan. Ini tidak membuktikan aplikasi
masih memuat GTK3. Modernisasi `TreeView` lebih besar daripada penggantian
`ComboBoxText` dan sebaiknya dikerjakan sebagai perubahan tersendiri.

## Perbaikan tambahan

- `src/editor/images.ts:87–92`: membaca file sudah async, tetapi decoding
  `Pixbuf.new_from_stream()` dan orientasi berjalan sinkron di thread utama.
  `scale_simple()` juga sinkron saat resize. Foto besar dapat menahan UI;
  gunakan decoding async dan ukur skenario gambar besar sebelum mengklaim
  perbaikan performa. Cache global gambar tidak memiliki batas atau invalidasi
  ketika file berubah; pertimbangkan batas memori dan pemuatan ulang.
- `src/ui/dialogs.ts:57–59`: semua galat pemilih berkas dianggap pembatalan.
  Bedakan dismissed/cancelled dari kegagalan portal/I/O, dan tampilkan galat
  yang dapat ditindaklanjuti. Pilihan `Gio.File` nonlokal juga menghasilkan
  `get_path() === null`; dukung URI atau berikan penjelasan yang jelas.
- `src/editor/overlays.ts:37–74`: koneksi ke adjustment lama tidak diputus ketika
  adjustment diganti maupun ketika slot dihentikan. Simpan ID koneksi,
  disconnect, dan periksa disposed sebelum alokasi langsung. Ini temuan statis;
  probe khusus penggantian adjustment belum dilakukan.
- `src/ui/history.ts:210–222`, `src/window.ts:515–535,575–588`: sebagian kelanjutan
  commit/auto save dan idle reload papan juga belum memakai penjaga penutupan.
  Pemeriksaan lifecycle perlu mencakup seluruh operasi, bukan hanya timer utama.
- `src/ui/imageviewer.ts:225`: penggunaan Cairo melalui `DrawingArea.set_draw_func`
  sah di GTK4. Helper `Gdk.cairo_set_source_pixbuf` baru deprecated sejak 4.20;
  modernisasi ini lebih rendah prioritasnya untuk target 4.14.
  [Dokumentasi helper Cairo](https://docs.gtk.org/gdk4/func.cairo_set_source_pixbuf.html).

## Bagian yang sudah tepat

- `Gtk.Application`, `ApplicationWindow`, `GtkSource.View/Buffer` versi 5,
  `append/set_child`, `GestureClick/Drag`, controller keyboard/motion/scroll,
  `DragSource/DropTarget`, aksi `Gio.SimpleAction`, dan `PopoverMenu` sudah GTK4.
- `HeaderBar.pack_start/pack_end` tetap API GTK4 yang sah; bukan sisa
  `Gtk.Box.pack_start` GTK3. Pencarian berdasarkan nama metode saja bisa salah.
- `GdkPixbuf` versi 2.0, Soup versi 3.0, dan Cairo tidak berarti GTK3.
  WebKitGTK 6.0 merupakan jalur GTK4; pemuatan dinamisnya sudah tepat.
- `StyleContext.add_provider_for_display()` merupakan API pemasangan CSS
  yang masih valid, walaupun banyak API instance `StyleContext` deprecated.
- Iter baris, traversal anak, ekspansi panel, posisi overlay sesudah gulir,
  dan penjadwalan penyorotan sudah disesuaikan dengan GTK4 dan memiliki tes.
- Pool slot overlay dan marker kecil merupakan workaround yang dijelaskan
  proyek. Pertahankan dahulu; evaluasi ulang hanya dengan reproduksi masalah
  GTK dan pengukuran pada versi yang ditargetkan.

## Urutan pengerjaan

1. Tutup celah lifecycle kanban, Mermaid, dan chat beserta tes regresinya.
2. Tegaskan minimum GTK dan penanganan galat dialog.
3. Modernisasi `ComboBoxText`, visibilitas, dan koordinat.
4. Migrasikan pohon berkas ke model/widget GTK4 modern.
5. Ubah kontrak dialog menjadi async, lalu optimalkan gambar dan integrasi tema.
6. Tambahkan verifikasi Wayland, HiDPI, portal, dan versi GTK yang didukung.

Perubahan runtime berikutnya perlu mengikuti tes, pemeriksaan visual, dan
benchmark yang diwajibkan panduan proyek. Hasil audit ini tidak menggantikan
pemeriksaan tersebut.
