// Tes kemampuan tindakan agent: alat sunting baru, hapus/pindah berkas, aksi kanban tambahan, persetujuan sebagian,
// catatan pengguna, Urungkan (kebalikan perubahan), alat riwayat Git, dan verifikasi struktur. Tanpa GUI dan jaringan,
// kecuali satu tes yang menjalankan git sungguhan di folder sementara.

import GLib from 'gi://GLib';
import type { SourceFile } from '../../src/agent/context.js';
import { changeState, invertChange, planChange, preflight, type Change } from '../../src/agent/changes.js';
import { applyBatch, planBatch } from '../../src/agent/batch.js';
import { parseEvents, reconcileEvents, type ActionEvent } from '../../src/agent/journal.js';
import { formatGit, parseGitCall, type GitRequest } from '../../src/agent/gittools.js';
import { verifyWork } from '../../src/agent/verification.js';
import { ChatSession, type ProposalResult, type TurnHandlers } from '../../src/agent/session.js';
import type { ChatRequest, ChatResult, Provider, ToolCall } from '../../src/agent/provider.js';
import { localLinks, newIssues, resolveLink, structureIssues } from '../../src/markdown/lint.js';
import { agentGit } from '../../src/git.js';
import { section, test, eq, ok, contains, settle, tmp } from '../framework.js';

const NOTES = '---\njudul: rapat\n---\n# Rapat\n\nRilis 15 November.\nCatatan: 15 November final.\n';
const PAPAN = '---\nkanban: true\n---\n\n## Rencana\n\n- [ ] Materi rilis\n\n## Dikerjakan\n\n## Selesai\n\n- [x] Pesan tempat\n';
const base = (): SourceFile[] => [{ name: 'rapat.md', text: NOTES }, { name: 'papan.md', text: PAPAN }, { name: 'arsip/lama.md', text: '# Lama\n' }];

const planned = (name: string, args: object, files = base()): Change => {
    const r = planChange(name, JSON.stringify({ alasan: 'uji', ...args }), files);
    if (!r.ok) throw new Error(r.message);
    return r.change;
};
const refused = (name: string, args: object, files = base()): string => {
    const r = planChange(name, JSON.stringify({ alasan: 'uji', ...args }), files);
    ok(!r.ok, 'seharusnya ditolak');
    return r.ok ? '' : r.message;
};

const call = (name: string, args: unknown, id = name): ToolCall => ({ id, name, arguments: JSON.stringify(args) });
const result = (toolCalls: ToolCall[] = []): ChatResult => ({ usage: null, cancelled: false, toolCalls, reasoning: '' });

// Sesi dengan disk di memori; provider memutar daftar panggilan alat lalu menjawab. Pesan alat yang kembali dikumpulkan.
function harness(steps: ToolCall[][], answer: (changes: Change[]) => ProposalResult = () => ({ applied: true })) {
    const disk = new Map(base().map(f => [f.name, f.text]));
    const files = () => [...disk].map(([name, text]) => ({ name, text }));
    const session = new ChatSession();
    const replies: string[] = [];
    const handlers: TurnHandlers = {
        onContext: () => {}, onText: () => {}, onReasoning: () => {}, currentFiles: files,
        onProposal: async c => { const a = answer([c]); if (a.applied) sync(disk, c); return a; },
        onBatchProposal: async changes => {
            const a = answer(changes);
            if (!a.applied) return a;
            const chosen = changes.filter((_, i) => !a.accepted || a.accepted.includes(i));
            const error = applyBatch(chosen, { read: f => disk.get(f) ?? null, write: c => sync(disk, c), rollback: () => {} });
            return error ? { applied: false, error } : a;
        },
    };
    let n = 0;
    const provider: Provider = { chat: async (req: ChatRequest) => {
        for (const m of req.messages) if (m.role === 'tool' && !replies.includes(m.content)) replies.push(m.content);
        if (n < steps.length) return result(steps[n++]);
        req.onText('Selesai.'); return result();
    } };
    const input = () => ({ question: 'Kerjakan', active: null, selection: '', files: files(), mentions: [], options: { activeDocument: true, selection: true, project: true }, budget: 8000 });
    return { disk, session, handlers, replies, run: () => settle(session.ask(input(), provider, 'fake', handlers)) };
}
function sync(disk: Map<string, string>, c: Change): void {
    if (c.kind === 'delete') disk.delete(c.file);
    else if (c.kind === 'move') { disk.delete(c.file); disk.set(c.to!, c.after); }
    else disk.set(c.file, c.after);
}

