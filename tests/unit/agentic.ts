// Evaluasi pekerjaan lengkap dengan provider deterministik, disk virtual, dan checkpoint sungguhan.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { readProject } from '../../src/agent/project.js';
import { projectPath } from '../../src/agent/path.js';
import { ChatSession, type TurnHandlers } from '../../src/agent/session.js';
import { applyBatch } from '../../src/agent/batch.js';
import { parseChat, serializeChat } from '../../src/agent/transcript.js';
import type { ToolCall, Provider, ChatResult } from '../../src/agent/provider.js';
import type { SourceFile } from '../../src/agent/context.js';
import type { Change } from '../../src/agent/changes.js';
import { section, test, eq, ok, contains, settle } from '../framework.js';

const call = (name: string, args: unknown): ToolCall => ({ id: name, name, arguments: JSON.stringify(args) });
const result = (toolCalls: ToolCall[] = []): ChatResult => ({ usage: null, cancelled: false, toolCalls, reasoning: '' });
const goal = 'Sinkronkan tanggal rilis dan papan';
const plan = (done: boolean) => call('atur_pekerjaan', { tujuan: goal, langkah: [{ teks: 'Sinkronkan rencana dan papan', status: done ? 'done' : 'pending' }], catatan: '' });
const batch = call('usulkan_paket', { tindakan: [
    { alat: 'ubah_berkas', argumen: JSON.stringify({ nama: 'rencana.md', teks_lama: '15 November', teks_baru: '22 November', alasan: 'Keputusan rapat' }) },
    { alat: 'ubah_kanban', argumen: JSON.stringify({ nama: 'papan.md', aksi: 'pindah', kartu: 'Materi rilis', daftar: 'Dikerjakan', alasan: 'Mulai pengerjaan' }) },
] });
const verify = call('verifikasi_pekerjaan', { pemeriksaan: [
    { berkas: 'rencana.md', jenis: 'ada', teks: '22 November' },
    { berkas: 'rencana.md', jenis: 'tidak_ada', teks: '15 November' },
    { berkas: 'papan.md', jenis: 'kanban', teks: 'Materi rilis', daftar: 'Dikerjakan', selesai: false },
] });

const initial = (): SourceFile[] => [{ name: 'rencana.md', text: '# Rencana\nRilis 15 November\n' },
    { name: 'papan.md', text: '---\nkanban: true\n---\n\n## Rencana\n\n- [ ] Materi rilis\n\n## Dikerjakan\n\n' }];

function harness() {
    const disk = new Map(initial().map(f => [f.name, f.text]));
    const session = new ChatSession();
    const files = () => [...disk].map(([name, text]) => ({ name, text }));
    let checkpoint = '', proposals = 0;
    const handlers: TurnHandlers = {
        onContext: () => {}, onText: () => {}, onReasoning: () => {}, currentFiles: files,
        onState: () => { checkpoint = serializeChat({ title: goal, model: 'fake', created: '2026-10-05', turns: session.history, work: session.work, events: session.events }); },
        onProposal: async (c: Change) => { proposals++; disk.set(c.file, c.after); return { applied: true }; },
        onBatchProposal: async changes => {
            proposals++;
            const error = applyBatch(changes, { read: f => disk.get(f) ?? null, write: c => { disk.set(c.file, c.after); }, rollback: c => { if (c.kind === 'create') disk.delete(c.file); else disk.set(c.file, c.before); } });
            return { applied: !error, ...(error ? { error } : {}) };
        },
    };
    const input = () => ({ question: goal, active: null, selection: '', files: files(), mentions: [], options: { activeDocument: true, selection: true, project: true }, budget: 8000 });
    const run = (steps: ToolCall[][], failAtEnd = false) => {
        let n = 0;
        const provider: Provider = { chat: async req => {
            if (n < steps.length) return result(steps[n++]);
            if (failAtEnd) throw Error('koneksi putus');
            req.onText('Hasil sudah diperiksa.'); return result();
        } };
        return settle(session.ask(input(), provider, 'fake', handlers));
    };
    return { session, disk, handlers, input, run, checkpoint: () => checkpoint, proposals: () => proposals };
}

