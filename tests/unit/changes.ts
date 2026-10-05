// Tes perubahan yang diusulkan agent: validasi usulan, pratinjau selisih, dan alur persetujuan di sesi.
// Tanpa GUI dan tanpa jaringan.

import { buildContext, type ContextInput, type SourceFile } from '../../src/agent/context.js';
import { cleanNewName, CHANGE_TOOLS, diffPreview, planChange, type Change } from '../../src/agent/changes.js';
import { ChatSession, type ProposalResult, type ToolStep } from '../../src/agent/session.js';
import { describeCall } from '../../src/agent/tools.js';
import type { ChatRequest, ChatResult, Provider } from '../../src/agent/provider.js';
import { section, test, eq, ok, contains, settle } from '../framework.js';

const RENCANA = '# Rencana\n\n- Draf pertama: Oktober\n- Revisi: November\n\n## Catatan\n\nBelum ada.\n';
const files: SourceFile[] = [{ name: 'rencana.md', text: RENCANA }, { name: 'riset/pelabuhan.md', text: '# Pelabuhan\n\nAda dua dermaga.\n' }];

const plan = (name: string, args: object, over: SourceFile[] = files) => planChange(name, JSON.stringify(args), over);

export function changeTests(): void {
    section('Agent: usulan perubahan');

    test('ubah_berkas: mengganti satu potongan persis dan menghasilkan isi baru', () => {
        const r = plan('ubah_berkas', { nama: 'rencana', teks_lama: '- Revisi: November', teks_baru: '- Revisi: Desember', alasan: 'jadwal bergeser' });
        ok(r.ok, 'ditolak');
        if (!r.ok) return;
        eq(r.change.kind, 'edit');
        eq(r.change.file, 'rencana.md');
        eq(r.change.before, RENCANA);
        eq(r.change.after, RENCANA.replace('November', 'Desember'));
        eq(r.change.reason, 'jadwal bergeser');
    });

    test('ubah_berkas: teks tidak cocok, tidak unik, sama, atau berkas tidak ada → pesan untuk model', () => {
        const bad = (args: object) => { const r = plan('ubah_berkas', { alasan: 'x', teks_baru: 'y', ...args }); ok(!r.ok, 'seharusnya gagal'); return r.ok ? '' : r.message; };
        contains(bad({ nama: 'rencana.md', teks_lama: 'tidak ada di berkas' }), 'tidak ditemukan');
        contains(bad({ nama: 'rencana.md', teks_lama: 'a' }), 'kali');
        contains(bad({ nama: 'rencana.md', teks_lama: 'Oktober', teks_baru: 'Oktober' }), 'sama');
        contains(bad({ nama: 'bab-9.md', teks_lama: 'x' }), 'tidak ditemukan');
        contains(bad({ nama: 'rencana.md', teks_lama: '' }), 'wajib');
        contains(planChange('ubah_berkas', '{rusak', files).ok ? '' : (planChange('ubah_berkas', '{rusak', files) as { message: string }).message, 'bukan JSON');
    });

    test('ubah_berkas: teks_baru kosong menghapus potongan', () => {
        const r = plan('ubah_berkas', { nama: 'rencana.md', teks_lama: '\n## Catatan\n\nBelum ada.\n', teks_baru: '', alasan: 'bersih' });
        ok(r.ok, "usulan ditolak");
        if (r.ok) eq(r.change.after, '# Rencana\n\n- Draf pertama: Oktober\n- Revisi: November\n');
    });

    test('buat_berkas: berkas baru dengan .md dan baris akhir; nama terpakai atau tidak aman ditolak', () => {
        const r = plan('buat_berkas', { nama: 'tugas/minggu-1', isi: '# Minggu 1', alasan: 'daftar tugas' });
        ok(r.ok, "usulan ditolak");
        if (r.ok) { eq(r.change.kind, 'create'); eq(r.change.file, 'tugas/minggu-1.md'); eq(r.change.after, '# Minggu 1\n'); eq(r.change.before, ''); }
        for (const nama of ['rencana.md', 'RENCANA', '../luar.md', '/etc/x.md', '.nyerat/x.md', 'a//b.md', 'a\\b.md', '']) {
            ok(!plan('buat_berkas', { nama, isi: 'x', alasan: 'x' }).ok, `diterima: "${nama}"`);
        }
        ok(!plan('buat_berkas', { nama: 'kosong.md', isi: '  ', alasan: 'x' }).ok, 'isi kosong diterima');
        eq(cleanNewName('./catatan.markdown'), 'catatan.markdown');
    });

    test('diffPreview: konteks, hapus, tambah, dan pemotongan', () => {
        const r = plan('ubah_berkas', { nama: 'rencana.md', teks_lama: '- Revisi: November', teks_baru: '- Revisi: Desember', alasan: 'x' });
        if (!r.ok) throw new Error('usulan gagal');
        const d = diffPreview(r.change.before, r.change.after);
        eq([d.added, d.removed], [1, 1]);
        eq(d.lines.filter(l => l.sign === '-').map(l => l.text), ['- Revisi: November']);
        eq(d.lines.filter(l => l.sign === '+').map(l => l.text), ['- Revisi: Desember']);
        ok(d.lines.some(l => l.sign === ' ' && l.text === '- Draf pertama: Oktober'), 'tanpa konteks');
        const created = diffPreview('', 'a\nb\n');
        eq([created.added, created.removed], [2, 0]);
        const big = diffPreview('', Array.from({ length: 200 }, (_, i) => `baris ${i}`).join('\n'));
        eq(big.added, 200);
        ok(big.lines.length <= 61, `terlalu panjang: ${big.lines.length}`);
        eq(big.lines[big.lines.length - 1].sign, '…');
    });

    test('describeCall untuk alat pengubah', () => {
        eq(describeCall('buat_berkas', '{"nama":"a.md"}'), 'Mengusulkan berkas baru a.md');
        eq(describeCall('ubah_berkas', '{"nama":"a.md"}'), 'Mengusulkan perubahan pada a.md');
    });

    section('Agent: persetujuan perubahan di sesi');

    const input = (over: Partial<ContextInput> = {}): Omit<ContextInput, 'recent'> => ({
        question: 'Geser revisi ke Desember', active: null, selection: '', files, mentions: [],
        options: { activeDocument: true, selection: true, project: true }, budget: 48_000, ...over,
    });
    const base = { onContext: () => {}, onText: () => {}, onReasoning: () => {} };
    const result = (over: Partial<ChatResult> = {}): ChatResult => ({ usage: { prompt: 10, cached: 0, completion: 2 }, cancelled: false, toolCalls: [], reasoning: '', ...over });
    const EDIT = JSON.stringify({ nama: 'rencana.md', teks_lama: '- Revisi: November', teks_baru: '- Revisi: Desember', alasan: 'permintaan pengguna' });

    // Provider yang mengusulkan satu perubahan, lalu menjawab; menyimpan hasil alat yang dilihatnya.
    const proposing = (calls: ChatRequest[], toolResults: string[], args = EDIT, name = 'ubah_berkas'): Provider => ({
        async chat(req) {
            calls.push(req);
            const last = req.messages[req.messages.length - 1];
            if (last.role === 'tool') toolResults.push(last.content);
            if (calls.length === 1) return result({ toolCalls: [{ id: 'p1', name, arguments: args }] });
            req.onText('Selesai.');
            return result();
        },
    });

    test('tanpa onProposal agent tidak diberi alat pengubah dan prompt tetap baca-saja', () => {
        const calls: ChatRequest[] = [];
        settle(new ChatSession().ask(input(), proposing(calls, []), 'm', base));
        const names = calls[0].tools!.map(t => t.name);
        ok(!names.includes('ubah_berkas') && !names.includes('buat_berkas'), names.join(','));
        contains(calls[0].messages[0].content as string, 'Kamu tidak dapat mengubah berkas');
        // Model tetap mencoba memanggilnya: ditolak sebagai alat tidak dikenal, tidak ada yang ditulis.
        const results: string[] = [];
        settle(new ChatSession().ask(input(), proposing([], results), 'm', base));
        contains(results[0], 'tidak dikenal');
    });

    test('disetujui: handler menerima selisih, hasil kembali ke model, isi baru terlihat di putaran berikutnya', () => {
        const calls: ChatRequest[] = [];
        const results: string[] = [];
        const seen: Change[] = [];
        const steps: ToolStep[] = [];
        const r = settle(new ChatSession().ask(input(), proposing(calls, results), 'm', {
            ...base,
            onTool: s => steps.push({ ...s }),
            onProposal: async change => { seen.push(change); return { applied: true }; },
        }));
        eq(seen.length, 1);
        eq(seen[0].after, RENCANA.replace('November', 'Desember'));
        contains(results[0], 'disetujui pengguna dan sudah diterapkan');
        eq(r.applied, 1);
        eq(r.toolCalls, 0);   // hitungan "penelusuran" tidak ikut
        eq(steps.map(s => s.summary), ['', 'diterapkan']);
        contains(steps[0].label, 'Ubah rencana.md');
        const names = calls[0].tools!.map(t => t.name);
        ok(names.includes('ubah_berkas') && names.includes('buat_berkas'), names.join(','));
        const system = calls[0].messages[0].content as string;
        contains(system, 'buat_berkas');
        ok(!system.includes('Kamu tidak dapat mengubah berkas'), 'aturan baca-saja masih ada');
    });

    test('ditolak atau gagal diterapkan: model diberi tahu dan tidak ada perubahan dihitung', () => {
        for (const [answer, expected, summary] of [
            [{ applied: false }, 'menolak', 'ditolak'],
            [{ applied: false, error: 'berkas berubah' }, 'gagal diterapkan: berkas berubah', 'gagal diterapkan'],
        ] as [ProposalResult, string, string][]) {
            const results: string[] = [];
            const steps: ToolStep[] = [];
            const r = settle(new ChatSession().ask(input(), proposing([], results), 'm', { ...base, onTool: s => steps.push({ ...s }), onProposal: async () => answer }));
            contains(results[0], expected);
            eq(r.applied, 0);
            eq(steps[steps.length - 1].summary, summary);
        }
    });

    test('usulan tidak valid tidak sampai ke handler; model mendapat alasannya', () => {
        const results: string[] = [];
        let asked = 0;
        const bad = JSON.stringify({ nama: 'rencana.md', teks_lama: 'tidak ada', teks_baru: 'x', alasan: 'x' });
        settle(new ChatSession().ask(input(), proposing([], results, bad), 'm', { ...base, onProposal: async () => { asked++; return { applied: true }; } }));
        eq(asked, 0);
        contains(results[0], 'tidak ditemukan');
    });

    test('buat_berkas lalu ubah_berkas pada berkas itu dalam satu giliran memakai isi yang baru', () => {
        const results: string[] = [];
        let round = 0;
        const provider: Provider = {
            async chat(req) {
                const last = req.messages[req.messages.length - 1];
                if (last.role === 'tool') results.push(last.content);
                round++;
                if (round === 1) return result({ toolCalls: [{ id: 'a', name: 'buat_berkas', arguments: JSON.stringify({ nama: 'baru.md', isi: '# Baru\n\nSatu.', alasan: 'x' }) }] });
                if (round === 2) return result({ toolCalls: [{ id: 'b', name: 'ubah_berkas', arguments: JSON.stringify({ nama: 'baru.md', teks_lama: 'Satu.', teks_baru: 'Dua.', alasan: 'x' }) }] });
                req.onText('ok');
                return result();
            },
        };
        const edits: Change[] = [];
        const r = settle(new ChatSession().ask(input(), provider, 'm', { ...base, onProposal: async c => { edits.push(c); return { applied: true }; } }));
        eq(r.applied, 2);
        eq(edits[1].before, '# Baru\n\nSatu.\n');
        eq(edits[1].after, '# Baru\n\nDua.\n');
    });

    test('opsi proyek dimatikan: tidak ada alat, walau handler ada', () => {
        const calls: ChatRequest[] = [];
        settle(new ChatSession().ask(input({ options: { activeDocument: true, selection: true, project: false } }), proposing(calls, []), 'm', { ...base, onProposal: async () => ({ applied: true }) }));
        eq(calls[0].tools, undefined);
    });

    test('instruksi: bagian usulan hanya ada bila diizinkan', () => {
        const on = buildContext({ ...input(), recent: [], canPropose: true }).system;
        const off = buildContext({ ...input(), recent: [] }).system;
        contains(on, 'ubah_berkas');
        ok(!off.includes('ubah_berkas'), 'instruksi usulan ada tanpa izin');
        eq(CHANGE_TOOLS.map(t => t.name), ['buat_berkas', 'ubah_berkas']);
    });
}
