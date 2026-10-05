# Pemeriksaan performa fitur agentic — 5 Oktober 2026

Fitur baru mencakup rencana pekerjaan, paket perubahan, verifikasi, journal, checkpoint,
retry, dan cuplikan riwayat. Pengukuran lokal tidak memanggil penyedia model.

## Biaya paket dan checkpoint

Perintah: `npm run bench:agentic`. Sepuluh pengulangan setelah tiga pemanasan,
20 berkas per paket, ukuran 30.000 dan 480.000 karakter per berkas. Fixture mengganti
seluruh isi berkas; ini sengaja lebih berat daripada mengganti satu tanggal.
Checkpoint mencakup serialisasi, tulis sinkron, baca, dan parsing ulang untuk memastikan
snapshot lengkap. Kontrol memakai pertanyaan/jawaban yang sama tanpa journal;
kontrol ini mengukur tambahan biaya metadata, bukan pembandingan seluruh aplikasi lama.

| Operasi | Ukuran per berkas | Median (ms) | p95 (ms) | Maksimum (ms) |
| --- | ---: | ---: | ---: | ---: |
| Rencanakan paket | 30.000 karakter | 8,984 | 12,003 | 12,003 |
| Verifikasi hasil | 30.000 karakter | 0,246 | 0,329 | 0,329 |
| Checkpoint tanpa journal | 30.000 karakter | 3,524 | 4,506 | 4,506 |
| Checkpoint dengan journal | 30.000 karakter | 19,460 | 31,577 | 31,577 |
| Rencanakan paket | 480.000 karakter | 113,940 | 122,101 | 122,101 |
| Verifikasi hasil | 480.000 karakter | 3,428 | 4,734 | 4,734 |
| Checkpoint tanpa journal | 480.000 karakter | 3,455 | 4,611 | 4,611 |
| Checkpoint dengan journal | 480.000 karakter | 188,555 | 212,635 | 212,635 |
| Cuplikan 200 giliran (24.000 karakter/giliran) | — | 2,928 | 5,321 | 5,321 |

Journal menyimpan snapshot sebelum/sesudah agar diff dapat dibuka lagi dan interupsi
bisa direkonsiliasi. Biayanya nyata: paket 20 dokumen besar dapat menahan thread utama.
Angka checkpoint di atas juga mencakup pembacaan ulang yang tidak dilakukan aplikasi
pada setiap penyimpanan, sehingga bukan pengukuran jeda UI secara langsung.
Penulisan checkpoint masih sinkron; hasil ini tidak membuktikan kenyamanan untuk
percakapan dengan ratusan snapshot besar. Tidak ada klaim peningkatan performa.

## Benchmark editor

`npm run bench:compare` selesai pada fixture mixed, 100 blok untuk modul dan 25/50/100
blok GUI, 10 pengulangan, dengan baseline proyek yang tetap dipertahankan.
Pada pengukuran awal Enter 50 blok meningkat dari median 2,67 ke 6,93 ms
(p95/maksimum 13,77 ms), sedangkan 25 dan 100 blok masing-masing 2,44 dan 2,40 ms.
Angka ini diperiksa lagi dengan snapshot kode sebelum perubahan pada lingkungan yang
sama; hasil pembandingan langsung berikut menunjukkan kenaikan Enter tersebut tidak terulang.

| Operasi (50 blok) | Median sebelum → sesudah (ms) | p95 sebelum → sesudah (ms) | Maksimum sebelum → sesudah (ms) |
| --- | ---: | ---: | ---: |
| setText + sorot + layout | 140,054 → 131,954 | 165,093 → 144,422 | 165,093 → 144,422 |
| buka: jeda terpanjang | 24,382 → 24,142 | 33,760 → 28,203 | 33,760 → 28,203 |
| ketik per karakter | 1,088 → 1,114 | 12,177 → 9,052 | 16,455 → 16,218 |
| Enter paragraf baru | 2,328 → 1,885 | 13,008 → 12,342 | 13,008 → 12,342 |
| paste besar + Unicode | 131,704 → 142,518 | 160,982 → 149,871 | 160,982 → 149,871 |
| undo paste besar | 2,415 → 2,477 | 3,758 → 3,702 | 3,758 → 3,702 |
| redo paste besar | 145,763 → 153,611 | 157,563 → 166,101 | 157,563 → 166,101 |

