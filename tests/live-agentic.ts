// Evaluasi pilihan alat oleh model sungguhan. Hanya menulis fixture di folder sementara.
import GLib from 'gi://GLib';
import type { Provider } from '../src/agent/provider.js';
import { ChatSession } from '../src/agent/session.js';
import { applyBatch } from '../src/agent/batch.js';
import { readTextFile, writeTextFile, fileExists } from '../src/files.js';
import { readProject } from '../src/agent/project.js';
import { GREEN, RED, RESET } from './framework.js';

export async function liveAgentic(provider: Provider, model: string, thinking: boolean): Promise<number> {
    let failures = 0;
    for (const decision of ['approve', 'reject', 'conflict'] as const) {
        const root = GLib.dir_make_tmp('nyerat-eval-agentic-XXXXXX');
        const path = (name: string) => GLib.build_filenamev([root, name]);
        const original = { 'rapat.md': '# Keputusan rapat\nRilis diundur dari 15 November ke 22 November. Materi rilis mulai dikerjakan.\n',
            'rencana.md': '# Rencana\nTanggal rilis: 15 November\n',
            'tugas.md': '---\nkanban: true\n---\n\n## Rencana\n\n- [ ] Materi rilis\n\n## Dikerjakan\n\n' };
        try {
            for (const [name, text] of Object.entries(original)) writeTextFile(path(name), text);
            const session = new ChatSession(); session.thinking = thinking;
            let proposals = 0;
            const apply = async (changes: import('../src/agent/changes.js').Change[]) => {
                proposals++;
                if (decision === 'reject') return { applied: false };
                if (decision === 'conflict') writeTextFile(path('rencana.md'), '# Disunting pengguna\n');
                const error = applyBatch(changes, { read: f => fileExists(path(f)) ? readTextFile(path(f)) : null,
                    write: c => { writeTextFile(path(c.file), c.after); },
                    rollback: c => { if (c.kind === 'create') GLib.unlink(path(c.file)); else writeTextFile(path(c.file), c.before); } });
                return { applied: !error, ...(error ? { error } : {}) };
            };
            const r = await session.ask({ question: 'Gunakan keputusan rapat.md untuk menyinkronkan tanggal rilis di rencana.md dan memindahkan Materi rilis ke Dikerjakan di tugas.md. Catat rencana pekerjaan, usulkan keduanya sebagai satu paket, lalu periksa hasil aktual sebelum menyatakan selesai. Jangan ubah rapat.md atau membuat berkas lain.', active: null, files: readProject(root, null), selection: '', mentions: [], options: { project: true, activeDocument: true, selection: true }, budget: 8000 }, provider, model, {
                onContext: () => {}, onText: () => {}, onReasoning: () => {}, currentFiles: () => readProject(root, null, true),
                onProposal: c => apply([c]), onBatchProposal: apply,
            });
            const plan = readTextFile(path('rencana.md')), board = readTextFile(path('tugas.md'));
            let passed = proposals > 0 && readTextFile(path('rapat.md')) === original['rapat.md'];
            if (decision === 'approve') passed &&= r.applied === 2 && session.events.some(e => e.tool === 'usulkan_paket' && e.status === 'applied') && session.work?.status === 'complete' && plan.includes('22 November') && !plan.includes('15 November') && board.includes('## Dikerjakan\n\n- [ ] Materi rilis');
            if (decision === 'reject') passed &&= r.applied === 0 && plan === original['rencana.md'] && board === original['tugas.md'] && session.work?.status !== 'complete';
            if (decision === 'conflict') passed &&= r.applied === 0 && plan === '# Disunting pengguna\n' && board === original['tugas.md'] && session.work?.status !== 'complete';
            print(`${passed ? GREEN : RED}${passed ? '✓' : '✗'} agentic ${decision}: ${proposals} usulan, ${r.applied} perubahan, status ${session.work?.status ?? 'tanpa rencana'}${RESET}`);
            if (!passed) failures++;
        } catch (e) { failures++; print(`${RED}✗ agentic ${decision}: ${String(e)}${RESET}`); }
        finally {
            for (const name of Object.keys(original)) GLib.unlink(path(name));
            // Jika model menyimpang dan mengusulkan berkas baru, jangan meninggalkan artefak evaluasi.
            for (const f of readProject(root, null)) GLib.unlink(path(f.name));
            GLib.rmdir(root);
        }
    }
    return failures;
}
