// Tes GUI: kartu kanban dikerjakan harness eksternal (pi tiruan berupa skrip shell yang berbicara RPC, dijalankan
// sungguhan sebagai proses) di folder proyek terpisah. Tidak memanggil pi atau API sungguhan.

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { readTextFile } from '../../src/files.js';
import { parseBoard } from '../../src/markdown/kanban.js';
import { findEntry } from '../../src/ui/menu.js';
import { findDialog, harnessAskDialog } from '../../src/ui/dialogs.js';
import { descendants, widgetPixbuf } from '../widgets.js';
import { section, test, eq, ok, contains, tmp, optVal } from '../framework.js';
import type { HarnessAsk, HarnessReply } from '../../src/agent/harness.js';
import type { GuiContext } from './context.js';

const PAPAN = `---
kanban: true
proyek: toko
---

## Rencana

- [ ] Checkout pakai QRIS @pi #fitur
  Pakai SDK resmi.
- [ ] Tes keranjang
- [ ] Rapikan README @pi

## Dikerjakan

## Review

## Selesai
`;

// Pi tiruan yang berbicara RPC lewat stdin/stdout. MODE dibaca tiap kali dijalankan: ok (cepat), lambat
// (menunggu berkas lepas), gagal, macet, izin (dialog konfirmasi extension), atau tanya (pertanyaan di akhir giliran).
// Setelah selesai ia menunggu stdin ditutup, seperti pi sungguhan; baris yang masih datang dicatat di "sisa".
const fakePi = (dir: string) => `#!/bin/sh
mode=$(cat "${dir}/mode")
printf '%s\\n' "$*" >> "${dir}/args"
printf '%s\\n' "$PWD" >> "${dir}/cwd"
printf 'mulai %s\\n' "$4" >> "${dir}/urutan"
read -r cmd
echo '{"id":"nyerat-state","type":"response","command":"get_state","success":true,"data":{"sessionId":"sesi-uji"}}'
read -r cmd
printf '%s' "$cmd" > "${dir}/prompt"
echo '{"type":"response","command":"prompt","success":true,"data":{"disposition":"started"}}'
echo '{"type":"turn_start"}'
echo '{"type":"tool_execution_start","toolCallId":"t1","toolName":"edit","args":{"path":"checkout.ts"}}'
case "$mode" in
  lambat) while [ ! -e "${dir}/lepas" ]; do sleep 0.05; done ;;
  macet) sleep 30 ;;
  izin) echo '{"type":"extension_ui_request","id":"ui-1","method":"confirm","title":"Izinkan perintah bash?","message":"rm -rf build"}'
        read -r ans; printf '%s\\n' "$ans" >> "${dir}/jawaban" ;;
esac
echo '{"type":"tool_execution_end","toolCallId":"t1","toolName":"edit","result":{"content":[{"type":"text","text":"ok"}]},"isError":false}'
if [ "$mode" = gagal ]; then echo "No API key found for deepseek" >&2; exit 1; fi
if [ "$mode" = tanya ]; then
  printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Sudah saya cek.\\n\\nMau pakai SDK A atau B?"}],"stopReason":"stop"}}'
  echo '{"type":"agent_settled"}'
  read -r ans || { printf 'selesai %s\\n' "$4" >> "${dir}/urutan"; exit 0; }
  printf '%s\\n' "$ans" >> "${dir}/jawaban"
fi
echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Checkout QRIS ditambahkan di checkout.ts"}],"stopReason":"stop","usage":{"totalTokens":120,"cost":{"total":0.002}}}}'
echo '{"type":"agent_settled"}'
printf 'selesai %s\\n' "$4" >> "${dir}/urutan"
while read -r x; do printf '%s\\n' "$x" >> "${dir}/sisa"; done
`;

