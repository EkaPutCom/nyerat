// Tes format berkas percakapan (agent/transcript.ts): murni, tanpa GUI.

import { chatFileName, parseChat, serializeChat, titleFrom, type SavedChat } from '../../src/agent/transcript.js';
import { section, test, eq, ok, contains } from '../framework.js';

export function transcriptTests(): void {
    section('Berkas percakapan');

    const chat: SavedChat = {
        title: 'Kontradiksi usia Raka', model: 'deepseek-flash', created: '2026-10-04T14:20:00',
        turns: [
            { role: 'user', content: 'Adakah kontradiksi usia Raka?' },
            { role: 'assistant', content: 'Ya.\n\n## Temuan\n- `bab-01.md:12` → 24 tahun\n- `bab-07.md:40` → 31 tahun\n\n```js\nconst a = 1;\n```' },
            { role: 'user', content: 'Baris pertama\nBaris kedua' },
            { role: 'assistant', content: 'Siap.' },
        ],
    };

    test('serialisasi memakai frontmatter dan judul Anda/Asisten', () => {
        const text = serializeChat(chat);
        ok(text.startsWith('---\njudul: "Kontradiksi usia Raka"\nmodel: deepseek-flash\ndibuat: 2026-10-04T14:20:00\n---\n'), text);
        contains(text, '## Anda\nAdakah kontradiksi usia Raka?\n\n## Asisten\nYa.');
        ok(text.endsWith('Siap.\n'), 'akhir berkas');
    });

    test('tulis lalu baca menghasilkan percakapan yang sama', () => {
        eq(parseChat(serializeChat(chat)), chat);
    });

    test('baris yang menyerupai penanda giliran di dalam jawaban tidak memecah giliran', () => {
        const tricky: SavedChat = { ...chat, turns: [
            { role: 'user', content: 'Tulis contoh' },
            { role: 'assistant', content: 'Begini:\n## Anda\nteks\n\\## Asisten\nlagi' },
        ] };
        const text = serializeChat(tricky);
        eq(text.match(/^## (Anda|Asisten)$/gm), ['## Anda', '## Asisten']);
        eq(parseChat(text), tricky);
    });

    test('judul dengan tanda kutip dan titik dua tetap utuh', () => {
        const odd: SavedChat = { ...chat, title: 'Apa arti "x: y"?\\' };
        eq(parseChat(serializeChat(odd))?.title, odd.title);
    });

    test('berkas tanpa giliran, atau bukan percakapan, ditolak', () => {
        eq(parseChat('# Catatan biasa\n\nIsi.'), null);
        eq(parseChat(serializeChat({ ...chat, turns: [] })), null);
        eq(parseChat(''), null);
    });

    test('berkas yang disunting tangan: tanpa frontmatter atau judul rusak tetap terbaca', () => {
        const bare = parseChat('## Anda\nHalo\n\n## Asisten\nHai\n');
        eq(bare?.turns.length, 2);
        eq(bare?.title, 'Halo');
        const broken = parseChat('---\njudul: "rusak\nmodel: x\n---\n\n## Anda\nPertanyaan ini\n');
        eq(broken?.title, 'Pertanyaan ini');
        eq(parseChat('## Anda\r\nHalo\r\n\r\n## Asisten\r\nHai\r\n')?.turns[1].content, 'Hai');
    });

    test('judul dari pertanyaan: baris pertama, dirapatkan, dipotong', () => {
        eq(titleFrom('  Adakah   kontradiksi\nusia Raka?'), 'Adakah kontradiksi');
        eq(titleFrom(''), 'Percakapan');
        const long = titleFrom('a'.repeat(100));
        eq([...long].length, 60);
        ok(long.endsWith('…'), 'tanda potong');
    });

    test('nama berkas: tanggal dan judul yang disederhanakan', () => {
        eq(chatFileName('2026-10-04T14:20:00', 'Kontradiksi usia Raka?'), '2026-10-04-kontradiksi-usia-raka.md');
        eq(chatFileName('2026-10-04T14:20:00', 'Éclair — “ujian”!'), '2026-10-04-eclair-ujian.md');
        eq(chatFileName('2026-10-04T14:20:00', '???'), '2026-10-04-percakapan.md');
        ok(chatFileName('2026-10-04T14:20:00', 'x'.repeat(100)).length <= 10 + 1 + 40 + 3, 'terlalu panjang');
    });
}
