// Tes asisten: penyusunan konteks (agent/context.ts), pembacaan aliran SSE, markup jawaban, dan sesi percakapan.
// Tanpa GUI dan tanpa jaringan; model diganti penyedia palsu.

import { buildContext, buildMessages, estimateTokens, findMentions, headingsOf, matchMention, rankChunks, splitChunks, tokenize, type ContextInput, type SourceFile } from '../../src/agent/context.js';
import { httpErrorMessage, parseStreamLine } from '../../src/agent/sse.js';
import { ChatSession, MAX_ROUNDS, type ToolStep } from '../../src/agent/session.js';
import { describeCall, runTool } from '../../src/agent/tools.js';
import { toApiMessage } from '../../src/agent/deepseek.js';
import type { ChatMessage, ChatRequest, ChatResult, Provider } from '../../src/agent/provider.js';
import { chatMarkup } from '../../src/markdown/chatmarkup.js';
import GLib from 'gi://GLib';
import { systemKeyStore } from '../../src/agent/apikey.js';
import { section, test, eq, ok, contains, settle } from '../framework.js';

const BAB1 = `# Bab 1: Pelabuhan

Raka berusia tujuh belas tahun ketika ia pertama kali melihat kapal Camar Putih.

## Pertemuan

Di dermaga, Raka bertemu Laras. Laras membawa surat dari ayahnya.
`;

const BAB2 = `# Bab 2: Pelayaran

Kapal Camar Putih meninggalkan pelabuhan saat fajar. Nakhoda Hasan memimpin pelayaran.

## Badai

Badai menghantam pada malam ketiga. Laras menyembunyikan surat itu di balik jaketnya.
`;

const BAB3 = `# Bab 3: Pulau

Mereka menemukan pulau tanpa name. Tidak ada yang tahu siapa pemiliknya.
`;

const FILES: SourceFile[] = [{ name: 'chapter-1.md', text: BAB1 }, { name: 'chapter-3.md', text: BAB3 }];

const input = (over: Partial<ContextInput> = {}): ContextInput => ({
    question: 'Apa yang terjadi pada surat Laras?',
    recent: [],
    active: { name: 'chapter-2.md', text: BAB2, cursorLine: 6 },
    selection: '',
    files: FILES,
    mentions: [],
    options: { activeDocument: true, selection: true, project: true },
    budget: 48_000,
    ...over,
});