export function harnessTests(c: GuiContext): void {
    const { w, pump } = c;
    section('Harness eksternal (papan)');

    const kb = w.board;
    const dir = GLib.dir_make_tmp('nyerat-pi-XXXXXX');           // berkas kendali pi tiruan
    const project = GLib.dir_make_tmp('nyerat-toko-XXXXXX');     // "repo" proyek, di luar folder kerja
    const script = GLib.build_filenamev([dir, 'pi']);
    GLib.file_set_contents(script, fakePi(dir));
    GLib.spawn_command_line_sync(`chmod +x ${script}`);
    const mode = (m: string) => GLib.file_set_contents(GLib.build_filenamev([dir, 'mode']), m);
    const read = (name: string) => { try { return readTextFile(GLib.build_filenamev([dir, name])); } catch { return ''; } };
    const papan = GLib.build_filenamev([tmp, 'papan-harness.md']);
    const savedProjects = w.settings.projects;
    const savedProgram = w.orchestrator.program;
    const savedDialogs = w.harnessDialogs;
    w.orchestrator.program = () => script;
    const chosen: string[] = [];
    let pick: string | null = null;
    let answers: (HarnessReply | null)[] = [];
    let texts: (string | null)[] = [];
    const asked: HarnessAsk[] = [];
    w.harnessDialogs = {
        chooseFolder: title => { chosen.push(title); return pick; },
        answer: ask => { asked.push(ask); return answers.shift() ?? null; },
        text: () => texts.shift() ?? null,
    };

    const waitFor = (cond: () => boolean, ms = 5000) => {
        for (let i = 0; i < ms / 10 && !cond(); i++) { pump(); GLib.usleep(10000); }
        pump();
        return cond();
    };
    const open = () => {
        GLib.file_set_contents(papan, PAPAN);
        for (const f of ['cwd', 'urutan', 'prompt', 'lepas', 'args', 'jawaban', 'sisa']) GLib.unlink(GLib.build_filenamev([dir, f]));
        w.load(papan);
        for (let i = 0; i < 20; i++) { pump(); GLib.usleep(5000); }
    };
    const titles = (col: number) => kb.getBoard().columns[col].cards.map(card => card.text);
    const at = (text: string) => {
        const b = kb.getBoard();
        for (let column = 0; column < b.columns.length; column++) {
            const index = b.columns[column].cards.findIndex(card => card.text.startsWith(text));
            if (index >= 0) return { column, index };
        }
        throw new Error(`kartu "${text}" tidak ada`);
    };
    const menu = (text: string, label: string) => {
        const { column, index } = at(text);
        const entry = findEntry(kb.cardMenu(column, index), label);
        if (!entry) throw new Error(`menu "${label}" tidak ada untuk kartu "${text}"`);
        return entry;
    };
    const run = (text: string) => menu(text, 'Kerjakan dengan pi').run!();
    const badge = (text: string) => {
        kb.render();
        const { column, index } = at(text);
        const label = descendants(kb.columns[column].cards[index]).find(x => x.has_css_class('kanban-agent')) as Gtk.Label | undefined;
        return label?.label ?? '';
    };
    const runOf = (text: string) => w.orchestrator.queue.find(papan, kb.getBoard().columns[at(text).column].cards[at(text).index].text);

    test('kartu @pi dijalankan di folder proyek, dipindah ke Dikerjakan lalu Review dengan catatan hasil', () => {
        w.settings.projects = { toko: project };
        mode('lambat');
        open();
        contains(badge('Checkout'), 'pi');
        run('Checkout');
        ok(waitFor(() => read('urutan').includes('mulai')), 'pi tiruan tidak dijalankan');
        eq(titles(1), ['Checkout pakai QRIS @pi #fitur'], 'pindah ke Dikerjakan saat mulai');
        contains(badge('Checkout'), 'bekerja');
        eq(read('cwd').trim(), project, 'cwd = folder proyek');
        contains(read('prompt'), '# Checkout pakai QRIS');
        contains(read('prompt'), 'Pakai SDK resmi.');
        eq(findEntry(kb.cardMenu(1, 0), 'Kerjakan dengan pi')?.enabled, false, 'tidak bisa dijalankan dua kali');
        GLib.file_set_contents(GLib.build_filenamev([dir, 'lepas']), '');
        ok(waitFor(() => runOf('Checkout')?.status === 'done'), `status: ${runOf('Checkout')?.status}`);
        eq(titles(2), ['Checkout pakai QRIS @pi #fitur'], 'pindah ke Review saat selesai');
        const card = kb.getBoard().columns[2].cards[0];
        ok(card.notes[card.notes.length - 1].startsWith('↳ pi selesai'), `catatan: ${card.notes.join(' | ')}`);
        contains(card.notes[card.notes.length - 1], 'Checkout QRIS ditambahkan');
        contains(badge('Checkout'), 'selesai');
        eq(parseBoard(c.text()).columns[2].cards[0].text, card.text, 'perubahan papan masuk ke teks dokumen');
    });

    test('log pi memuat sesi, alat, dan biaya', () => {
        const r = runOf('Checkout')!;
        const viewer = w.showRunLog(r);
        pump();
        ok(viewer.window.title?.includes('Log pi'), `judul: ${viewer.window.title}`);
        const text = r.trace.text();
        contains(text, 'pi --session sesi-uji');
        contains(text, 'edit');
        contains(text, '$0.0020');
        const shot = optVal('shot-harness');
        if (shot) {
            for (let i = 0; i < 20; i++) { pump(); GLib.usleep(10000); }
            widgetPixbuf(viewer.window)?.savev(`${shot}-log.png`, 'png', [], []);
        }
        viewer.window.destroy();
        pump();
    });

    test('kartu kedua di proyek yang sama menunggu giliran', () => {
        mode('lambat');
        open();
        run('Checkout');
        run('Rapikan');
        ok(waitFor(() => read('urutan').includes('mulai')), 'pi pertama tidak berjalan');
        eq(runOf('Rapikan')?.status, 'queued');
        contains(badge('Rapikan'), 'antre');
        eq(titles(0).filter(t => t.startsWith('Rapikan')).length, 1, 'kartu yang antre tetap di Rencana');
        ok(menu('Rapikan', 'Batalkan Antrean'), 'menu batalkan antrean');
        const shot = optVal('shot-harness');
        if (shot) {
            for (let i = 0; i < 20; i++) { pump(); GLib.usleep(10000); }
            widgetPixbuf(w.win)?.savev(`${shot}-papan.png`, 'png', [], []);
            w.setOption('dark', true);
            for (let i = 0; i < 20; i++) { pump(); GLib.usleep(10000); }
            widgetPixbuf(w.win)?.savev(`${shot}-papan-gelap.png`, 'png', [], []);
            w.setOption('dark', false);
        }
        GLib.file_set_contents(GLib.build_filenamev([dir, 'lepas']), '');
        ok(waitFor(() => runOf('Rapikan')?.status === 'done'), `status kedua: ${runOf('Rapikan')?.status}`);
        eq(read('urutan').trim().split('\n').map(l => l.split(' ')[0]), ['mulai', 'selesai', 'mulai', 'selesai'], 'tidak berjalan bersamaan');
        eq(titles(2).map(t => t.split(' ')[0]), ['Checkout', 'Rapikan']);
    });

    test('hentikan dan gagal: kartu tetap di Dikerjakan, gagal diberi catatan', () => {
        mode('macet');
        open();
        run('Checkout');
        ok(waitFor(() => read('urutan').includes('mulai')), 'pi tidak berjalan');
        menu('Checkout', 'Hentikan pi').run!();
        ok(waitFor(() => runOf('Checkout')?.status === 'stopped'), `status: ${runOf('Checkout')?.status}`);
        eq(titles(1), ['Checkout pakai QRIS @pi #fitur']);
        eq(kb.getBoard().columns[1].cards[0].notes, ['Pakai SDK resmi.'], 'dihentikan tidak menambah catatan');

        mode('gagal');
        run('Rapikan');
        ok(waitFor(() => runOf('Rapikan')?.status === 'failed'), `status: ${runOf('Rapikan')?.status}`);
        const card = kb.getBoard().columns[1].cards.find(x => x.text.startsWith('Rapikan'))!;
        ok(card, 'kartu gagal tetap di Dikerjakan');
        contains(card.notes.join('\n'), '↳ pi gagal');
        contains(card.notes.join('\n'), 'No API key found');
        contains(badge('Rapikan'), 'gagal');
    });

    test('kartu tanpa proyek: folder ditanyakan, dipetakan, dan dicatat sebagai tag', () => {
        mode('ok');
        open();
        w.settings.projects = {};
        const other = GLib.dir_make_tmp('nyerat-lain-XXXXXX');
        // Papan tanpa frontmatter proyek.
        GLib.file_set_contents(papan, PAPAN.replace('proyek: toko\n', ''));
        w.load(papan);
        pump();
        pick = null;
        run('Tes keranjang');
        eq(chosen.pop(), 'Pilih folder proyek');
        eq(w.orchestrator.queue.runs.filter(r => r.board === papan && r.card.startsWith('Tes')).length, 0, 'batal memilih = tidak dijalankan');
        pick = other;
        run('Tes keranjang');
        const name = GLib.path_get_basename(other);
        eq(w.settings.projects[name], other, 'pemetaan disimpan');
        ok(waitFor(() => runOf('Tes keranjang')?.status === 'done'), `status: ${runOf('Tes keranjang')?.status}`);
        eq(titles(2), [`Tes keranjang @pi #proyek/${name}`], 'tag proyek dan penugasan ditambahkan');
        eq(read('cwd').trim().split('\n').pop(), other);
    });

    test('papan yang tidak terbuka tetap diperbarui di disk', () => {
        mode('lambat');
        w.settings.projects = { toko: project };
        open();
        run('Checkout');
        ok(waitFor(() => read('urutan').includes('mulai')), 'pi tidak berjalan');
        ok(w.save(), 'papan tidak tersimpan');
        // Ganti isi tab aktif dengan berkas lain (bukan menutup tab: c.ed milik tab pertama dipakai tes lain).
        const lain = GLib.build_filenamev([tmp, 'bukan-papan.md']);
        GLib.file_set_contents(lain, '# Lain\n');
        w.load(lain);
        pump();
        ok(w.file !== papan && !w.boardMode, 'papan masih terbuka');
        GLib.file_set_contents(GLib.build_filenamev([dir, 'lepas']), '');
        ok(waitFor(() => w.orchestrator.queue.runs.every(r => r.status !== 'working')), 'run tidak selesai');
        const disk = parseBoard(readTextFile(papan));
        eq(disk.columns[2].cards.map(x => x.text), ['Checkout pakai QRIS @pi #fitur'], 'Review di disk');
        ok(disk.columns[2].cards[0].notes.some(n => n.startsWith('↳ pi selesai')), 'catatan hasil di disk');
        w.load(papan);
        pump();
    });

    test('pi meminta izin: kartu menunggu, dijawab dari Nyerat, lalu pi melanjutkan', () => {
        mode('izin');
        w.settings.projects = { toko: project };
        open();
        run('Checkout');
        ok(waitFor(() => runOf('Checkout')?.status === 'waiting'), `status: ${runOf('Checkout')?.status}`);
        contains(badge('Checkout'), 'menunggu jawaban');
        eq(titles(1), ['Checkout pakai QRIS @pi #fitur'], 'kartu menunggu di Dikerjakan');
        eq(runOf('Checkout')?.ask?.kind, 'confirm');
        eq(findEntry(kb.cardMenu(1, 0), 'Kerjakan dengan pi')?.enabled, false, 'tidak bisa dijalankan dua kali selagi menunggu');
        const shot = optVal('shot-harness');
        if (shot) {
            for (let i = 0; i < 20; i++) { pump(); GLib.usleep(10000); }
            widgetPixbuf(w.win)?.savev(`${shot}-menunggu.png`, 'png', [], []);
            // Dialog jawaban asli (modal): ditangkap dari timer selagi tampil, lalu ditutup ("Nanti").
            const capture = (ask: HarnessAsk, name: string) => {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                    const dialog = findDialog('Jawab pi');
                    if (dialog) { widgetPixbuf(dialog)?.savev(`${shot}-${name}.png`, 'png', [], []); dialog.close(); }
                    return GLib.SOURCE_REMOVE;
                });
                harnessAskDialog(w.win, ask, 'pi');
            };
            capture(runOf('Checkout')!.ask!, 'jawab-izin');
            capture({ kind: 'question', id: null, title: 'pi bertanya', message: 'Sudah saya cek struktur proyek.\n\nCheckout QRIS bisa memakai SDK resmi (lebih lengkap) atau API langsung (lebih ringan). Mau pakai yang mana?', options: [], prefill: '', timeout: null }, 'jawab-tanya');
        }
        answers = [null];
        menu('Checkout', 'Jawab pi…').run!();
        eq(asked.pop()?.message, 'rm -rf build', 'dialog menampilkan perintahnya');
        eq(runOf('Checkout')?.status, 'waiting', '"Nanti" membiarkan pi tetap menunggu');
        answers = [{ confirmed: true }];
        menu('Checkout', 'Jawab pi…').run!();
        ok(waitFor(() => runOf('Checkout')?.status === 'done'), `status: ${runOf('Checkout')?.status}`);
        const reply = JSON.parse(read('jawaban').trim());
        eq(reply, { type: 'extension_ui_response', id: 'ui-1', confirmed: true });
        eq(titles(2), ['Checkout pakai QRIS @pi #fitur'], 'ke Review setelah selesai');
        const log = runOf('Checkout')!.trace.text();
        contains(log, 'pi menunggu: Izinkan perintah bash?');
        contains(log, 'Jawaban: diizinkan');
    });

    test('pi bertanya di akhir giliran: dijawab dan dilanjutkan, atau diakhiri tanpa membalas', () => {
        mode('tanya');
        open();
        run('Checkout');
        ok(waitFor(() => runOf('Checkout')?.status === 'waiting'), `status: ${runOf('Checkout')?.status}`);
        const ask = runOf('Checkout')!.ask!;
        eq([ask.kind, ask.message], ['question', 'Sudah saya cek.\n\nMau pakai SDK A atau B?']);
        answers = [{ value: 'Pakai SDK A' }];
        menu('Checkout', 'Jawab pi…').run!();
        ok(waitFor(() => runOf('Checkout')?.status === 'done'), `status: ${runOf('Checkout')?.status}`);
        const sent = JSON.parse(read('jawaban').trim());
        eq([sent.type, sent.message], ['prompt', 'Pakai SDK A']);
        contains(kb.getBoard().columns[2].cards[0].notes.join('\n'), 'Checkout QRIS ditambahkan');
        contains(runOf('Checkout')!.trace.text(), 'Jawaban Anda');

        open();
        run('Checkout');
        ok(waitFor(() => runOf('Checkout')?.status === 'waiting'), 'tidak menunggu');
        answers = [{ cancelled: true }];
        menu('Checkout', 'Jawab pi…').run!();
        ok(waitFor(() => runOf('Checkout')?.status === 'done'), `status: ${runOf('Checkout')?.status}`);
        eq(read('jawaban'), '', 'tidak ada jawaban terkirim');
        contains(kb.getBoard().columns[2].cards[0].notes.join('\n'), '↳ pi selesai');
    });

    test('arahan saat bekerja dan balasan setelah selesai melanjutkan sesi yang sama', () => {
        mode('lambat');
        open();
        run('Checkout');
        ok(waitFor(() => read('urutan').includes('mulai')), 'pi tidak berjalan');
        texts = ['Pakai SDK versi 2'];
        menu('Checkout', 'Beri Arahan pi…').run!();
        GLib.file_set_contents(GLib.build_filenamev([dir, 'lepas']), '');
        ok(waitFor(() => runOf('Checkout')?.status === 'done'), `status: ${runOf('Checkout')?.status}`);
        const steer = JSON.parse(read('sisa').trim().split('\n')[0]);
        eq([steer.type, steer.message], ['steer', 'Pakai SDK versi 2']);

        mode('ok');
        const first = runOf('Checkout')!;
        texts = ['Tambahkan juga tesnya'];
        menu('Checkout', 'Balas pi…').run!();
        ok(waitFor(() => runOf('Checkout') !== first && runOf('Checkout')?.status === 'done'), `status: ${runOf('Checkout')?.status}`);
        contains(read('args').trim().split('\n').pop()!, '--session sesi-uji');
        eq(JSON.parse(read('prompt')).message, 'Tambahkan juga tesnya');
        eq(runOf('Checkout')!.trace, first.trace, 'log yang sama dilanjutkan');
        contains(first.trace.text(), 'Balasan Anda');
        eq(titles(2), ['Checkout pakai QRIS @pi #fitur'], 'kembali ke Review');
        eq(kb.getBoard().columns[2].cards[0].notes.filter(n => n.startsWith('↳ pi selesai')).length, 2, 'satu catatan per run');
    });

    test('[[catatan]] di kartu: isi catatan masuk prompt pi, tautan bisa diklik tanpa membuka dialog sunting', () => {
        const folder = GLib.build_filenamev([tmp, 'papan-wiki']);
        GLib.mkdir_with_parents(GLib.build_filenamev([folder, 'spek']), 0o755);
        GLib.file_set_contents(GLib.build_filenamev([folder, 'spek', 'Spesifikasi.md']), '# Spesifikasi\n\n## Warna\n\nTombol bayar hijau #1a7f37.\n\n## Lain\n\nRahasia lain.\n');
        GLib.file_set_contents(GLib.build_filenamev([folder, 'Catatan Rapat.md']), 'Klien minta QRIS dinamis.\n');
        const board = GLib.build_filenamev([folder, 'papan.md']);
        GLib.file_set_contents(board, PAPAN.replace('- [ ] Checkout pakai QRIS @pi #fitur\n  Pakai SDK resmi.',
            '- [ ] Checkout pakai QRIS [[Spesifikasi#Warna]] @pi #fitur\n  Pakai SDK resmi, lihat [[catatan rapat]] dan [[Hilang]].'));
        for (const f of ['cwd', 'urutan', 'prompt', 'lepas', 'args', 'jawaban', 'sisa']) GLib.unlink(GLib.build_filenamev([dir, f]));
        mode('ok');
        ok(w.load(board), 'load papan');
        for (let i = 0; i < 20; i++) { pump(); GLib.usleep(5000); }

        // Tautan di judul berupa <a>, tautan di catatan menjadi baris tersendiri di bawah chip.
        kb.render();
        const widget = kb.columns[0].cards[at('Checkout').index];
        const text = descendants(widget).find(x => x.has_css_class('kanban-card-text')) as Gtk.Label;
        contains(text.get_label(), '<a href="nyerat-note:Spesifikasi%23Warna">');
        eq(descendants(widget).filter(x => x.has_css_class('kanban-note-link')).map(x => (x as Gtk.Label).get_text()), ['↗ catatan rapat', '↗ Hilang']);

        // --shot-kanban-wiki=<prefix>: kartu dengan tautan [[ ]] di tema terang dan gelap (<prefix>-terang.png, -gelap.png).
        const shot = optVal('shot-kanban-wiki');
        if (shot) {
            for (const dark of [false, true]) {
                w.setOption('dark', dark);
                for (let i = 0; i < 20; i++) { pump(); GLib.usleep(10000); }
                widgetPixbuf(w.win)?.savev(`${shot}-${dark ? 'gelap' : 'terang'}.png`, 'png', [], []);
            }
            w.setOption('dark', false);
            kb.render();
        }
        const edited: string[] = [];
        const savedEdit = kb.dialogs.editCard;
        kb.dialogs = { ...kb.dialogs, editCard: (_p, card) => { edited.push(card.text); return null; } };
        const { column, index } = at('Checkout');
        kb.onCardPress(column, index, widget, 5, 5);
        ok(text.emit('activate-link', 'nyerat-note:catatan%20rapat'), 'tautan tidak ditangani');
        kb.onCardRelease();
        kb.dialogs = { ...kb.dialogs, editCard: savedEdit };
        eq(edited, [], 'dialog sunting ikut terbuka');
        eq(w.file, GLib.build_filenamev([folder, 'Catatan Rapat.md']), 'catatan yang terbuka');
        ok(w.closeTab(), 'closeTab');
        eq(w.file, board, 'kembali ke papan');

        run('Checkout');
        const wikiRun = () => w.orchestrator.queue.find(board, kb.getBoard().columns[at('Checkout').column].cards[at('Checkout').index].text);
        ok(waitFor(() => wikiRun()?.status === 'done'), `status: ${wikiRun()?.status}`);
        const prompt = JSON.parse(read('prompt')).message as string;
        contains(prompt, '## Catatan terkait dari Nyerat');
        contains(prompt, '### [[Spesifikasi#Warna]] — spek/Spesifikasi.md');
        contains(prompt, 'Tombol bayar hijau #1a7f37.');
        ok(!prompt.includes('Rahasia lain.'), 'bagian lain ikut tersalin');
        contains(prompt, 'Klien minta QRIS dinamis.');
        contains(prompt, '### [[Hilang]]\n\n(tidak ditemukan di folder kerja Nyerat)');
        contains(wikiRun()!.trace.text(), 'Tombol bayar hijau');
    });

    w.settings.projects = savedProjects;
    w.orchestrator.program = savedProgram;
    w.harnessDialogs = savedDialogs;
    c.buf.set_modified(false);
}
