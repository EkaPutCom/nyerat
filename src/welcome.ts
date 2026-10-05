// Dokumen contoh yang ditampilkan saat aplikasi pertama kali dibuka.

export const WELCOME = `# Selamat datang di Nyerat

Ruang kerja pribadi untuk catatan, rencana, dan tugas, bersama agent AI (buka panelnya dengan \`Ctrl+Shift+A\`). Semuanya **Markdown** yang langsung terformat: sintaks disembunyikan, dan muncul lagi saat kursor berada di barisnya. Coba klik baris ini.

## Format teks

- **Tebal** dengan \`Ctrl+B\`, *miring* dengan \`Ctrl+I\`
- ~~Coret~~, ==stabilo==, dan \`kode inline\`
- Tautan: [GTK](https://www.gtk.org) — **Ctrl+klik** untuk membuka

## Daftar tugas

- [x] Buka folder kerja
- [ ] Catat keputusan rapat hari ini (klik kotaknya untuk mencentang)

1. Tulis rencana
2. Tekan Enter untuk lanjut otomatis

> Kutipan juga bisa.
> Tekan Enter di baris kosong untuk keluar.

\`\`\`js
function sisaAnggaran(total, terpakai) {
    return total - terpakai;
}
\`\`\`

| Shortcut | Fungsi |
| -------- | ------ |
| Ctrl+1…6 | Heading |
| Ctrl+/   | Mode source |
| F8       | Mode fokus |

\`\`\`mermaid
graph LR
    A[Catat] --> B{Perlu tindak lanjut?}
    B -->|ya| C[Buat tugas]
    B -->|belum| A
\`\`\`

---

Buka menu ☰ untuk ekspor HTML, mode gelap, dan lainnya.
`;
