// Tes langsung ke API DeepSeek sungguhan (butuh internet dan key; berbayar tetapi sangat kecil). TIDAK ikut npm test.
//
//   npm run test:live                  key dari .env (DEEPSEEK_API_KEY), tanpa mode berpikir
//   npm run test:live -- --thinking    dengan mode berpikir
//   npm run test:live -- --model=deepseek-v4-pro
//
// Memakai naskah tests/samples/buku-contoh (sengaja berisi kontradiksi: usia Raka 17 vs 25, nama Hasan vs Hasyim,
// kapal putih vs hitam) dan menjalankan ChatSession + DeepSeek + alat penelusuran yang sama dengan aplikasi.
// Key tidak pernah dicetak.

import { liveAgentic } from './live-agentic.js';
import GLib from 'gi://GLib';
import System from 'system';
import { systemKeyStore } from '../src/agent/apikey.js';
import { DEEPSEEK_MODELS, DeepSeek } from '../src/agent/deepseek.js';
import { DEFAULT_BUDGET } from '../src/agent/context.js';
import { readProject } from '../src/agent/project.js';
import { ChatSession } from '../src/agent/session.js';
import { DIM, GREEN, RED, RESET, ROOT, optVal, opt, setRoot } from './framework.js';

setRoot(import.meta.url);

const errorMessage = (e: unknown): string => e instanceof Error ? e.message : String(e);

interface Scenario {
    name: string;
    question: string;
    minTools: number;
    mustMention: RegExp[];
    budget?: number;   // anggaran konteks awal; sangat kecil = model terpaksa menelusuri dengan alat
    cite?: RegExp;   // nomor baris yang dikutip (berkas.md:N) harus menunjuk baris yang memuat pola ini
}

const SCENARIOS: Scenario[] = [
    { name: 'ringkas dokumen terbuka (tanpa alat)', question: 'Ringkas dokumen ini dalam tiga poin.', minTools: 0, mustMention: [/badai/i] },
    { name: 'tokoh di seluruh buku', question: 'Siapa Hasan dan apa perannya di seluruh buku ini? Sebutkan berkas dan nomor barisnya.', minTools: 0, mustMention: [/nakhoda/i], cite: /hasan|hasyim|nakhoda/i },
    { name: 'kontradiksi (konteks awal cukup)', question: 'Adakah kontradiksi tentang usia Raka atau tentang kapal di buku ini? Sebutkan berkas dan barisnya.', minTools: 0, mustMention: [/17|tujuh belas/i, /25|dua puluh lima/i], cite: /raka|kapal|lambung|layar|hasan|hasyim|nakhoda|camar/i },
    // Anggaran 900 token hanya cukup untuk instruksi: tidak ada naskah di konteks awal, jadi jawaban hanya bisa datang dari alat.
    { name: 'kontradiksi tanpa konteks awal (wajib alat)', question: 'Adakah kontradiksi tentang usia Raka atau tentang kapal di buku ini? Sebutkan berkas dan barisnya.', minTools: 1, budget: 900,
        mustMention: [/17|tujuh belas/i, /25|dua puluh lima/i], cite: /raka|kapal|lambung|layar|hasan|hasyim|nakhoda|camar/i },
];

async function main(): Promise<boolean> {
    const found = await systemKeyStore.get();
    if (!found?.key) {
        print(`${RED}Tidak ada API key. Isi DEEPSEEK_API_KEY di .env (lihat .env.example), lalu jalankan npm run test:live.${RESET}`);
        return false;
    }

    const root = GLib.build_filenamev([ROOT, 'tests', 'samples', 'buku-contoh']);
    const book = readProject(root, null);
    if (!book.length) {
        print(`${RED}Naskah contoh tidak ditemukan di ${root}${RESET}`);
        return false;
    }
    const activeName = 'bab-2.md';
    const activeText = book.find(f => f.name === activeName)!.text;
    const files = book.filter(f => f.name !== activeName);

    const model = optVal('model') ?? DEEPSEEK_MODELS[0];
    const thinking = opt('thinking');
    const provider = new DeepSeek(found.key);
    print(`${DIM}Model ${model}, berpikir ${thinking ? 'aktif' : 'mati'}, key dari ${found.source}, ${book.length} berkas${RESET}`);

    let failures = 0;
    for (const sc of SCENARIOS) {
        print(`\n▶ ${sc.name}\n  Q: ${sc.question}`);
        const session = new ChatSession();
        session.thinking = thinking;
        const started = GLib.get_monotonic_time();
        try {
            const r = await session.ask({
                question: sc.question, active: { name: activeName, text: activeText, cursorLine: 4 }, selection: '', files, mentions: [],
                options: { activeDocument: true, selection: true, project: true }, budget: sc.budget ?? DEFAULT_BUDGET,
            }, provider, model, {
                onContext: b => print(`  ${DIM}konteks ≈${b.tokens} token${RESET}`),
                onText: () => {},
                onReasoning: () => {},
                onTool: s => { if (s.summary) print(`  ${DIM}• ${s.label} → ${s.summary}${RESET}`); },
            });
            const secs = ((GLib.get_monotonic_time() - started) / 1e6).toFixed(1);
            print(`  A: ${r.text.trim().split('\n').join('\n     ')}`);
            print(`  ${DIM}${secs} dtk · ${r.toolCalls} penelusuran · ${r.usage ? `${r.usage.prompt} masuk (${r.usage.cached} cache) / ${r.usage.completion} keluar` : 'usage tidak ada'}${RESET}`);
            const problems: string[] = [];
            if (!r.text.trim()) problems.push('jawaban kosong');
            if (r.toolCalls < sc.minTools) problems.push(`alat dipanggil ${r.toolCalls}x, harapan ≥ ${sc.minTools}`);
            for (const re of sc.mustMention) if (!re.test(r.text)) problems.push(`jawaban tidak menyebut ${re}`);
            if (sc.cite) {
                // Kutipan lokasi seperti `bab-2.md:7` harus menunjuk baris yang benar-benar ada dan relevan (anti nomor karangan).
                const cites = [...r.text.matchAll(/(bab-\d\.md)[:` ]*(?:baris\s*)?:?(\d+)/g)];
                for (const [, name, n] of cites) {
                    const line = book.find(f => f.name === name)?.text.split('\n')[Number(n) - 1] ?? '';
                    if (!sc.cite.test(line)) problems.push(`kutipan ${name}:${n} menunjuk baris yang salah (“${line.slice(0, 40)}”)`);
                }
                if (!cites.length) problems.push('tidak ada kutipan nomor baris');
            }
            if (problems.length) { failures++; print(`  ${RED}✗ ${problems.join('; ')}${RESET}`); }
            else print(`  ${GREEN}✓ lulus${RESET}`);
        } catch (e) {
            failures++;
            print(`  ${RED}✗ galat: ${errorMessage(e)}${RESET}`);
        }
    }
    print(`\n${failures ? RED : GREEN}${SCENARIOS.length - failures}/${SCENARIOS.length} skenario lulus${RESET}`);
    if (opt('agentic')) failures += await liveAgentic(provider, model, thinking);
    return failures === 0;
}

const loop = new GLib.MainLoop(null, false);
let ok = false;
main().then(r => { ok = r; }, e => { print(`${RED}${errorMessage(e)}${RESET}`); }).finally(() => loop.quit());
loop.run();
System.exit(ok ? 0 : 1);
