// Dokumen contoh yang ditampilkan saat aplikasi pertama kali dibuka.

export const WELCOME = `# Selamat datang di Nyerat

Editor **Markdown** ala *Typora*: sintaks disembunyikan, dan muncul lagi saat kursor berada di barisnya. Coba klik baris ini.

## Format teks

- **Tebal** dengan \`Ctrl+B\`, *miring* dengan \`Ctrl+I\`
- ~~Coret~~, ==stabilo==, dan \`kode inline\`
- Tautan: [GTK](https://www.gtk.org) — **Ctrl+klik** untuk membuka

## Daftar tugas

- [x] Pasang GJS
- [ ] Tulis sesuatu yang hebat (klik kotaknya untuk mencentang)

1. Daftar bernomor
2. Tekan Enter untuk lanjut otomatis

> Kutipan juga bisa.
> Tekan Enter di baris kosong untuk keluar.

\`\`\`js
function halo(nama) {
    return \`Halo, \${nama}!\`;
}
\`\`\`

| Shortcut | Fungsi |
| -------- | ------ |
| Ctrl+1…6 | Heading |
| Ctrl+/   | Mode source |
| F8       | Mode fokus |

---

Buka menu ☰ untuk ekspor HTML, mode gelap, dan lainnya.
`;