export function agentTests(): void {
    section('Asisten: memecah dan mencari naskah');

    test('headingsOf mengabaikan # di dalam blok kode', () => {
        eq(headingsOf('# A\n```\n# bukan\n```\n## B\n').map(h => h.text), ['A', 'B']);
    });

    test('splitChunks memotong per heading dengan jalur heading dan nomor baris', () => {
        const chunks = splitChunks('chapter-1.md', BAB1);
        eq(chunks.map(c => c.heading), ['Bab 1: Pelabuhan', 'Bab 1: Pelabuhan › Pertemuan']);
        eq(chunks.map(c => [c.start, c.end]), [[0, 3], [4, 7]]);
        contains(chunks[1].text, 'Laras membawa surat');
    });

    test('splitChunks memecah bagian panjang di batas paragraf dan tidak kehilangan baris', () => {
        const para = 'kalimat panjang '.repeat(40);   // ±640 karakter
        const text = `# Judul\n\n${[1, 2, 3, 4, 5].map(() => para).join('\n\n')}\n`;
        const chunks = splitChunks('x.md', text);
        ok(chunks.length > 1, 'tidak dipecah');
        ok(chunks.every(c => c.text.length < 3000), 'potongan terlalu besar');
        eq(chunks.map(c => c.text).join('\n').replace(/\s+/g, ' ').trim(), text.replace(/\s+/g, ' ').trim());
    });

    test('tokenize membuang kata umum dan mengupas akhiran', () => {
        eq(tokenize('Siapa tokohnya yang membawa surat?'), ['tokoh', 'membawa', 'surat']);
        eq(tokenize('Bab 12 dan 7'), ['12', '7']);   // angka tetap dihitung (tahun, nomor), kata umum tidak
    });

    test('rankChunks menaruh potongan paling relevan di atas dan membuang yang tidak cocok', () => {
        const chunks = [...splitChunks('chapter-1.md', BAB1), ...splitChunks('chapter-3.md', BAB3)];
        const ranked = rankChunks(chunks, new Map(tokenize('pulau tanpa name').map(t => [t, 1])));
        eq(ranked.length, 1);
        eq(ranked[0].chunk.file, 'chapter-3.md');
        eq(rankChunks(chunks, new Map([['zzz', 1]])).length, 0);
    });

    section('Asisten: membangun konteks');

    test('dokumen aktif utuh masuk ke bagian system, pertanyaan tidak', () => {
        const b = buildContext(input());
        contains(b.system, '<dokumen_aktif>\n');
        contains(b.system, 'Nakhoda Hasan');
        ok(!b.system.includes('Apa yang terjadi pada surat'), 'pertanyaan bocor ke system');
        ok(b.items.some(i => i.kind === 'active' && i.label.includes('utuh')), 'item dokumen aktif tidak ada');
    });

    test('system identik antar-pertanyaan (prefiks stabil untuk cache) selama naskah sama', () => {
        const a = buildContext(input({ question: 'Siapa Laras?' }));
        const b = buildContext(input({ question: 'Di mana pulau itu?' }));
        eq(a.system, b.system);
        ok(a.note !== b.note, 'konteks tambahan seharusnya mengikuti pertanyaan');
    });

    test('potongan relevan dari berkas lain masuk ke konteks tambahan, yang tak relevan tidak', () => {
        const b = buildContext(input({ question: 'Siapa yang membawa surat dari ayahnya?' }));
        contains(b.note, 'berkas="chapter-1.md"');
        contains(b.note, 'Laras membawa surat dari ayahnya');
        ok(!b.note.includes('pulau tanpa name'), 'potongan tak relevan ikut');
        ok(b.items.some(i => i.kind === 'excerpt'), 'item potongan tidak ada');
    });

    test('pertanyaan lanjutan memakai pertanyaan sebelumnya untuk mencari ("dan dia?")', () => {
        const b = buildContext(input({ question: 'Lalu kenapa dia kecewa?', recent: ['Ceritakan tentang pulau tanpa name'] }));
        contains(b.note, 'chapter-3.md');
    });

    test('pilihan dan posisi kursor ada di konteks tambahan', () => {
        const b = buildContext(input({ selection: 'Badai menghantam pada malam ketiga.' }));
        contains(b.note, '<pilihan>\nBadai menghantam pada malam ketiga.\n</pilihan>');
        contains(b.note, 'chapter-2.md, baris 7, bagian “Bab 2: Pelayaran › Badai”');
    });

    test('@mention melampirkan berkas utuh; yang tidak dikenal dilaporkan', () => {
        const b = buildContext(input({ question: 'Bandingkan dengan @chapter-3 dan @hilang', mentions: ['chapter-3', 'hilang'] }));
        contains(b.note, '<berkas name="chapter-3.md">');
        eq(b.unknownMentions, ['hilang']);
        ok(b.items.some(i => i.kind === 'mention'), 'item lampiran tidak ada');
    });

    test('baris naskah bernomor di dokumen aktif, potongan, dan lampiran (nomor asli, termasuk pada jendela kursor)', () => {
        const b = buildContext(input({ question: 'Siapa yang membawa surat dari ayahnya?', mentions: ['chapter-3'] }));
        contains(b.system, '7│ Badai menghantam pada malam ketiga.');
        contains(b.note, '7│ Di dermaga, Raka bertemu Laras.');       // potongan dari chapter-1: nomor baris di berkasnya
        contains(b.note, '3│ Mereka menemukan pulau tanpa name.');   // lampiran
        contains(b.system, 'jangan ikut mengutipnya');
        const filler = Array.from({ length: 4000 }, (_, i) => `Baris ke-${i} di bab 99.`).join('\n');
        const w = buildContext(input({ active: { name: 'aktif.md', text: `# Aktif\n\n${filler}\n`, cursorLine: 2502 }, budget: 12_000 }));
        contains(w.system, '2503│ Baris ke-2500 di bab 99.');
    });

    test('instruksi tidak menyuruh model meminta penulis melampirkan berkas (dengan maupun tanpa alat)', () => {
        const withTools = buildContext(input());
        const without = buildContext(input({ options: { activeDocument: true, selection: true, project: false } }));
        ok(!withTools.system.includes('@namaberkas') && !without.system.includes('@namaberkas'), 'instruksi masih menyarankan @namaberkas');
        contains(withTools.system, 'search_text');
        ok(!without.system.includes('search_text'), 'instruksi alat ada padahal alat tidak diberikan');
    });

    test('opsi dimatikan: tanpa dokumen aktif, pilihan, atau proyek', () => {
        const none = buildContext(input({ selection: 'x', options: { activeDocument: false, selection: false, project: false } }));
        ok(!none.system.includes('<dokumen_aktif>\n') && !none.system.includes('<peta_proyek>\n'), 'system masih berisi naskah');
        ok(!none.system.includes('Nakhoda Hasan'), 'isi naskah ikut terkirim');
        eq(none.note, '');
        eq(none.items, []);
    });

    test('peta proyek memuat daftar berkas dengan heading dan menandai berkas yang dibuka', () => {
        const b = buildContext(input());
        contains(b.system, '- chapter-1.md · ');
        contains(b.system, 'Bab 1: Pelabuhan | Pertemuan');
        contains(b.system, '- chapter-2.md (sedang dibuka)');
    });

    test('anggaran token tidak terlampaui pada buku besar; dokumen aktif dipotong di sekitar kursor', () => {
        const filler = (n: number) => Array.from({ length: 4000 }, (_, i) => `Baris ke-${i} di bab ${n} berisi kalimat biasa tentang pelayaran dan laut.`).join('\n');
        const big = Array.from({ length: 12 }, (_, i) => ({ name: `bab-${i}.md`, text: `# Bab ${i}\n\n${filler(i)}\n\nTokoh Wicaksono muncul di sini pada bab ${i}.\n` }));
        const active = { name: 'aktif.md', text: `# Aktif\n\n${filler(99)}\n`, cursorLine: 2500 };
        const budget = 12_000;
        const b = buildContext(input({ active, files: big, budget, question: 'Siapa Wicaksono?' }));
        ok(b.tokens <= budget, `konteks ${b.tokens} melebihi anggaran ${budget}`);
        ok(b.items.some(i => i.kind === 'active' && i.label.includes('baris')), 'dokumen aktif seharusnya dipotong');
        contains(b.system, 'Baris ke-2500 di bab 99');
        ok(!b.system.includes('Baris ke-10 di bab 99'), 'bagian jauh dari kursor ikut');
        contains(b.system, 'sebagian="ya"');
        contains(b.note, 'Wicaksono');
    });

    test('matchMention: name lengkap, tanpa ekstensi, atau akhiran path; findMentions membaca @ di teks', () => {
        const files = [{ name: 'bab/01-awal.md', text: '' }, { name: 'catatan.md', text: '' }];
        eq(matchMention('catatan', files)?.name, 'catatan.md');
        eq(matchMention('@Catatan.MD', files)?.name, 'catatan.md');
        eq(matchMention('01-awal', files)?.name, 'bab/01-awal.md');
        eq(matchMention('tidak-ada', files), null);
        eq(findMentions('Lihat @bab/01-awal.md, lalu (@catatan). surel a@b.c bukan'), ['bab/01-awal.md', 'catatan']);
    });

    test('buildMessages memangkas riwayat tertua berpasangan dan menempel konteks hanya di pesan terakhir', () => {
        const built = buildContext(input());
        const turn = (i: number) => [{ role: 'user' as const, content: `tanya ${i} ${'x'.repeat(300)}` }, { role: 'assistant' as const, content: `jawab ${i} ${'y'.repeat(300)}` }];
        const history = [0, 1, 2, 3].flatMap(turn);
        const msgs = buildMessages(built, history, 'pertanyaan baru', 400);
        eq(msgs[0].role, 'system');
        eq(msgs[1].role, 'user');                   // riwayat tetap diawali giliran pengguna
        ok(msgs.length < 1 + history.length + 1, 'riwayat tidak dipangkas');
        contains(msgs[msgs.length - 1].content, '<konteks_tambahan>');
        contains(msgs[msgs.length - 1].content, 'pertanyaan baru');
        ok(msgs.slice(1, -1).every(m => !m.content.includes('<konteks_tambahan>')), 'konteks bocor ke riwayat');
        eq(buildMessages(buildContext(input({ options: { activeDocument: false, selection: false, project: false } })), [], 'halo', 1000)[1].content, 'halo');
    });

    test('estimateTokens konservatif', () => {
        eq(estimateTokens('a'.repeat(300)), 100);
    });

    section('Asisten: aliran SSE dan galat');

    test('parseStreamLine membaca teks, penalaran, usage, potongan alat, dan [DONE]; mengabaikan sisanya', () => {
        const chunk = (over: object) => ({ kind: 'chunk', text: '', reasoning: '', tools: [], usage: null, ...over });
        eq(parseStreamLine('data: {"choices":[{"delta":{"content":"Halo"}}]}'), chunk({ text: 'Halo' }));
        eq(parseStreamLine('data: {"choices":[{"delta":{"reasoning_content":"hmm","content":null}}]}'), chunk({ reasoning: 'hmm' }));
        eq(parseStreamLine('data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_cache_hit_tokens":64}}'), chunk({ usage: { prompt: 100, cached: 64, completion: 20 } }));
        eq(parseStreamLine('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"search_text","arguments":"{\\"te"}}]}}]}'),
            chunk({ tools: [{ index: 0, id: 'c1', name: 'search_text', arguments: '{"te' }] }));
        eq(parseStreamLine('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ks\\":1}"}}]}}]}'),
            chunk({ tools: [{ index: 0, arguments: 'ks":1}' }] }));
        eq(parseStreamLine('data: [DONE]'), { kind: 'done' });
        eq(parseStreamLine(': keep-alive'), null);
        eq(parseStreamLine(''), null);
        eq(parseStreamLine('data: {rusak'), null);
        eq(parseStreamLine('data: {"choices":[{"delta":{"role":"assistant","content":""}}]}'), null);
    });

    test('httpErrorMessage menjelaskan status umum dan menyertakan pesan server', () => {
        contains(httpErrorMessage(401, '{"error":{"message":"Authentication Fails"}}'), 'API key ditolak');
        contains(httpErrorMessage(401, '{"error":{"message":"Authentication Fails"}}'), 'Authentication Fails');
        contains(httpErrorMessage(402, ''), 'Saldo');
        contains(httpErrorMessage(418, 'bukan json'), 'status 418');
    });

    section('Asisten: markup jawaban');

    const colors = { code: '#c00', codeBg: '#eee', link: '#06c', mark: '#ff0' };
    test('chatMarkup: heading, daftar, kutipan, blok kode, dan escape', () => {
        const out = chatMarkup('## Judul\n- satu **tebal**\n  - dua\n> kutipan\n```ts\nconst a = 1 < 2;\n```\n1. pertama', colors);
        contains(out, '<span font_weight="bold" size="larger">Judul</span>');
        contains(out, '•  satu <span font_weight="bold">tebal</span>');
        contains(out, '    •  dua');
        contains(out, '<span font_style="italic">kutipan</span>');
        contains(out, 'const a = 1 &lt; 2;');
        ok(!out.includes('```'), 'pagar kode ikut tampil');
        contains(out, '1. pertama');
    });

    test('chatMarkup tahan pada teks terpotong (blok kode belum ditutup, tanda tebal belum berpasangan)', () => {
        const out = chatMarkup('Teks **tebal belum\n```\nkode <b>', colors);
        contains(out, 'kode &lt;b&gt;');
        ok(!/<b>/.test(out), 'tag mentah lolos');
    });

    section('Asisten: sesi percakapan');

    const fake = (reply: string, seen: ChatRequest[] = []): Provider => ({
        async chat(req) {
            seen.push(req);
            for (const word of reply.split(' ')) req.onText(`${word} `);
            return { usage: { prompt: 10, cached: 0, completion: 3 }, cancelled: false, toolCalls: [], reasoning: '' };
        },
    });

    test('ask mengalirkan jawaban, menyimpan riwayat, dan pertanyaan berikut membawa riwayat tanpa konteks lama', () => {
        const session = new ChatSession();
        const seen: ChatRequest[] = [];
        const chunks: string[] = [];
        const { text, usage } = settle(session.ask({ ...input(), question: 'Siapa Laras?' }, fake('seorang gadis pembawa surat', seen), 'm',
            { onContext: () => {}, onText: d => chunks.push(d), onReasoning: () => {} }));
        eq(text.trim(), 'seorang gadis pembawa surat');
        eq(chunks.length, 4);
        eq(usage?.prompt, 10);
        eq(session.history.length, 2);
        settle(session.ask({ ...input(), question: 'Dan ayahnya?' }, fake('tidak disebut', seen), 'm', { onContext: () => {}, onText: () => {}, onReasoning: () => {} }));
        const second = seen[1].messages;
        eq(second.map(m => m.role), ['system', 'user', 'assistant', 'user']);
        eq(second[1].content, 'Siapa Laras?');                      // riwayat: pertanyaan polos
        ok(!second[1].content.includes('<konteks_tambahan>'), 'konteks lama ikut dikirim ulang');
    });

    test('galat penyedia tidak menambah riwayat', () => {
        const session = new ChatSession();
        const broken: Provider = { chat: () => Promise.reject(new Error('gagal')) };
        let failed = false;
        try {
            settle(session.ask({ ...input() }, broken, 'm', { onContext: () => {}, onText: () => {}, onReasoning: () => {} }));
        } catch (e) {
            failed = true;
        }
        ok(failed, 'galat tidak diteruskan');
        eq(session.history.length, 0);
    });
}