export function agentActionTests(): void {
    section('Agent: alat sunting dan berkas');

    test('ubah_berkas semua=true mengganti setiap kemunculan; tanpa itu tetap menolak yang tidak unik', () => {
        eq(planned('ubah_berkas', { nama: 'rapat', teks_lama: '15 November', teks_baru: '22 November', semua: true }).after, NOTES.replaceAll('15 November', '22 November'));
        contains(refused('ubah_berkas', { nama: 'rapat', teks_lama: '15 November', teks_baru: '22 November' }), 'semua=true');
    });

    test('sisip_teks: awal setelah frontmatter, akhir, dan setelah baris dengan pengaman isi_baris', () => {
        eq(planned('sisip_teks', { nama: 'rapat', posisi: 'awal', teks: '> Ringkasan' }).after, NOTES.replace('---\n# Rapat', '---\n> Ringkasan\n# Rapat'));
        eq(planned('sisip_teks', { nama: 'rapat', posisi: 'akhir', teks: '- Tindak lanjut\n' }).after, `${NOTES}- Tindak lanjut\n`);
        eq(planned('sisip_teks', { nama: 'rapat', posisi: 'setelah_baris', baris: 6, isi_baris: 'Rilis 15 November.', teks: 'Disetujui semua.' }).after,
            NOTES.replace('Rilis 15 November.\n', 'Rilis 15 November.\nDisetujui semua.\n'));
        contains(refused('sisip_teks', { nama: 'rapat', posisi: 'setelah_baris', baris: 5, isi_baris: 'Rilis 15 November.', teks: 'x' }), 'ada di baris 6');
        contains(refused('sisip_teks', { nama: 'rapat', posisi: 'setelah_baris', baris: 99, isi_baris: 'x', teks: 'x' }), '"baris" harus');
        contains(refused('sisip_teks', { nama: 'rapat', posisi: 'setelah_baris', baris: 6, teks: 'x' }), 'isi_baris');
        contains(refused('sisip_teks', { nama: 'rapat', posisi: 'tengah', teks: 'x' }), 'posisi');
        // Berkas tanpa baris baru di akhir: hanya sisipan di ujung yang menambahkannya.
        const bare = [{ name: 'a.md', text: 'satu\ndua' }];
        eq(planned('sisip_teks', { nama: 'a', posisi: 'akhir', teks: 'tiga' }, bare).after, 'satu\ndua\ntiga\n');
        eq(planned('sisip_teks', { nama: 'a', posisi: 'awal', teks: 'nol' }, bare).after, 'nol\nsatu\ndua');
        eq(planned('sisip_teks', { nama: 'a', posisi: 'akhir', teks: 'isi' }, [{ name: 'a.md', text: '' }]).after, 'isi\n');
    });

    test('hapus_berkas dan pindah_berkas: bentuk usulan, nama tujuan aman, tujuan terpakai ditolak', () => {
        const del = planned('hapus_berkas', { nama: 'arsip/lama' });
        eq([del.kind, del.file, del.before, del.after], ['delete', 'arsip/lama.md', '# Lama\n', '']);
        const move = planned('pindah_berkas', { nama: 'rapat', tujuan: 'arsip/rapat-okt' });
        eq([move.kind, move.file, move.to, move.after], ['move', 'rapat.md', 'arsip/rapat-okt.md', NOTES]);
        contains(refused('pindah_berkas', { nama: 'rapat', tujuan: '../luar' }), 'tidak valid');
        contains(refused('pindah_berkas', { nama: 'rapat', tujuan: 'PAPAN.md' }), 'sudah ada');
        contains(refused('pindah_berkas', { nama: 'rapat', tujuan: 'rapat.md' }), 'sama');
        contains(refused('hapus_berkas', { nama: 'tidak-ada' }), 'tidak ditemukan');
    });

    test('ubah_kanban: ubah teks kartu, hapus kartu, dan kelola daftar; daftar berisi kartu tidak bisa dihapus', () => {
        const kanban = (args: object) => planned('ubah_kanban', { nama: 'papan', ...args }).after;
        contains(kanban({ aksi: 'ubah', kartu: 'Materi', teks_baru: 'Materi rilis v2 #penting' }), '- [ ] Materi rilis v2 #penting');
        ok(!kanban({ aksi: 'hapus', kartu: 'Pesan tempat' }).includes('Pesan tempat'), 'kartu tidak terhapus');
        contains(kanban({ aksi: 'tambah_daftar', daftar: 'Ditunda' }), '## Ditunda');
        contains(kanban({ aksi: 'ganti_nama_daftar', daftar: 'Dikerjakan', teks_baru: 'Sedang jalan' }), '## Sedang jalan');
        ok(!kanban({ aksi: 'hapus_daftar', daftar: 'Dikerjakan' }).includes('## Dikerjakan'), 'daftar kosong tidak terhapus');
        contains(refused('ubah_kanban', { nama: 'papan', aksi: 'hapus_daftar', daftar: 'Rencana' }), 'masih berisi 1 kartu');
        contains(refused('ubah_kanban', { nama: 'papan', aksi: 'tambah_daftar', daftar: 'selesai' }), 'sudah ada');
        contains(refused('ubah_kanban', { nama: 'papan', aksi: 'ubah', kartu: 'Materi' }), 'teks_baru');
    });

    test('kebalikan perubahan dan pemeriksaan keadaan untuk tiap jenis', () => {
        const read = (files: Map<string, string>) => (f: string) => files.get(f) ?? null;
        const kinds: Change[] = [
            { kind: 'create', file: 'baru.md', before: '', after: 'isi\n', reason: 'r' },
            { kind: 'edit', file: 'a.md', before: 'lama\n', after: 'baru\n', reason: 'r' },
            { kind: 'delete', file: 'a.md', before: 'lama\n', after: '', reason: 'r' },
            { kind: 'move', file: 'a.md', to: 'b/a.md', before: 'lama\n', after: 'lama\n', reason: 'r' },
        ];
        for (const c of kinds) {
            const disk = new Map(c.kind === 'create' ? [] : [['a.md', 'lama\n']]);
            eq(changeState(c, read(disk)), 'before', `${c.kind} sebelum`);
            eq(preflight(c, read(disk)), null, `${c.kind} preflight`);
            sync(disk, c);
            eq(changeState(c, read(disk)), 'after', `${c.kind} sesudah`);
            const back = invertChange(c);
            eq(preflight(back, read(disk)), null, `${c.kind} urungkan preflight`);
            sync(disk, back);
            eq([...disk], c.kind === 'create' ? [] : [['a.md', 'lama\n']], `${c.kind} kembali`);
        }
        contains(preflight(kinds[3], f => f === 'a.md' ? 'lama\n' : 'ada') ?? '', 'b/a.md sudah ada');
        contains(preflight(kinds[1], () => 'disunting pengguna') ?? '', 'berubah sejak diusulkan');
    });

    test('paket: berkas yang dihapus/dipindah tidak boleh disentuh tindakan lain; hapus dan pindah bisa dipaket', () => {
        const act = (alat: string, args: object) => ({ alat, argumen: JSON.stringify({ alasan: 'x', ...args }) });
        const blocked = planBatch(JSON.stringify({ tindakan: [act('ubah_berkas', { nama: 'rapat', teks_lama: 'Rilis', teks_baru: 'Peluncuran' }), act('pindah_berkas', { nama: 'rapat', tujuan: 'arsip/rapat' })] }), base());
        contains(blocked.error ?? '', 'dihapus atau dipindah');
        const after = planBatch(JSON.stringify({ tindakan: [act('pindah_berkas', { nama: 'rapat', tujuan: 'arsip/rapat' }), act('ubah_berkas', { nama: 'arsip/rapat', teks_lama: 'Rilis', teks_baru: 'x' })] }), base());
        contains(after.error ?? '', 'dihapus atau dipindah');
        const ok2 = planBatch(JSON.stringify({ tindakan: [act('pindah_berkas', { nama: 'rapat', tujuan: 'arsip/rapat' }), act('hapus_berkas', { nama: 'arsip/lama' })] }), base());
        eq(ok2.changes.map(c => c.kind), ['move', 'delete']);
        const disk = new Map(base().map(f => [f.name, f.text]));
        eq(applyBatch(ok2.changes, { read: f => disk.get(f) ?? null, write: c => sync(disk, c), rollback: () => {} }), null);
        eq([...disk.keys()].sort(), ['arsip/rapat.md', 'papan.md']);
    });

    test('journal: pindah/hapus divalidasi, dipulihkan setelah interupsi, dan status diurungkan diterima', () => {
        const move: Change = { kind: 'move', file: 'a.md', to: 'b.md', before: 'x', after: 'x', reason: 'r' };
        const ev = (changes: Change[], status: ActionEvent['status'] = 'proposed'): ActionEvent => ({ id: '1', question: 'q', tool: 'pindah_berkas', status, changes, summary: '', time: 't' });
        eq(parseEvents([ev([move]), ev([{ ...move, to: '../luar.md' }]), ev([{ ...move, to: undefined }]), ev([move], 'reverted')]).length, 2);
        const events = [ev([move]), ev([{ kind: 'delete', file: 'c.md', before: 'y', after: '', reason: 'r' }])];
        reconcileEvents(events, [{ name: 'b.md', text: 'x' }]);
        eq(events.map(e => e.status), ['applied', 'applied']);
        const pending = [ev([move])];
        reconcileEvents(pending, [{ name: 'a.md', text: 'x' }]);
        eq(pending[0].status, 'interrupted');
    });

    section('Agent: verifikasi struktur');

    test('struktur: tabel, heading melompat/kosong, blok kode tidak ditutup; isi kode dan frontmatter diabaikan', () => {
        const text = '---\njudul: x\n---\n# A\n### Lompat\n##\n\n| a | b |\n| - | - |\n| 1 |\n| 1 | 2 |\n\n```\n# bukan heading\n| x |\n';
        const issues = structureIssues(text).map(i => i.text);
        ok(issues.some(t => t.includes('melompat dari H1 ke H3')), issues.join('\n'));
        ok(issues.some(t => t.includes('heading kosong')), issues.join('\n'));
        ok(issues.some(t => t.includes('1 sel, judul 2 kolom')), issues.join('\n'));
        ok(issues.some(t => t.includes('tidak ditutup')), issues.join('\n'));
        eq(issues.length, 4, issues.join('\n'));
        eq(structureIssues('## Mulai dari H2\n### Turun satu\n').length, 0);
    });

    test('tautan lokal: diambil di luar kode, URL dan jangkar dilewati, path relatif diselesaikan', () => {
        const links = localLinks('[a](../b.md#x) ![g](gambar.png) [web](https://x.id) [j](#atas) `[k](kode.md)` [s](<dengan%20spasi.md>)');
        eq(links.map(l => l.target), ['../b.md', 'gambar.png', 'dengan spasi.md']);
        eq(resolveLink('bab/satu.md', '../b.md'), 'b.md');
        eq(resolveLink('satu.md', '../b.md'), null);
        eq(newIssues([{ line: 1, key: 'x', text: '' }], [{ line: 9, key: 'x', text: '' }, { line: 10, key: 'x', text: 'baru' }]).map(i => i.text), ['baru']);
    });

    test('verifyWork: "*" mencari sisa teks di seluruh folder; struktur hanya menggagalkan masalah baru', () => {
        const files = [{ name: 'a.md', text: 'Rilis 22 November\n' }, { name: 'b.md', text: 'masih 15 November\n[ke c](c.md)\n' }];
        const v = verifyWork(JSON.stringify({ pemeriksaan: [{ berkas: '*', jenis: 'tidak_ada', teks: '15 November' }, { berkas: '*', jenis: 'ada', teks: '22 November' }] }), files);
        eq(v.checks.map(c => c.passed), [false, true]);
        contains(v.checks[0].label, 'b.md:1');
        const broken = '| a | b |\n| - | - |\n| 1 |\n';
        const struct = (baseline: string | null) => verifyWork(JSON.stringify({ pemeriksaan: [{ berkas: 'b.md', jenis: 'struktur' }] }), [{ name: 'b.md', text: `${broken}[ke c](c.md)\n` }], () => baseline).checks[0];
        eq(struct(null).passed, false);
        contains(struct(null).label, 'tautan ke "c.md"');
        eq(struct(`${broken}[ke c](c.md)\n`).passed, true);
        contains(struct(`${broken}[ke c](c.md)\n`).label, '2 masalah lama');
        eq(struct('[ke c](c.md)\n').passed, false);
        eq(verifyWork(JSON.stringify({ pemeriksaan: [{ berkas: 'a.md', jenis: 'ada' }] }), files).checks[0].label, 'Pemeriksaan tidak valid');
    });

    section('Agent: persetujuan sebagian, catatan, dan verifikasi otomatis');

    const act = (alat: string, args: object) => ({ alat, argumen: JSON.stringify({ alasan: 'x', ...args }) });
    const pack = call('usulkan_paket', { tindakan: [
        act('ubah_berkas', { nama: 'rapat', teks_lama: '15 November', teks_baru: '22 November', semua: true }),
        act('ubah_kanban', { nama: 'papan', aksi: 'pindah', kartu: 'Materi', daftar: 'Dikerjakan' }),
        act('hapus_berkas', { nama: 'arsip/lama' }),
    ] });

    test('paket diterapkan sebagian: hanya berkas terpilih berubah, journal mencatat dua keputusan, model diberi tahu', () => {
        const h = harness([[pack]], () => ({ applied: true, accepted: [0, 2], note: 'Papan biar saya atur sendiri' }));
        const r = h.run();
        eq(r.applied, 2);
        contains(h.disk.get('rapat.md')!, '22 November');
        eq(h.disk.get('papan.md'), PAPAN);
        eq(h.disk.has('arsip/lama.md'), false);
        eq(h.session.events.map(e => [e.status, e.changes.map(c => c.file)]), [['applied', ['rapat.md', 'arsip/lama.md']], ['rejected', ['papan.md']]]);
        const reply = h.replies.find(m => m.includes('sebagian'))!;
        contains(reply, 'Ditolak (jangan ulangi tanpa ditanya): papan.md');
        contains(reply, 'Catatan pengguna: Papan biar saya atur sendiri');
    });

    test('usulan tunggal ditolak dengan catatan: catatan sampai ke model', () => {
        const h = harness([[call('ubah_berkas', { nama: 'rapat', teks_lama: 'Rilis 15', teks_baru: 'Rilis 16', alasan: 'x' })]], () => ({ applied: false, note: 'Tanggalnya 22, bukan 16' }));
        h.run();
        ok(h.replies.some(m => m.includes('Catatan pengguna: Tanggalnya 22, bukan 16')), h.replies.join('\n'));
    });

    test('verifikasi otomatis: berkas terhapus dicek tidak ada, struktur berkas yang diubah ikut diperiksa', () => {
        const breakTable = call('sisip_teks', { nama: 'rapat', posisi: 'akhir', teks: '| a | b |\n| - | - |\n| 1 |', alasan: 'x' }, 's1');
        const del = call('hapus_berkas', { nama: 'arsip/lama', alasan: 'x' }, 'h1');
        const verify = call('verifikasi_pekerjaan', { pemeriksaan: [{ berkas: 'rapat.md', jenis: 'ada', teks: '| a | b |' }] });
        const h = harness([[call('atur_pekerjaan', { tujuan: 'g', langkah: [{ teks: 'a', status: 'done' }], catatan: '' })], [breakTable], [del], [verify]]);
        h.run();
        const checks = h.session.work!.verification!.checks;
        ok(checks.some(c => c.file === 'arsip/lama.md' && c.passed && c.label.includes('dihapus')), JSON.stringify(checks));
        ok(checks.some(c => c.file === 'rapat.md' && !c.passed && c.label.includes('1 sel, judul 2 kolom')), JSON.stringify(checks));
        eq(h.session.work!.status, 'paused');
    });

    section('Agent: alat riwayat Git');

    test('parseGitCall memvalidasi commit dan berkas; formatGit merapikan log, diff, dan isi versi', () => {
        eq(parseGitCall('riwayat_git', '{}'), { kind: 'log', file: null, limit: 15 });
        eq(parseGitCall('riwayat_git', '{"berkas":"rencana.md","maks":500}'), { kind: 'log', file: 'rencana.md', limit: 50 });
        for (const bad of ['--output=/tmp/x', 'main', 'abc', 'HEAD;rm']) contains(parseGitCall('lihat_commit', JSON.stringify({ commit: bad })) as string, 'tidak valid');
        contains(parseGitCall('isi_versi', '{"commit":"HEAD~2","berkas":"../x.md"}') as string, 'tidak valid');
        contains(parseGitCall('isi_versi', '{"commit":"HEAD"}') as string, 'wajib');
        const log = formatGit({ kind: 'log', file: null, limit: 5 }, { ok: true, text: '\x1ea1b2c3d\x1f2026-10-01 10:00\x1fEka\x1fUndur rilis\n\nM\trencana.md\nR100\tlama.md\tarsip/lama.md\n' });
        eq(log.content, 'a1b2c3d 2026-10-01 10:00 · Eka · Undur rilis\n  ubah rencana.md\n  pindah lama.md → arsip/lama.md');
        eq(log.summary, '1 commit');
        eq(formatGit({ kind: 'show', commit: 'HEAD', file: null }, { ok: true, text: 'a1b2 2026 · Eka · x\n' }).summary, 'tanpa perubahan');
        eq(formatGit({ kind: 'file', commit: 'HEAD', file: 'a.md' }, { ok: true, text: 'satu\ndua\n' }).content, '[a.md pada HEAD, 2 baris]\n1│ satu\n2│ dua');
        eq(formatGit({ kind: 'log', file: null, limit: 1 }, { ok: false, message: 'fatal: not a git repository' }).content, 'Folder kerja bukan repositori Git.');
    });

    test('sesi: alat Git hanya ditawarkan bila ada handler; hasilnya kembali ke model', () => {
        const asked: GitRequest[] = [];
        const h = harness([[call('riwayat_git', { berkas: 'rapat.md' })]]);
        let tools: string[] = [];
        h.handlers.git = async request => { asked.push(request); return { ok: true, text: '\x1ea1b2c3d\x1f2026-10-01 10:00\x1fEka\x1fUndur rilis\n\nM\trapat.md\n' }; };
        const provider: Provider = { chat: async req => { tools = req.tools?.map(t => t.name) ?? tools; return result(); } };
        settle(h.session.ask({ question: 'q', active: null, selection: '', files: base(), mentions: [], options: { activeDocument: true, selection: true, project: true }, budget: 8000 }, provider, 'fake', h.handlers));
        ok(tools.includes('riwayat_git') && tools.includes('isi_versi'), tools.join(','));
        h.run();
        eq(asked, [{ kind: 'log', file: 'rapat.md', limit: 15 }]);
        ok(h.replies.some(m => m.includes('Undur rilis')), h.replies.join('\n'));
        delete h.handlers.git;
        settle(h.session.ask({ question: 'q', active: null, selection: '', files: base(), mentions: [], options: { activeDocument: true, selection: true, project: true }, budget: 8000 }, provider, 'fake', h.handlers));
        ok(!tools.includes('riwayat_git'), 'alat Git ditawarkan tanpa handler');
    });

    test('agentGit di repositori sungguhan: log, diff, dan isi versi terbatas pada Markdown tidak tersembunyi', () => {
        const root = GLib.build_filenamev([tmp, 'git-agent']);
        GLib.mkdir_with_parents(GLib.build_filenamev([root, '.rahasia']), 0o755);
        const write = (name: string, text: string) => GLib.file_set_contents(GLib.build_filenamev([root, name]), text);
        const git = (...args: string[]) => {
            const [okRun, , , status] = GLib.spawn_sync(root, ['git', '-c', 'user.name=Uji', '-c', 'user.email=uji@contoh.id', ...args], null, GLib.SpawnFlags.SEARCH_PATH, null);
            ok(okRun && status === 0, `git ${args.join(' ')} gagal`);
        };
        git('init', '-q');
        write('rencana.md', 'Rilis 15 November\n'); write('.rahasia/x.md', 'rahasia\n'); write('kode.txt', 'x\n');
        git('add', '-A'); git('commit', '-qm', 'Awal');
        write('rencana.md', 'Rilis 22 November\n'); write('.rahasia/x.md', 'rahasia 2\n');
        git('commit', '-qam', 'Undur rilis');
        const log = formatGit({ kind: 'log', file: null, limit: 10 }, settle(agentGit(root, { kind: 'log', file: null, limit: 10 })));
        contains(log.content, 'Undur rilis');
        contains(log.content, 'ubah rencana.md');
        ok(!log.content.includes('rahasia') && !log.content.includes('kode.txt'), log.content);
        const show = formatGit({ kind: 'show', commit: 'HEAD', file: null }, settle(agentGit(root, { kind: 'show', commit: 'HEAD', file: null })));
        contains(show.content, '+Rilis 22 November');
        ok(!show.content.includes('rahasia'), show.content);
        const old = formatGit({ kind: 'file', commit: 'HEAD~1', file: 'rencana.md' }, settle(agentGit(root, { kind: 'file', commit: 'HEAD~1', file: 'rencana.md' })));
        contains(old.content, '1│ Rilis 15 November');
    });
}
