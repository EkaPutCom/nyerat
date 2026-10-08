// Tes GUI: jurnal harian (buka/buat, catat cepat, aktivitas dari papan, agent, harness, dan git, baris di Beranda,
// ringkasan lewat Asisten) di jendela tersendiri dengan folder kerja sementara.

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import { section, test, eq, ok, tmp, optVal, settle as settlePromise } from '../framework.js';
import { readTextFile } from '../../src/files.js';
import { localDate } from '../../src/markdown/home.js';
import { clock } from '../../src/markdown/journal.js';
import { moveCard } from '../../src/markdown/kanban.js';
import { readActivity } from '../../src/activity.js';
import { AppSettings } from '../../src/settings.js';
import { MainWindow } from '../../src/window.js';
import { registerActions } from '../../src/actions.js';
import type { ChatRequest, Provider } from '../../src/agent/provider.js';
import type { KeyStore } from '../../src/agent/apikey.js';
import type { HarnessResult } from '../../src/agent/harness.js';
import { promptDialog } from '../../src/ui/dialogs.js';
import { descendants, widgetPixbuf } from '../widgets.js';
import type { GuiContext } from './context.js';

export function journalTests(c: GuiContext): void {
    const { w, pump } = c;

    section('Jurnal');
    const ws = GLib.build_filenamev([tmp, 'jurnal-kerja']);
    GLib.mkdir_with_parents(ws, 0o755);
    const path = (name: string) => GLib.build_filenamev([ws, ...name.split('/')]);
    const put = (name: string, text: string) => { GLib.file_set_contents(path(name), text); return path(name); };
    const today = localDate(new Date());
    const jurnal = path(`jurnal/${today}.md`);
    const PAPAN = '---\nkanban: true\n---\n\n## Rencana\n\n- [ ] Materi rilis\n- [ ] Riset harga\n\n## Dikerjakan\n\n## Selesai\n';
    const papan = put('tugas.md', PAPAN);
    put('rencana.md', '# Rencana\n\nRilis 15 November.\n');

    // Repo git dengan satu commit hari ini, supaya bagian Aktivitas juga memuat commit.
    const git = (...args: string[]) => {
        const [okRun, , err, status] = GLib.spawn_sync(ws, ['git', '-c', 'user.name=Uji', '-c', 'user.email=uji@contoh.id', ...args], null, GLib.SpawnFlags.SEARCH_PATH, null);
        if (!okRun || status !== 0) throw new Error(`git ${args.join(' ')} gagal: ${new TextDecoder().decode(err ?? new Uint8Array())}`);
    };
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'Siapkan papan rilis');

    const settle = () => { for (let i = 0; i < 30; i++) { pump(); GLib.usleep(8000); } };
    const rowTitles = (win: MainWindow) => descendants(win.home.widget).filter((x): x is Adw.ActionRow => x instanceof Adw.ActionRow).map(r => [r.title, r.subtitle]);
    const open = (extra: Partial<AppSettings> = {}) => {
        const s = AppSettings.inMemory({ welcomed: true, dark: false, autosave: false, folder: ws, sidebar: false, chat: false, ...extra });
        const win = new MainWindow(c.app, s, null);
        settle();
        return { win, s };
    };
    const close = (win: MainWindow) => {
        for (let i = 0; i < 10; i++) win.editor.buffer.set_modified(false);
        win.win.destroy();
        settle();
        registerActions(c.app, w);
    };

    test('tanpa folder kerja, jurnal tidak dibuka dan pengguna diberi tahu', () => {
        const { win } = open({ folder: null });
        eq(win.openJournal(), null);
        ok(win.lastToast.includes('folder kerja'), `toast: ${win.lastToast}`);
        let asked = false;
        win.journalDialogs = { capture: () => { asked = true; return 'x'; } };
        win.captureJournal();
        ok(!asked, 'dialog catat cepat muncul tanpa folder kerja');
        eq(win.homeData().journal, null, 'baris Jurnal di Beranda tanpa folder kerja');
        close(win);
    });

    test('Ctrl+Shift+J tanpa jurnal terbuka: catatan berstempel jam ditulis ke berkas baru dari template', () => {
        const { win } = open();
        const now = new Date();
        win.journalDialogs = { capture: () => 'Buka berkas jadi lebih cepat' };
        win.captureJournal(); settle();
        const text = readTextFile(jurnal);
        ok(text.startsWith('# ') && text.includes('## Fokus hari ini') && text.includes('## Ringkasan'), `template: ${text}`);
        ok(new RegExp(`## Catatan\\n\\n- \\d\\d:\\d\\d Buka berkas jadi lebih cepat\\n\\n## Aktivitas`).test(text), `catatan: ${text}`);
        ok(text.includes(`- ${clock(now)} `) || text.includes(`- ${clock(new Date())} `), 'jam catatan');
        ok(win.homeMode, 'catat cepat berpindah dari Beranda');
        win.journalDialogs = { capture: () => null };
        win.captureJournal(); settle();
        eq(readTextFile(jurnal), text, 'dialog yang dibatalkan mengubah jurnal');
        close(win);
    });

    test('aktivitas papan dan agent tercatat ke log harian', () => {
        const { win } = open();
        win.openFile(papan); settle();
        ok(win.boardMode, 'papan tidak tampil sebagai papan');
        win.board.commit(moveCard(win.board.getBoard(), { column: 0, index: 0 }, { column: 1, index: 0 })); settle();
        const error = win.chat.host.applyChange!({ kind: 'edit', file: 'rencana.md', before: '# Rencana\n\nRilis 15 November.\n', after: '# Rencana\n\nRilis 22 November.\n', reason: 'uji' });
        eq(error, null, 'perubahan agent');
        const texts = readActivity(ws, today).map(a => a.text);
        eq(texts, ['Kartu “Materi rilis” → Dikerjakan · [[tugas]]', 'Agent mengubah [[rencana]]']);
        win.closeTab(); settle();   // papan belum disimpan: buang
        close(win);
        GLib.file_set_contents(papan, PAPAN);
    });

    test('suntingan teks papan di mode teks tidak dicatat sebagai aktivitas', () => {
        const { win } = open();
        const before = readActivity(ws, today).length;
        win.openFile(papan); settle();
        win.toggleBoardView(false); settle();
        win.editor.replaceText(PAPAN.replace('- [ ] Riset harga', '- [x] Riset harga'));
        win.toggleBoardView(true); settle();
        eq(readActivity(ws, today).length, before, 'suntingan teks papan tercatat sebagai aktivitas');
        win.closeTab(); settle();
        close(win);
    });

    test('hasil harness yang selesai tercatat sekali', () => {
        const { win } = open();
        const before = readActivity(ws, today).length;
        const run = win.orchestrator.queue.add({ board: papan, card: 'Fix checkout @pi', title: 'Fix checkout', agent: 'pi', project: 'toko', folder: '/tmp/toko', prompt: '', session: null });
        win.orchestrator.queue.end(run, 'done');
        const result: HarnessResult = { ok: true, summary: 'Beres', error: null, cost: 0, tokens: 0, sessionId: null };
        run.result = result;
        const host = (win.orchestrator as unknown as { host: { changed: (r: typeof run, m: string | null) => void } }).host;
        host.changed(run, null);
        host.changed(run, null);
        const texts = readActivity(ws, today).map(a => a.text).slice(before);
        eq(texts, ['pi selesai “Fix checkout” di proyek toko']);
        close(win);
    });

    test('membuka jurnal menggabungkan log dan commit hari ini ke Aktivitas, tanpa menggandakan', () => {
        const { win } = open();
        const filling = win.openJournal();
        ok(filling, 'jurnal tidak terbuka');
        settlePromise(filling!);
        eq(win.file, jurnal, 'tab jurnal');
        const text = win.editor.getText();
        const activity = text.slice(text.indexOf('## Aktivitas'), text.indexOf('## Ringkasan'));
        for (const line of ['Kartu “Materi rilis” → Dikerjakan · [[tugas]]', 'Agent mengubah [[rencana]]', 'pi selesai “Fix checkout”', 'Siapkan papan rilis'])
            ok(activity.includes(line), `aktivitas tanpa "${line}":\n${activity}`);
        ok(/- \d\d:\d\d Commit `[0-9a-f]{7,}` Siapkan papan rilis/.test(activity), 'baris commit');
        ok(text.includes('Buka berkas jadi lebih cepat'), 'catatan sebelumnya hilang');
        // Satu langkah undo mengembalikan isi berkas.
        win.editor.buffer.undo();
        eq(win.editor.getText(), readTextFile(jurnal), 'undo pengisian aktivitas');
        win.editor.buffer.redo();
        win.save(); settle();
        eq(win.documentCount, 2, 'jumlah tab (Beranda + jurnal)');
        settlePromise(win.openJournal()!);
        eq(win.editor.getText(), readTextFile(jurnal), 'aktivitas digandakan saat dibuka lagi');
        eq(win.documentCount, 2, 'jurnal dibuka di tab baru lagi');
        close(win);
    });

    test('catat cepat saat jurnal terbuka menulis lewat editor (satu langkah undo), bukan disk', () => {
        const { win } = open();
        settlePromise(win.openJournal()!);
        win.openHome(); settle();
        const disk = readTextFile(jurnal);
        win.journalDialogs = { capture: () => '! Flatpak belum bisa diuji' };
        win.captureJournal(); settle();
        eq(readTextFile(jurnal), disk, 'disk tersentuh padahal jurnal terbuka');
        win.switchTab(1); settle();
        ok(win.editor.getText().includes(' ! Flatpak belum bisa diuji\n\n## Aktivitas'), 'catatan di akhir bagian Catatan');
        win.editor.buffer.undo();
        eq(win.editor.getText(), disk, 'undo catat cepat');
        close(win);
    });

    test('Beranda: baris Jurnal hari ini dengan jumlah catatan dan aktivitas', () => {
        const { win } = open();
        const data = win.homeData();
        eq(data.journal, { exists: true, notes: 1, activity: 3 });
        const row = rowTitles(win).find(([title]) => title === 'Jurnal hari ini');
        eq(row, ['Jurnal hari ini', '1 catatan · 3 aktivitas']);
        const capture = descendants(win.home.widget).find((x): x is Gtk.Button => x instanceof Gtk.Button && x.get_tooltip_text() === 'Catat ke Jurnal…');
        ok(capture, 'tombol catat cepat');
        let asked = false;
        win.journalDialogs = { capture: () => { asked = true; return null; } };
        capture!.emit('clicked');
        ok(asked, 'tombol catat tidak membuka dialog');
        descendants(win.home.widget).find((x): x is Adw.ActionRow => x instanceof Adw.ActionRow && x.title === 'Jurnal hari ini')!.emit('activated');
        settle(); settle();
        eq(win.file, jurnal, 'baris tidak membuka jurnal');
        close(win);
    });

    test('ringkas jurnal: Asisten ditanya dengan jurnal sebagai dokumen aktif', () => {
        const { win, s } = open();
        const seen: ChatRequest[] = [];
        const provider: Provider = {
            async chat(req) {
                seen.push(req);
                req.onText('Siap.');
                return { usage: { prompt: 10, cached: 0, completion: 2 }, cancelled: false, toolCalls: [], reasoning: '' };
            },
        };
        const keyStore: KeyStore = { get: async () => ({ key: 'uji', source: 'keyring' }), set: async () => 'keyring', clear: async () => {} };
        win.chat.makeProvider = () => provider;
        win.chat.keyStore = keyStore;
        const asking = win.summarizeJournal();
        ok(asking, 'ringkasan tidak dijalankan');
        settlePromise(asking!);
        settle();
        ok(s.chat, 'panel Asisten tidak dibuka');
        eq(win.file, jurnal, 'jurnal bukan dokumen aktif');
        const sent = JSON.stringify(seen[0] ?? {});
        ok(sent.includes('Tutup hari') && sent.includes(`jurnal/${today}.md`), 'pertanyaan ringkasan');
        win.chat.reset();
        close(win);
    });

    // --shot-journal=<prefix>: simpan <prefix>-jurnal.png, -jurnal-gelap.png, -beranda.png, -catat.png.
    const shot = optVal('shot-journal');
    if (!shot) return;
    const { win } = open({ width: 1100, height: 760, sidebar: true });
    settlePromise(win.openJournal()!);
    const save = (name: string) => {
        for (let i = 0; i < 40; i++) { pump(); GLib.usleep(15000); }
        widgetPixbuf(win.win)?.savev(`${shot}-${name}.png`, 'png', [], []);
    };
    win.setDark(false); save('jurnal');
    win.setDark(true); save('jurnal-gelap');
    win.setDark(false);
    win.openHome(); save('beranda');
    // Dialog catat cepat sungguhan, ditangkap lalu ditutup dari timer.
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
        widgetPixbuf(win.win)?.savev(`${shot}-catat.png`, 'png', [], []);
        win.win.get_visible_dialog()?.close();
        return GLib.SOURCE_REMOVE;
    });
    settlePromise(promptDialog(win.win, { title: 'Catat ke Jurnal', label: 'Tercatat di jurnal hari ini dengan jam sekarang.', accept: 'Catat' }));
    close(win);
}