export function apiKeyTests(): void {
    section('Asisten: API key');
    test('variabel lingkungan DEEPSEEK_API_KEY didahulukan atas penyimpanan lain', () => {
        const before = GLib.getenv('DEEPSEEK_API_KEY');
        GLib.setenv('DEEPSEEK_API_KEY', '  sk-dari-env \n', true);
        try {
            eq(settle(systemKeyStore.get()), { key: 'sk-dari-env', source: 'env' });
        } finally {
            if (before === null) GLib.unsetenv('DEEPSEEK_API_KEY'); else GLib.setenv('DEEPSEEK_API_KEY', before, true);
        }
    });
}

export function toolTests(): void {
    const files: SourceFile[] = [
        { name: 'chapter-1.md', text: BAB1 },
        { name: 'chapter-2.md', text: BAB2 },
        { name: 'chapter-3.md', text: BAB3 },
        { name: 'catatan/tokoh.md', text: '# Tokoh\n\n- Laras: pembawa surat\n- Hasan: nakhoda\n' },
    ];

    section('Asisten: alat penelusuran');

    test('list_files menyebut semua berkas beserta heading', () => {
        const r = runTool('list_files', '', files);
        contains(r.content, '- chapter-1.md · ');
        contains(r.content, 'catatan/tokoh.md');
        contains(r.content, 'Bab 2: Pelayaran');
        eq(r.summary, '4 berkas');
    });

    test('search_text: kemunculan persis dengan name berkas dan nomor baris, tanpa membedakan huruf besar/kecil', () => {
        const r = runTool('search_text', '{"text":"laras"}', files);
        contains(r.content, 'chapter-1.md:7: Di dermaga, Raka bertemu Laras.');
        contains(r.content, 'chapter-2.md:7: Badai menghantam');
        contains(r.content, 'catatan/tokoh.md:3: - Laras: pembawa surat');
        eq(r.summary, '3 baris');
        const only = runTool('search_text', '{"text":"Laras","file":"chapter-2"}', files);
        ok(!only.content.includes('chapter-1.md'), 'filter berkas diabaikan');
        contains(runTool('search_text', '{"text":"Zebua"}', files).content, 'tidak ditemukan');
    });

    test('search_text membatasi jumlah baris dan melaporkan sisanya', () => {
        const many = [{ name: 'x.md', text: Array.from({ length: 100 }, (_, i) => `Raka ke-${i}`).join('\n') }];
        const r = runTool('search_text', '{"text":"raka"}', many);
        contains(r.content, '100 baris memuat');
        contains(r.content, '60 kemunculan lagi tidak ditampilkan');
        eq(r.content.split('\n').filter(l => l.startsWith('x.md:')).length, 40);
    });

    test('search_documents mengembalikan potongan paling relevan beserta lokasinya', () => {
        const r = runTool('search_documents', '{"query":"pulau tanpa name"}', files);
        contains(r.content, '[chapter-3.md › Bab 3: Pulau · baris 1–');
        contains(r.content, 'pulau tanpa name');
        eq(r.summary, '1 potongan');
        contains(runTool('search_documents', '{"query":"zzz qqq"}', files).content, 'Tidak ada bagian naskah yang cocok');
    });

    test('read_file: bernomor baris, bisa per rentang, tahu total baris', () => {
        const all = runTool('read_file', '{"name":"chapter-3"}', files);
        contains(all.content, '[chapter-3.md, baris 1–');
        contains(all.content, '1│ # Bab 3: Pulau');
        const part = runTool('read_file', '{"name":"chapter-1.md","from_line":5,"to_line":6}', files);
        contains(part.content, '[chapter-1.md, baris 5–6 dari ');
        contains(part.content, '5│ ## Pertemuan');
        ok(!part.content.includes('1│'), 'baris di luar rentang ikut');
        eq(part.summary, 'baris 5–6');
    });

    test('read_file memotong berkas panjang dan menunjuk lanjutannya', () => {
        const long = [{ name: 'panjang.md', text: Array.from({ length: 5000 }, (_, i) => `Baris isi nomor ${i + 1} dengan kalimat yang cukup panjang.`).join('\n') }];
        const r = runTool('read_file', '{"name":"panjang.md"}', long);
        ok(estimateTokens(r.content) < 6500, 'hasil melewati batas');
        const next = /from_line=(\d+)/.exec(r.content);
        ok(next, 'tidak ada petunjuk lanjutan');
        contains(runTool('read_file', `{"name":"panjang.md","from_line":${next[1]}}`, long).content, `${next[1]}│ Baris isi`);
    });

    test('galat dikembalikan sebagai teks yang bisa dipahami model, tidak melempar', () => {
        contains(runTool('read_file', '{"name":"tokoh"}', files).content, '');   // "tokoh" cocok dengan catatan/tokoh.md lewat akhiran path
        contains(runTool('read_file', '{"name":"tokoh"}', files).content, 'catatan/tokoh.md');
        contains(runTool('read_file', '{"name":"chapter-9"}', files).content, 'tidak ditemukan');
        contains(runTool('read_file', '{}', files).content, 'wajib');
        contains(runTool('search_text', '{rusak', files).content, 'bukan JSON');
        contains(runTool('delete_file', '{}', files).content, 'tidak dikenal');
        contains(runTool('list_files', '', []).content, 'Belum ada berkas');
    });

    test('describeCall menyusun frasa antarmuka', () => {
        eq(describeCall('search_text', '{"text":"Hasan","file":"chapter-2.md"}'), 'Mencari teks “Hasan” di chapter-2.md');
        eq(describeCall('read_file', '{"name":"chapter-1.md","from_line":10}'), 'Membaca chapter-1.md (dari baris 10)');
        eq(describeCall('search_documents', '{"query":"surat"}'), 'Mencari “surat”');
        eq(describeCall('list_files', ''), 'Melihat daftar berkas');
        eq(describeCall('search_text', '{rusak'), 'Mencari teks “”');
    });

    section('Asisten: loop agen');

    const turn = (over: Partial<ContextInput> = {}) => ({ ...input(over), question: 'Siapa yang membawa surat?' });
    const nohandlers = { onContext: () => {}, onText: () => {}, onReasoning: () => {} };
    const result = (over: Partial<ChatResult> = {}): ChatResult => ({ usage: { prompt: 100, cached: 40, completion: 10 }, cancelled: false, toolCalls: [], reasoning: '', ...over });

    test('model meminta alat, hasilnya dikirim balik, lalu model menjawab; riwayat hanya berisi tanya-jawab', () => {
        const calls: ChatRequest[] = [];
        const snapshots: ChatMessage[][] = [];
        const provider: Provider = {
            async chat(req) {
                calls.push(req);
                snapshots.push([...req.messages]);
                if (calls.length === 1) {
                    req.onText('Saya cek dulu.');
                    return result({ toolCalls: [{ id: 'c1', name: 'search_text', arguments: '{"text":"surat"}' }], reasoning: 'perlu mencari' });
                }
                req.onText('Laras.');
                return result();
            },
        };
        const session = new ChatSession();
        session.thinking = true;
        const steps: ToolStep[] = [];
        const streamed: string[] = [];
        const r = settle(session.ask(turn(), provider, 'm', { ...nohandlers, onText: d => streamed.push(d), onTool: s => steps.push({ ...s }) }));
        eq(calls.length, 2);
        ok(calls[0].tools && calls[0].tools.some(t => t.name === 'read_file'), 'alat tidak diberikan');
        eq(calls[0].thinking, true);
        const second = snapshots[1];
        const assistant = second[second.length - 2];
        const tool = second[second.length - 1];
        eq(assistant.role, 'assistant');
        eq((assistant as { toolCalls: unknown[] }).toolCalls.length, 1);
        eq((assistant as { reasoning?: string }).reasoning, 'perlu mencari');   // penalaran dikembalikan bersama panggilan alat
        eq(tool.role, 'tool');
        eq((tool as { toolCallId: string }).toolCallId, 'c1');
        contains(tool.content, 'chapter-1.md:7');
        eq(steps.map(s => [s.id, s.summary === '' ? 'mulai' : 'selesai']), [['c1', 'mulai'], ['c1', 'selesai']]);
        eq(steps[0].label, 'Mencari teks “surat”');
        eq(streamed.join(''), 'Saya cek dulu.\n\nLaras.');
        eq(r.text, 'Saya cek dulu.\n\nLaras.');
        eq(r.toolCalls, 1);
        eq(r.usage, { prompt: 200, cached: 80, completion: 20 });   // dijumlahkan dari kedua putaran
        eq(session.history.map(t => t.role), ['user', 'assistant']);
        eq(session.history[1].content, 'Saya cek dulu.\n\nLaras.');
    });

    test('dokumen aktif ikut bisa ditelusuri dengan isi buffer, bukan versi disk', () => {
        let seen = '';
        const provider: Provider = {
            async chat(req) {
                if (req.tools) return result({ toolCalls: [{ id: 'c', name: 'read_file', arguments: '{"name":"chapter-2.md"}' }] });
                seen = req.messages[req.messages.length - 1].content;
                return result();
            },
        };
        settle(new ChatSession().ask(turn({ active: { name: 'chapter-2.md', text: '# Bab 2\n\nVersi baru yang belum disimpan.\n', cursorLine: 0 } }), provider, 'm', nohandlers));
        contains(seen, 'Versi baru yang belum disimpan.');
    });

    test('tanpa izin berkas lain tidak ada alat yang diberikan', () => {
        const seen: (ChatRequest['tools'])[] = [];
        const provider: Provider = { async chat(req) { seen.push(req.tools); req.onText('ok'); return result(); } };
        settle(new ChatSession().ask(turn({ options: { activeDocument: true, selection: true, project: false } }), provider, 'm', nohandlers));
        eq(seen, [undefined]);
    });

    test('putaran dibatasi MAX_ROUNDS dan putaran terakhir tanpa alat sehingga selalu berakhir dengan jawaban', () => {
        let rounds = 0, lastHadTools = true;
        const provider: Provider = {
            async chat(req) {
                rounds++;
                lastHadTools = !!req.tools;
                if (req.tools) return result({ toolCalls: [{ id: `c${rounds}`, name: 'list_files', arguments: '' }] });
                req.onText('Cukup.');
                return result();
            },
        };
        const r = settle(new ChatSession().ask(turn(), provider, 'm', nohandlers));
        eq(rounds, MAX_ROUNDS);
        ok(!lastHadTools, 'putaran terakhir masih diberi alat');
        eq(r.text, 'Cukup.');
        eq(r.toolCalls, MAX_ROUNDS - 1);
    });

    test('anggaran bacaan per pertanyaan: hasil alat yang melewatinya diganti pesan "anggaran habis"', () => {
        const big = { name: 'besar.md', text: Array.from({ length: 800 }, (_, i) => `Isi baris ${i} yang cukup panjang untuk memakan token.`).join('\n') };
        const outcomes: string[] = [];
        let n = 0;
        const provider: Provider = {
            async chat(req) {
                const last = req.messages[req.messages.length - 1];
                if (last.role === 'tool') outcomes.push(last.content);
                if (++n <= 3) return result({ toolCalls: [{ id: `c${n}`, name: 'read_file', arguments: '{"name":"besar.md"}' }] });
                req.onText('selesai');
                return result();
            },
        };
        settle(new ChatSession().ask(turn({ files: [big], budget: 9000 }), provider, 'm', nohandlers));
        ok(outcomes.length >= 2, 'alat tidak dipanggil');
        contains(outcomes[0], 'baris 0 yang');
        contains(outcomes[outcomes.length - 1], 'Anggaran bacaan');
    });

    test('dibatalkan di tengah: potongan teks tetap tersimpan dan loop berhenti', () => {
        let calls = 0;
        const provider: Provider = { async chat(req) { calls++; req.onText('Separuh'); return result({ cancelled: true }); } };
        const session = new ChatSession();
        const r = settle(session.ask(turn(), provider, 'm', nohandlers));
        eq(calls, 1);
        ok(r.cancelled, 'seharusnya cancelled');
        eq(session.history.length, 2);
    });

    test('toApiMessage: bentuk pesan di API (alat dan penalaran)', () => {
        eq(toApiMessage({ role: 'tool', toolCallId: 'c1', content: 'hasil' }), { role: 'tool', tool_call_id: 'c1', content: 'hasil' });
        eq(toApiMessage({ role: 'assistant', content: '', reasoning: 'mikir', toolCalls: [{ id: 'c1', name: 'search_text', arguments: '{}' }] }),
            { role: 'assistant', content: '', reasoning_content: 'mikir', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_text', arguments: '{}' } }] });
        eq(toApiMessage({ role: 'assistant', content: 'halo' }), { role: 'assistant', content: 'halo' });
        eq(toApiMessage({ role: 'user', content: 'tanya' }), { role: 'user', content: 'tanya' });
    });
}
