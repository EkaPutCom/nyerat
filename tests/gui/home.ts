// Tes GUI: tab Beranda (tenggat, inbox, berkas terbaru, agent) di jendela tersendiri dengan folder kerja sementara.

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import { section, test, eq, ok, tmp, optVal } from '../framework.js';
import { readTextFile } from '../../src/files.js';
import { localDate } from '../../src/markdown/home.js';
import { AppSettings } from '../../src/settings.js';
import { MainWindow } from '../../src/window.js';
import { registerActions } from '../../src/actions.js';
import { descendants, widgetPixbuf } from '../widgets.js';
import type { GuiContext } from './context.js';

export function homeTests(c: GuiContext): void {
    const { w, pump } = c;

    section('Beranda');
    const ws = GLib.build_filenamev([tmp, 'beranda']);
    GLib.mkdir_with_parents(GLib.build_filenamev([ws, 'proyek', 'muara']), 0o755);
    GLib.mkdir_with_parents(GLib.build_filenamev([ws, 'jurnal']), 0o755);
    const path = (name: string) => GLib.build_filenamev([ws, ...name.split('/')]);
    const put = (name: string, text: string) => { GLib.file_set_contents(path(name), text); return path(name); };
    const day = (offset: number) => localDate(new Date(Date.now() + offset * 24 * 60 * 60 * 1000));
    const PAPAN = `---\nkanban: true\n---\n\n## Rencana\n\n- [ ] Implement search #proyek/nyerat @{${day(0)}}\n- [ ] Review arsitektur @{${day(1)}}\n- [ ] Laporan lama @{${day(-2)}}\n- [ ] Nanti saja @{${day(10)}}\n\n## Selesai\n\n- [x] Sudah @{${day(0)}}\n`;
    const papan = put('papan.md', PAPAN);
    put('inbox.md', '---\ninbox: true\n---\n\n- Ide satu\n- Ide dua\n- [x] Sudah diproses\n');
    const arsitektur = put('proyek/muara/arsitektur.md', '# Arsitektur\n');
    const ringkasan = put('proyek/muara/ringkasan.md', '# Ringkasan\n');
    const jurnal = put('jurnal/2026-10-06.md', '# Jurnal\n');

    const settle = () => { for (let i = 0; i < 30; i++) { pump(); GLib.usleep(8000); } };
    const labels = (win: MainWindow) => descendants(win.home.widget).filter((x): x is Gtk.Label => x instanceof Gtk.Label && x.get_mapped()).map(l => l.get_label());
    const rowTitles = (win: MainWindow) => descendants(win.home.widget).filter((x): x is Adw.ActionRow => x instanceof Adw.ActionRow).map(r => r.title);
    const actionEnabled = (name: string) => c.app.lookup_action(name)?.get_enabled();
    const open = (extra: Partial<AppSettings> = {}) => {
        const s = AppSettings.inMemory({ welcomed: true, dark: false, autosave: false, folder: ws, sidebar: false, ...extra });
        const win = new MainWindow(c.app, s, null);
        settle();
        return { win, s };
    };
    const close = (win: MainWindow) => {
        win.win.destroy();
        settle();
        registerActions(c.app, w);
    };

    test('tanpa tab tersimpan, jendela dibuka di Beranda', () => {
        const { win } = open();
        ok(win.homeMode, 'Beranda tidak tampil');
        eq(win.documentName, 'Beranda', 'nama tab');
        ok(!win.statusBar.get_visible(), 'bilah status tetap tampil');
        ok(!actionEnabled('save') && !actionEnabled('bold') && !actionEnabled('undo'), 'aksi dokumen masih aktif');
        ok(win.save() === true && win.file === null, 'Simpan di Beranda tidak boleh membuka dialog');
        close(win);
    });
    test('tenggat: terlambat, hari ini, besok; yang jauh dan selesai tidak ikut', () => {
        const { win } = open();
        eq(win.homeData().tasks.map(t => [t.title, t.status]), [['Laporan lama', 'overdue'], ['Implement search', 'today'], ['Review arsitektur', 'soon']]);
        const all = labels(win);
        ok(all.includes('Terlambat 2 hari') && all.includes('Hari ini') && all.includes('Besok'), `label tenggat: ${all.join('|')}`);
        ok(all.includes('nyerat · papan'), 'proyek dan papan di subjudul');
        ok(!rowTitles(win).includes('Nanti saja') && !rowTitles(win).includes('Sudah'), 'kartu jauh/selesai tampil');
        close(win);
    });
    test('inbox: jumlah item yang belum diproses', () => {
        const { win } = open();
        eq(win.homeData().inboxes, [{ file: 'inbox.md', open: 2 }]);
        ok(labels(win).includes('2 belum diproses'), 'label inbox');
        close(win);
    });
    test('membuka berkas dari Beranda membuka tab baru; Beranda tetap ada dan tidak digandakan', () => {
        const { win } = open();
        win.openFile(arsitektur); settle();
        win.openFile(ringkasan); settle();
        win.openFile(jurnal); settle();
        eq(win.documentCount, 4, 'jumlah tab');
        ok(!win.homeMode, 'masih di Beranda setelah membuka berkas');
        win.openHome(); settle();
        ok(win.homeMode, 'Alt+Home tidak kembali ke Beranda');
        eq(win.documentCount, 4, 'Beranda digandakan');
        const data = win.homeData();
        eq(data.resume.map(r => [r.title, r.subtitle]), [['jurnal', '2026-10-06.md'], ['muara', 'ringkasan.md']], 'kartu Lanjutkan satu per folder');
        eq(data.recent.map(r => [r.title, r.subtitle]), [['arsitektur.md', 'proyek/muara']], 'berkas terbaru');
        ok(labels(win).includes('Lanjutkan') && labels(win).includes('Berkas terbaru'), 'judul bagian');
        close(win);
    });
    test('centang tugas menulis [x] ke papan, batal centang mengembalikannya', () => {
        const { win } = open();
        const checks = () => descendants(win.home.widget).filter((x): x is Gtk.CheckButton => x instanceof Gtk.CheckButton);
        eq(checks().length, 3, 'kotak centang');
        checks()[1].active = true; settle();
        ok(readTextFile(papan).includes(`- [x] Implement search #proyek/nyerat @{${day(0)}}`), 'kartu tidak dicentang di disk');
        ok(checks()[1].active, 'centang tetap terlihat sampai digambar ulang');
        checks()[1].active = false; settle();
        eq(readTextFile(papan), PAPAN, 'batal centang tidak mengembalikan papan');
        // Kartu berubah di luar setelah Beranda digambar: centang ditolak dan papan tidak disentuh.
        GLib.file_set_contents(papan, PAPAN.replace('Review arsitektur', 'Review ulang'));
        checks()[2].active = true; settle();
        ok(readTextFile(papan).includes('- [ ] Review ulang'), 'kartu yang berubah ikut dicentang');
        ok(win.lastToast.includes('berubah'), `toast: ${win.lastToast}`);
        GLib.file_set_contents(papan, PAPAN);
        close(win);
    });
    test('papan yang terbuka dan belum disimpan: tenggat dibaca dan dicentang lewat editornya', () => {
        const { win } = open();
        win.openFile(papan); settle();
        win.editor.replaceText(PAPAN.replace('Laporan lama', 'Laporan revisi'));
        win.openHome(); settle();
        ok(rowTitles(win).includes('Laporan revisi'), 'isi editor yang belum disimpan tidak terbaca');
        const check = descendants(win.home.widget).find((x): x is Gtk.CheckButton => x instanceof Gtk.CheckButton)!;
        check.active = true; settle();
        win.switchTab(1); settle();
        ok(win.editor.getText().includes('- [x] Laporan revisi'), 'editor papan tidak diperbarui');
        eq(readTextFile(papan), PAPAN, 'disk tersentuh padahal papan terbuka');
        win.editor.buffer.set_modified(false);
        close(win);
    });
    test('agent yang berjalan tampil dengan statusnya', () => {
        const { win } = open();
        const run = win.orchestrator.queue.add({ board: papan, card: 'Rapikan README @pi', title: 'Rapikan README', agent: 'pi', project: 'toko', folder: '/tmp/toko', prompt: '', session: null });
        win.refreshHome(); settle();
        ok(labels(win).includes('Agent') && rowTitles(win).includes('Rapikan README') && labels(win).includes('Sedang bekerja'), `agent: ${labels(win).join('|')}`);
        win.orchestrator.queue.end(run, 'stopped');
        win.refreshHome(); settle();
        ok(!labels(win).includes('Agent'), 'bagian Agent tetap tampil setelah selesai');
        close(win);
    });
    test('menutup tab terakhir kembali ke Beranda; Beranda tersimpan dan dipulihkan sebagai tab', () => {
        const { win, s } = open();
        win.openFile(jurnal); settle();
        win.switchTab(-1); settle();
        win.closeTab(); settle();   // tutup Beranda
        eq(win.documentCount, 1, 'Beranda tertutup');
        ok(!win.homeMode, 'masih Beranda');
        win.closeTab(); settle();   // tutup tab terakhir
        ok(win.homeMode, 'tab terakhir tidak menjadi Beranda');
        eq(win.documentName, 'Beranda', 'nama tab');
        win.closeTab(); settle();
        ok(win.homeMode && win.documentCount === 1, 'Beranda sebagai tab terakhir tidak bisa hilang');
        win.openFile(jurnal); settle();
        ok(win.onClose(), 'onClose() menolak');
        eq(s.tabs.map(t => t.file), ['nyerat:beranda', jurnal], 'tab tersimpan');
        close(win);
        const again = open({ tabs: s.tabs, activeTab: 0 });
        ok(again.win.homeMode, 'Beranda tidak dipulihkan sebagai tab aktif');
        eq(again.win.documentCount, 2, 'jumlah tab');
        close(again.win);
    });
    test('tenggat lebih dari tujuh diringkas; baris "Tampilkan" membuka sisanya', () => {
        const banyak = put('banyak.md', `---\nkanban: true\n---\n\n## Rencana\n\n${Array.from({ length: 10 }, (_, i) => `- [ ] Tugas ${i} @{${day(0)}}`).join('\n')}\n`);
        const { win } = open();
        const checks = () => descendants(win.home.widget).filter(x => x instanceof Gtk.CheckButton).length;
        eq(checks(), 7, 'baris tenggat');
        const more = descendants(win.home.widget).find((x): x is Adw.ActionRow => x instanceof Adw.ActionRow && x.title.startsWith('Tampilkan'))!;
        eq(more.title, 'Tampilkan 6 tugas lainnya', 'baris ringkasan');
        more.emit('activated'); settle();
        eq(checks(), 13, 'semua tenggat setelah dibuka');
        GLib.unlink(banyak);
        close(win);
    });
    test('preferensi Beranda mati: menutup tab terakhir mengosongkan dokumen seperti sebelumnya', () => {
        const { win } = open({ home: false });
        ok(!win.homeMode, 'Beranda tampil walau dimatikan');
        win.openHome(); settle();
        ok(win.homeMode, 'Alt+Home tetap membuka Beranda');
        win.openFile(jurnal); settle();
        win.closeTab(); settle();
        win.closeTab(); settle();
        ok(!win.homeMode && win.file === null, 'tab terakhir tidak dikosongkan');
        close(win);
    });
    test('tanpa folder kerja dan riwayat: halaman sambutan dengan Buka Folder', () => {
        const { win } = open({ folder: null });
        ok(labels(win).includes('Buka Folder…') && labels(win).includes('Dokumen Baru'), `sambutan: ${labels(win).join('|')}`);
        close(win);
    });

    // --shot-home=<prefix>: simpan <prefix>-terang.png, <prefix>-gelap.png, <prefix>-sempit.png, dan <prefix>-bawah.png.
    const shot = optVal('shot-home');
    if (!shot) return;
    const { win } = open({ width: 1100, height: 760 });
    for (const file of [arsitektur, ringkasan, jurnal, papan]) win.openFile(file);
    win.orchestrator.queue.add({ board: papan, card: 'Rapikan README @pi', title: 'Rapikan README', agent: 'pi', project: 'toko', folder: '/tmp/toko', prompt: '', session: null }).status = 'waiting';
    win.openHome();
    for (const [name, dark, width] of [['terang', false, 1100], ['gelap', true, 1100], ['sempit', false, 480]] as const) {
        win.setDark(dark);
        win.win.set_default_size(width, 760);
        for (let i = 0; i < 40; i++) { pump(); GLib.usleep(15000); }
        widgetPixbuf(win.win)?.savev(`${shot}-${name}.png`, 'png', [], []);
    }
    win.win.set_default_size(1100, 760);
    for (let i = 0; i < 40; i++) { pump(); GLib.usleep(15000); }
    const adj = win.home.widget.vadjustment;
    adj.set_value(adj.upper - adj.page_size);
    for (let i = 0; i < 20; i++) { pump(); GLib.usleep(15000); }
    widgetPixbuf(win.win)?.savev(`${shot}-bawah.png`, 'png', [], []);
    win.setDark(false);
    win.win.set_default_size(1100, 700);
    close(win);
}