Kedua pengukuran memakai fixture mixed, 100 blok modul, 50 blok GUI, 10 pengulangan, GJS/GTK dan konfigurasi Xvfb yang sama. Snapshot sebelum berasal dari HEAD saat pekerjaan dimulai, dibangun di folder sementara dengan dependensi yang sama. Enter turun dari 2,328 ke 1,885 ms pada pengukuran langsung; ini tidak dianggap optimasi karena implementasi Enter tidak berubah. findTables naik sekitar 32% tetapi hanya 0,25 → 0,33 ms (p95 0,31 → 0,49 ms); kode parser tidak berubah dan angka sekecil ini peka terhadap derau. Tidak ada regresi median editor lebih dari 25% pada pembandingan langsung. Hasil tidak dipakai mengganti baseline proyek.

Pengukuran ini tidak menilai latensi API, ketepatan pilihan kriteria oleh model,
kemampuan model menyusun rencana, atau durasi pengguna meninjau diff. Evaluasi model
tersedia lewat `npm run test:live -- --agentic`; belum dijalankan pada sesi ini karena
memakai kuota API.

## Tindakan dan verifikasi tambahan — 5 Oktober 2026

Perubahan: alat `sisip_teks`, `hapus_berkas`, `pindah_berkas`, `ubah_berkas` dengan `semua`,
aksi kanban tambahan, persetujuan paket sebagian, Urungkan, alat riwayat Git, dan verifikasi
struktur (`markdown/lint.ts`) serta pencarian sisa teks di seluruh folder (berkas `"*"`).

`npm run bench:agentic`, 10 pengulangan setelah 3 pemanasan, 20 berkas per paket; bentuk fixture
sama dengan bagian di atas (berkas tanpa tabel atau tautan, jadi seluruh biaya adalah penelusuran baris).
Verifikasi struktur mengurai tiap berkas dua kali (isi sekarang dan isi sebelum pekerjaan).

| Operasi | Ukuran per berkas | Median (ms) | p95 (ms) | Maksimum (ms) |
| --- | ---: | ---: | ---: | ---: |
| Verifikasi struktur (dengan baseline) | 30.000 karakter | 10,113 | 10,808 | 10,808 |
| Cari sisa teks di seluruh folder (`*`) | 30.000 karakter | 0,279 | 0,621 | 0,621 |
| Verifikasi struktur (dengan baseline) | 480.000 karakter | 157,345 | 160,572 | 160,572 |
| Cari sisa teks di seluruh folder (`*`) | 480.000 karakter | 3,394 | 4,627 | 4,627 |

Versi pertama pemeriksaan struktur menjalankan tiga penelusuran per dokumen (frontmatter/kode,
tabel, tautan) dan memotong spasi setiap baris: 396,9 ms (p95 404,6) untuk 20 × 480.000 karakter,
dan `"*"` memecah semua berkas menjadi baris walau teksnya tidak ada (66,6 ms). Setelah digabung
menjadi satu penelusuran dengan saringan karakter sebelum regex, dan `"*"` hanya memecah berkas yang
memuat teksnya, angkanya menjadi seperti tabel di atas. Ini optimasi atas kode baru dalam pekerjaan
yang sama, bukan peningkatan fitur lama. Pemeriksaan berjalan di thread utama sekali per panggilan
`verifikasi_pekerjaan`, bukan saat mengetik; 157 ms untuk ±19 juta karakter (dua kali 20 × 480.000) masih terasa sebagai jeda.

Operasi lama pada pengukuran yang sama dibandingkan dengan snapshot HEAD sebelum perubahan
(dibangun di worktree sementara, dependensi dan lingkungan sama): rencanakan paket 480.000 karakter
115,9 → 110,4 ms, verifikasi hasil 3,48 → 3,49 ms, checkpoint dengan journal 198,4 → 215,6 ms
(p95 215,4 → 244,8). Kode checkpoint tidak berubah; journal kini bisa memuat `to` untuk pindah,
yang tidak dipakai fixture ini, sehingga selisihnya dianggap derau pengukuran tulis disk.

Benchmark editor (`bench:compare`, fixture mixed, 25/50/100 blok, 10 pengulangan) dijalankan untuk
snapshot sebelum dan sesudah. Kode editor tidak berubah. Satu pembacaan awal "hapus teks besar"
25 blok 6,28 → 19,58 ms tidak terulang: dua pengulangan berikutnya 7,73/8,84 ms (sebelum) dan
7,06/8,05 ms (sesudah). Enter paragraf baru berfluktuasi ke dua arah pada kedua snapshot
(snapshot sebelum sendiri mencatat +119% pada 100 blok). Tidak ada regresi editor yang terulang;
baseline tidak diganti.
