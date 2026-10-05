// Ukur biaya fitur baru secara lokal, tanpa penyedia model atau widget.
import GLib from 'gi://GLib';
import { planBatch } from '../src/agent/batch.js';
import { verifyWork } from '../src/agent/verification.js';
import { serializeChat, parseChat, type SavedChat } from '../src/agent/transcript.js';
import { compactHistory } from '../src/agent/recovery.js';
import { readTextFile, writeTextFile } from '../src/files.js';
import type { ActionEvent } from '../src/agent/journal.js';

const directory = GLib.dir_make_tmp('nyerat-bench-agentic-XXXXXX');
const checkpoint = GLib.build_filenamev([directory, 'checkpoint.md']);
const measure = (name: string, action: () => void) => {
    for (let i = 0; i < 3; i++) action();
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) { const start = GLib.get_monotonic_time(); action(); samples.push((GLib.get_monotonic_time() - start) / 1000); }
    const sorted = [...samples].sort((a, b) => a - b);
    print(`${name}: median ${((sorted[4] + sorted[5]) / 2).toFixed(3)} ms · p95 ${sorted[9].toFixed(3)} ms · maks ${sorted[9].toFixed(3)} ms`);
};
try {
    for (const length of [2000, 32000]) {
        const text = 'Catatan rapat.\n'.repeat(length);
        const files = Array.from({ length: 20 }, (_, n) => ({ name: `${n}.md`, text }));
        const raw = JSON.stringify({ tindakan: files.map(f => ({ alat: 'ubah_berkas', argumen: JSON.stringify({ nama: f.name, teks_lama: f.text, teks_baru: f.text + 'Rilis: 22 November\n', alasan: 'Keputusan rapat' }) })) });
        const planned = planBatch(raw, files);
        if (planned.error) throw Error(planned.error);
        const events: ActionEvent[] = [{ id: '1', question: 'Sinkronkan jadwal', tool: 'usulkan_paket', status: 'applied', changes: planned.changes, summary: 'Diterapkan', time: '2026-10-05' }];
        const chat: SavedChat = { title: 'Jadwal', model: 'fake', created: '2026-10-05', turns: [{ role: 'user', content: 'Sinkronkan jadwal' }, { role: 'assistant', content: 'Selesai diperiksa' }], events };
        print(`\n20 berkas × ${text.length} karakter; 10 pengulangan, 3 pemanasan`);
        measure('Rencanakan paket', () => { if (planBatch(raw, files).changes.length !== 20) throw Error('paket tidak lengkap'); });
        const changed = planned.changes.map(c => ({ name: c.file, text: c.after }));
        const checks = JSON.stringify({ pemeriksaan: changed.map(f => ({ berkas: f.name, jenis: 'ada', teks: '22 November' })) });
        measure('Verifikasi hasil', () => { if (!verifyWork(checks, changed).passed) throw Error('verifikasi gagal'); });
        // Struktur dibandingkan dengan isi sebelum perubahan, jadi tiap berkas diurai dua kali.
        const before = new Map(planned.changes.map(c => [c.file, c.before]));
        const structure = JSON.stringify({ pemeriksaan: changed.map(f => ({ berkas: f.name, jenis: 'struktur' })) });
        measure('Verifikasi struktur (dengan baseline)', () => { if (!verifyWork(structure, changed, f => before.get(f) ?? null).passed) throw Error('struktur gagal'); });
        const leftover = JSON.stringify({ pemeriksaan: [{ berkas: '*', jenis: 'tidak_ada', teks: '15 November' }] });
        measure('Cari sisa teks di seluruh folder (*)', () => { if (!verifyWork(leftover, changed).passed) throw Error('sisa ditemukan'); });
        measure('Checkpoint teks tanpa journal (kontrol)', () => { writeTextFile(checkpoint, serializeChat({ ...chat, events: [] })); if (!parseChat(readTextFile(checkpoint))) throw Error('checkpoint gagal'); });
        measure('Checkpoint dengan journal', () => { writeTextFile(checkpoint, serializeChat(chat)); if (parseChat(readTextFile(checkpoint))?.events?.[0].changes.length !== 20) throw Error('journal gagal'); });
    }
    const history = Array.from({ length: 200 }, (_, n) => ({ role: n % 2 ? 'assistant' as const : 'user' as const, content: 'Catatan lama '.repeat(2000) }));
    measure('Ringkas 200 giliran', () => { if (!compactHistory(history, 12000).summary) throw Error('ringkasan kosong'); });
} finally {
    GLib.unlink(checkpoint); GLib.rmdir(directory);
}