export function agenticTests(): void {
    section('Evaluasi agent: pekerjaan sampai hasil terverifikasi');
    test('batas folder menolak pembuatan berkas melalui symlink', () => {
        const root = GLib.dir_make_tmp('nyerat-path-XXXXXX');
        const outside = GLib.dir_make_tmp('nyerat-outside-XXXXXX');
        const link = Gio.File.new_for_path(GLib.build_filenamev([root, 'tautan']));
        try {
            link.make_symbolic_link(outside, null);
            let rejected = false;
            try { projectPath(root, 'tautan/baru.md'); } catch { rejected = true; }
            eq(rejected, true);
            eq(projectPath(root, 'catatan/baru.md'), GLib.build_filenamev([root, 'catatan', 'baru.md']));
        } finally { link.delete(null); GLib.rmdir(root); GLib.rmdir(outside); }
    });
    test('verifikasi membaca ulang perubahan ukuran sama dan melewati symlink sumber', () => {
        const root = GLib.dir_make_tmp('nyerat-fresh-XXXXXX');
        const file = Gio.File.new_for_path(GLib.build_filenamev([root, 'a.md']));
        const link = Gio.File.new_for_path(GLib.build_filenamev([root, 'alias.md']));
        try {
            GLib.file_set_contents(file.get_path()!, 'lama');
            eq(readProject(root, null)[0].text, 'lama');
            const info = file.query_info('time::modified,time::modified-usec', Gio.FileQueryInfoFlags.NONE, null);
            GLib.file_set_contents(file.get_path()!, 'baru');
            file.set_attribute_uint64('time::modified', info.get_attribute_uint64('time::modified'), Gio.FileQueryInfoFlags.NONE, null);
            file.set_attribute_uint32('time::modified-usec', info.get_attribute_uint32('time::modified-usec'), Gio.FileQueryInfoFlags.NONE, null);
            link.make_symbolic_link(file.get_path()!, null);
            const fresh = readProject(root, null, true);
            eq(fresh.map(f => f.name), ['a.md']); eq(fresh[0].text, 'baru');
        } finally { if (link.query_exists(null)) link.delete(null); file.delete(null); GLib.rmdir(root); }
    });
    test('rencana → persetujuan paket → verifikasi hasil aktual → selesai; checkpoint dapat dibuka', () => {
        const h = harness();
        const r = h.run([[plan(false)], [batch], [plan(true)], [verify]]);
        eq(r.applied, 2); eq(h.proposals(), 1);
        eq(h.session.work?.status, 'complete');
        const saved = parseChat(h.checkpoint());
        eq(saved?.work?.status, 'complete'); eq(saved?.events?.find(e => e.tool === 'usulkan_paket')?.status, 'applied');
        contains(h.disk.get('rencana.md')!, '22 November');
    });
    test('percakapan baru selama respons tertunda tidak dicampur dengan hasil pekerjaan lama', () => {
        const h = harness();
        let finish: (() => void) | null = null;
        const pending = h.session.ask(h.input(), { chat: req => new Promise(resolve => { finish = () => { req.onText('jawaban lama'); resolve(result()); }; }) }, 'fake', h.handlers);
        h.session.clear();
        ok(finish, 'provider tidak dipanggil');
        (finish as () => void)();
        const r = settle(pending);
        eq(r.cancelled, true); eq(h.session.history, []); eq(h.session.events, []); eq(h.session.work, null);
    });
    test('semua langkah done tanpa verifikasi belum dianggap selesai', () => {
        const h = harness(); h.run([[plan(true)]]);
        eq(h.session.work?.status, 'paused');
    });
    test('verifikasi harus mencakup seluruh berkas yang berubah dan membaca perubahan eksternal', () => {
        const h = harness();
        h.handlers.currentFiles = () => [{ name: 'rencana.md', text: 'Rilis 15 November' }];
        h.run([[plan(false)], [batch], [plan(true)], [verify]]);
        eq(h.session.work?.verification?.passed, false); eq(h.session.work?.status, 'paused');
        const omitted = harness();
        omitted.run([[plan(false)], [batch], [plan(true)], [call('verifikasi_pekerjaan', { pemeriksaan: [{ berkas: 'rencana.md', jenis: 'ada', teks: '22 November' }] })]]);
        eq(omitted.session.work?.verification?.passed, false);
    });
    test('paket ditolak tidak mengubah disk; keputusan tetap ada setelah pemulihan', () => {
        const h = harness(), before = [...h.disk];
        h.handlers.onBatchProposal = async () => ({ applied: false });
        const r = h.run([[plan(false)], [batch]]);
        eq(r.applied, 0); eq([...h.disk], before);
        eq(parseChat(h.checkpoint())?.events?.[0].status, 'rejected');
    });
    test('konflik pada satu berkas membatalkan seluruh paket dan dicatat gagal', () => {
        const h = harness(), apply = h.handlers.onBatchProposal!;
        h.handlers.onBatchProposal = async changes => { h.disk.set('papan.md', 'Disunting pengguna'); return apply(changes); };
        h.run([[plan(false)], [batch]]);
        contains(h.disk.get('rencana.md')!, '15 November');
        eq(h.session.events[0].status, 'failed');
    });
    test('koneksi gagal setelah penerapan: checkpoint tetap menyimpan hasil dan giliran berikutnya tidak perlu mengulangnya', () => {
        const h = harness();
        let failed = false;
        try { h.run([[plan(false)], [batch]], true); } catch { failed = true; }
        eq(failed, true); eq(h.session.work?.status, 'failed');
        const saved = parseChat(h.checkpoint())!;
        const restored = new ChatSession(); restored.restore(saved.turns); restored.work = saved.work!; restored.events.push(...saved.events!);
        let proposed = 0;
        const handlers = { ...h.handlers, onState: () => {}, onBatchProposal: async () => { proposed++; return { applied: false }; } };
        let n = 0;
        settle(restored.ask(h.input(), { chat: async req => {
            if (n++ === 0) {
                ok(req.messages.some(m => m.content?.includes('Diterapkan: usulkan_paket')), 'hasil terdahulu tidak ada di konteks');
                eq(req.messages[req.messages.length - 1].content.includes(goal), true);
                return result([plan(true), verify]);
            }
            req.onText('Selesai diperiksa.'); return result();
        } }, 'fake', handlers));
        eq(proposed, 0); eq(restored.work?.status, 'complete');
    });
}
