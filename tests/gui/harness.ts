// Tes GUI: kartu kanban dikerjakan harness eksternal (pi tiruan berupa skrip shell, dijalankan sungguhan lewat
// Gio.Subprocess) di folder proyek terpisah. Tidak memanggil pi atau API sungguhan.

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { readTextFile } from '../../src/files.js';
import { parseBoard } from '../../src/markdown/kanban.js';
import { findEntry } from '../../src/ui/menu.js';
import { descendants, widgetPixbuf } from '../widgets.js';
import { section, test, eq, ok, contains, tmp, optVal } from '../framework.js';
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

// MODE dibaca tiap kali dijalankan: ok (cepat), lambat (menunggu berkas lepas), gagal, atau macet.
const fakePi = (dir: string) => `#!/bin/sh
mode=$(cat "${dir}/mode")
for a; do last="$a"; done
printf '%s' "$last" > "${dir}/prompt"
printf '%s\\n' "$PWD" >> "${dir}/cwd"
printf 'mulai %s\\n' "$4" >> "${dir}/urutan"
echo '{"type":"session","version":3,"id":"sesi-uji","cwd":"x"}'
echo '{"type":"turn_start"}'
echo '{"type":"tool_execution_start","toolCallId":"t1","toolName":"edit","args":{"path":"checkout.ts"}}'
case "$mode" in
  lambat) while [ ! -e "${dir}/lepas" ]; do sleep 0.05; done ;;
  macet) sleep 30 ;;
esac
echo '{"type":"tool_execution_end","toolCallId":"t1","toolName":"edit","result":{"content":[{"type":"text","text":"ok"}]},"isError":false}'
if [ "$mode" = gagal ]; then echo "No API key found for deepseek" >&2; exit 1; fi
echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Checkout QRIS ditambahkan di checkout.ts"}],"stopReason":"stop","usage":{"totalTokens":120,"cost":{"total":0.002}}}}'
echo '{"type":"agent_settled"}'
printf 'selesai %s\\n' "$4" >> "${dir}/urutan"
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
    w.harnessDialogs = { chooseFolder: title => { chosen.push(title); return pick; } };

    const waitFor = (cond: () => boolean, ms = 5000) => {
        for (let i = 0; i < ms / 10 && !cond(); i++) { pump(); GLib.usleep(10000); }
        pump();
        return cond();
    };
    const open = () => {
        GLib.file_set_contents(papan, PAPAN);
        for (const f of ['cwd', 'urutan', 'prompt', 'lepas']) GLib.unlink(GLib.build_filenamev([dir, f]));
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

    w.settings.projects = savedProjects;
    w.orchestrator.program = savedProgram;
    w.harnessDialogs = savedDialogs;
    c.buf.set_modified(false);
}
