// Tes GUI: panel Asisten (chat) dengan penyedia model dan penyimpan key palsu.

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import type { KeyStore } from '../../src/agent/apikey.js';
import { chatsDir, listChats } from '../../src/agent/chatstore.js';
import { readTextFile } from '../../src/files.js';
import type { ChatRequest, Provider } from '../../src/agent/provider.js';
import { section, test, eq, ok, contains, settle, tmp, optVal } from '../framework.js';
import { widgetPixbuf } from '../widgets.js';
import type { GuiContext } from './context.js';
import { childrenOf } from '../../src/gtkutil.js';
import type { ProposalViewer } from '../../src/ui/proposalviewer.js';

export function chatTests(c: GuiContext): void {
    const { w, setText, cursorTo, pump } = c;
    const panel = w.chat;

    section('Asisten (chat)');

    const seen: ChatRequest[] = [];
    let reply = 'Laras menyembunyikan **surat** itu.';
    const provider: Provider = {
        async chat(req) {
            seen.push(req);
            req.onReasoning?.('Mencari di naskah. ');
            for (const part of reply.match(/\S+\s*/g) ?? []) req.onText(part);
            return { usage: { prompt: 1500, cached: 1200, completion: 12 }, cancelled: false, toolCalls: [], reasoning: '' };
        },
    };
    let stored: string | null = null;
    const keyStore: KeyStore = {
        get: async () => stored ? { key: stored, source: 'keyring' } : null,
        set: async key => { stored = key; return 'keyring'; },
        clear: async () => { stored = null; },
    };
    panel.makeProvider = () => provider;
    panel.keyStore = keyStore;

    const book = GLib.build_filenamev([tmp, 'buku-asisten']);
    GLib.mkdir_with_parents(book, 0o755);
    GLib.file_set_contents(GLib.build_filenamev([book, 'bab-1.md']), '# Bab 1\n\nRaka bertemu Laras di dermaga. Laras membawa surat dari ayahnya.\n');
    GLib.file_set_contents(GLib.build_filenamev([book, 'bab-2.md']), '# Bab 2\n\nBadai menghantam kapal.\n');
    w.openFolder(book, false);
    w.load(GLib.build_filenamev([book, 'bab-2.md']));
    pump();

    const labels = (): string[] => {
        const out: string[] = [];
        const walk = (widget: Gtk.Widget) => {
            if (widget instanceof Gtk.Label) out.push(widget.get_text());
            childrenOf(widget).forEach(walk);
            // Expander GTK 4 baru memasang isinya sebagai anak saat dibuka.
            if (widget instanceof Gtk.Expander && !widget.expanded && widget.get_child()) walk(widget.get_child()!);
        };
        walk(panel.messages);
        return out;
    };
    const all = () => labels().join('\n');

    test('panel dibuka lewat opsi chat; pengaturan tersimpan', () => {
        ok(!w.chatSplit.show_sidebar, 'awalnya tertutup');
        w.setOption('chat', true);   // aksi aplikasi sudah diarahkan ke jendela tes folder, jadi lewat jendela ini langsung
        // Tunggu panel selesai ditata: popover pengaturan (tes berikutnya) dari tombol yang belum punya
        // posisi di monitor memicu Gdk-CRITICAL gdk_monitor_get_geometry.
        for (let i = 0; i < 20; i++) { pump(); GLib.usleep(10000); }
        ok(w.chatSplit.show_sidebar, 'tidak terbuka');
        eq(w.settings.chat, true);
    });

    test('tanpa API key: pesan petunjuk muncul dan tidak ada permintaan ke model', () => {
        seen.length = 0;
        settle(panel.ask('Apa kabar?'));
        contains(all(), 'Belum ada API key DeepSeek');
        eq(seen.length, 0);
        eq(panel.session.history.length, 0);
        panel.settingsButton.get_popover()?.popdown();
        pump();
    });

    test('key bisa disimpan dari pengaturan', () => {
        panel.keyEntry.set_text('sk-rahasia');
        panel.keyEntry.emit('activate');
        for (let i = 0; i < 100 && panel.keyEntry.text; i++) { pump(); GLib.usleep(2000); }
        eq(stored, 'sk-rahasia');
        eq(panel.keyEntry.text, '');   // key tidak tertinggal di kolom isian
        panel.keyStore = keyStore;
    });

    test('pertanyaan terkirim dengan dokumen aktif, pilihan, dan potongan dari berkas lain', () => {
        seen.length = 0;
        setText('# Bab 2\n\nBadai menghantam kapal. Laras menyembunyikan surat.\n');
        const text = c.text();
        const start = buf().get_iter_at_offset(c.offsetIn(text, 'Badai'));
        const end = buf().get_iter_at_offset(c.offsetIn(text, 'kapal.') + 6);
        buf().select_range(start, end);
        w.save();
        settle(panel.ask('Siapa yang membawa surat dari ayahnya?'));
        eq(seen.length, 1);
        eq(seen[0].model, 'deepseek-flash');
        const [system, user] = [seen[0].messages[0].content, seen[0].messages[1].content];
        contains(system, 'Laras menyembunyikan surat');                   // dokumen aktif (isi buffer)
        contains(user, '<pilihan>\nBadai menghantam kapal.\n</pilihan>');
        contains(user, 'berkas="bab-1.md"');                               // potongan relevan dari berkas lain
        contains(user, 'Laras membawa surat dari ayahnya');
        contains(system, '- bab-1.md · ');                                 // peta proyek memuat berkas lain
        ok(!system.includes('bab-2.md · '), 'berkas aktif seharusnya di peta sebagai "sedang dibuka"');
    });

    test('jawaban tampil sebagai markup, ada proses berpikir, rincian konteks, dan pemakaian token', () => {
        const text = all();
        contains(text, 'Siapa yang membawa surat dari ayahnya?');
        contains(text, 'Laras menyembunyikan surat itu.');          // tanda ** dibuang oleh markup
        ok(!text.includes('**'), 'tanda markdown tampil mentah');
        contains(text, 'Mencari di naskah.');
        contains(text, 'Konteks: ≈');
        contains(text, 'potongan dari bab-1.md');
        contains(text, '1,5 rb masuk (1,2 rb dari cache) · 12 keluar');
        ok(panel.contextButton.get_label()!.startsWith('Konteks · ≈'), `tombol konteks: ${panel.contextButton.get_label()}`);
        eq(panel.session.history.length, 2);
        ok(!panel.busy, 'masih sibuk');
        eq(panel.sendButton.get_tooltip_text(), 'Kirim (Enter)');
    });

    test('jendela log agent menampilkan penalaran dan putaran model, lalu memperbarui diri', () => {
        panel.showLog();
        const viewer = panel.logViewer!;
        ok(viewer, 'jendela log tidak terbuka');
        const text = () => { const out: string[] = []; const walk = (x: Gtk.Widget) => { if (x instanceof Gtk.Label) out.push(x.get_text()); if (x instanceof Gtk.Expander && x.get_child()) walk(x.get_child()!); childrenOf(x).forEach(walk); }; walk(viewer.list); return out.join('\n'); };
        for (let i = 0; i < 20; i++) { pump(); GLib.usleep(10000); }
        contains(text(), 'Memanggil model');
        contains(text(), 'Penalaran model');
        contains(text(), 'Mencari di naskah.');
        panel.session.trace.add('note', 'Kejadian baru');
        for (let i = 0; i < 30 && !text().includes('Kejadian baru'); i++) { pump(); GLib.usleep(10000); }
        contains(text(), 'Kejadian baru');
        viewer.window.destroy();
        panel.logViewer = null;
    });

    test('pertanyaan kedua membawa riwayat dan konteks tidak diulang di giliran lama', () => {
        seen.length = 0;
        settle(panel.ask('Dan ayahnya?'));
        const roles = seen[0].messages.map(m => m.role);
        eq(roles, ['system', 'user', 'assistant', 'user']);
        eq(seen[0].messages[1].content, 'Siapa yang membawa surat dari ayahnya?');
    });

    test('@nama melampirkan berkas utuh; nama tak dikenal dilaporkan di rincian konteks', () => {
        seen.length = 0;
        settle(panel.ask('Samakan gayanya dengan @bab-1 dan @tidak-ada'));
        contains(seen[0].messages[seen[0].messages.length - 1].content, '<berkas nama="bab-1.md">');
        contains(all(), 'tidak ditemukan: @tidak-ada');
    });

    test('popover Konteks merinci apa yang akan dikirim untuk teks yang sedang diketik', () => {
        panel.input.buffer.set_text('Siapa yang membawa surat?', -1);
        const popover = panel.contextButton.get_popover()!;
        popover.popup();
        pump();
        const texts: string[] = [];
        const walk = (widget: Gtk.Widget) => {
            if (widget instanceof Gtk.Label) texts.push(widget.get_text());
            childrenOf(widget).forEach(walk);
        };
        walk(popover);
        popover.popdown();
        pump();
        const shown = texts.join('\n');
        contains(shown, 'Dokumen: bab-2.md (utuh)');
        contains(shown, 'Potongan: bab-1.md');
        contains(shown, 'Total ≈');
        panel.input.buffer.set_text('', -1);
    });

    test('mematikan opsi konteks mengubah apa yang dikirim', () => {
        seen.length = 0;
        panel.options.activeDocument = false;
        panel.options.selection = false;
        panel.options.project = false;
        settle(panel.ask('Pertanyaan umum saja'));
        const msgs = seen[0].messages;
        ok(!msgs[0].content.includes('Laras'), 'naskah masih terkirim');
        eq(msgs[msgs.length - 1].content, 'Pertanyaan umum saja');
        Object.assign(panel.options, { activeDocument: true, selection: true, project: true });
    });

    test('galat dari model ditampilkan di pesan asisten dan tidak masuk riwayat', () => {
        const before = panel.session.history.length;
        panel.makeProvider = () => ({ chat: () => Promise.reject(new Error('Saldo akun DeepSeek tidak cukup')) });
        settle(panel.ask('Coba lagi'));
        contains(all(), 'Saldo akun DeepSeek tidak cukup');
        eq(panel.session.history.length, before);
        ok(!panel.busy, 'tombol kirim terkunci setelah galat');
        panel.makeProvider = () => provider;
    });

    test('tombol hentikan membatalkan jawaban yang sedang mengalir; potongannya tetap tampil dan tersimpan', () => {
        const before = panel.session.history.length;
        panel.makeProvider = () => ({
            chat: req => new Promise(resolve => {
                req.onText('Separuh jawaban ');
                req.cancellable?.connect(() => resolve({ usage: null, cancelled: true, toolCalls: [], reasoning: '' }));
            }),
        });
        const pending = panel.ask('Ceritakan panjang lebar');
        for (let i = 0; i < 200 && !all().includes('Separuh jawaban'); i++) { pump(); GLib.usleep(5000); }
        ok(panel.busy, 'seharusnya sedang sibuk');
        eq(panel.sendButton.get_tooltip_text(), 'Hentikan');
        panel.stop();
        settle(pending);
        contains(all(), 'Separuh jawaban');
        contains(all(), 'Dihentikan');
        eq(panel.session.history.length, before + 2);
        ok(!panel.busy, 'masih sibuk setelah dihentikan');
        panel.makeProvider = () => provider;
    });

    test('mengetik pesan panjang tanpa spasi tidak melebarkan panel atau menggeser editor', () => {
        w.win.set_default_size(1280, 760);
        for (let i = 0; i < 40; i++) { pump(); GLib.usleep(10000); }
        const before = { panel: panel.widget.get_allocated_width(), editor: w.editor.widget.get_allocated_width() };
        panel.input.buffer.set_text('a'.repeat(60), -1);
        for (let i = 0; i < 40; i++) { pump(); GLib.usleep(10000); }
        eq(panel.widget.get_allocated_width(), before.panel);
        eq(w.editor.widget.get_allocated_width(), before.editor);
        // Jawaban dengan satu kata sangat panjang (mis. URL) juga tidak boleh melebarkan panel.
        panel.makeProvider = () => ({ chat: async req => { req.onText('x'.repeat(500)); return { usage: null, cancelled: false, toolCalls: [], reasoning: '' }; } });
        panel.input.buffer.set_text('', -1);
        settle(panel.ask('panjang'));
        for (let i = 0; i < 40; i++) { pump(); GLib.usleep(10000); }
        eq(panel.widget.get_allocated_width(), before.panel);
        panel.makeProvider = () => provider;
        panel.input.buffer.set_text('', -1);
    });

    test('Enter mengirim, Shift+Enter tidak (baris baru)', () => {
        const press = (state: number) => panel.onInputKey(0xff0d, state);
        panel.input.buffer.set_text('baris', -1);
        eq(press(1), false);               // Shift
        seen.length = 0;
        eq(press(0), true);
        for (let i = 0; i < 100 && !seen.length; i++) { pump(); GLib.usleep(2000); }
        eq(seen.length, 1);
        for (let i = 0; i < 100 && panel.busy; i++) { pump(); GLib.usleep(2000); }
    });

    test('percakapan baru mengosongkan pesan dan riwayat', () => {
        panel.reset();
        eq(panel.session.history.length, 0);
        ok(!all().includes('Dan ayahnya?'), 'pesan lama masih tampil');
        ok(panel.empty.get_visible(), 'keadaan kosong tidak tampil');
    });

    test('model yang dipilih disimpan ke pengaturan', () => {
        panel.setModel('deepseek-v4-pro');
        eq(panel.model, 'deepseek-v4-pro');
        panel.modelDrop.set_selected(0);  // deepseek-flash
        eq(w.settings.chatModel, 'deepseek-flash');
    });

    test('asisten menelusuri naskah sendiri: langkah penelusuran tampil dan hasil alat sampai ke model', () => {
        let round = 0;
        let toolResult = '';
        panel.makeProvider = () => ({
            async chat(req) {
                round++;
                const last = req.messages[req.messages.length - 1];
                if (last.role === 'tool') toolResult = last.content;
                if (round === 1) {
                    return { usage: { prompt: 100, cached: 0, completion: 5 }, cancelled: false, reasoning: '',
                        toolCalls: [{ id: 'c1', name: 'cari_teks', arguments: '{"teks":"Badai"}' }, { id: 'c2', name: 'baca_berkas', arguments: '{"nama":"bab-2"}' }] };
                }
                req.onText('Badai ada di bab 2.');
                return { usage: { prompt: 300, cached: 100, completion: 8 }, cancelled: false, toolCalls: [], reasoning: '' };
            },
        });
        settle(panel.ask('Di bab mana ada badai?'));
        const text = all();
        contains(text, 'Mencari teks “Badai” → 1 baris');
        contains(text, 'Membaca bab-2 → baris 1–');
        contains(text, 'Badai ada di bab 2.');
        contains(text, '400 masuk (100 dari cache) · 13 keluar · 2 penelusuran');
        contains(toolResult, 'Badai menghantam kapal.');
        panel.makeProvider = () => provider;
    });

    test('model lama dinormalkan; mode berpikir tersimpan dan diteruskan ke sesi', () => {
        panel.setModel('deepseek-chat');   // nama dari pengaturan versi sebelumnya
        eq(panel.model, 'deepseek-flash');
        panel.thinkingCheck.set_active(true);
        eq(panel.session.thinking, true);
        eq(w.settings.chatThinking, true);
        panel.thinkingCheck.set_active(false);
        eq(w.settings.chatThinking, false);
    });

    // ---------- Riwayat di disk ----------
    const savedFiles = () => listChats(book);
    const rmChats = () => {
        for (const chat of savedFiles()) GLib.unlink(chat.path);
    };

    test('percakapan tersimpan sebagai Markdown di .nyerat/chats dan folder itu tidak ikut Git', () => {
        rmChats();
        panel.reset();
        settle(panel.ask('Pertanyaan riwayat satu'));
        const chats = savedFiles();
        eq(chats.length, 1, 'jumlah berkas');
        eq(chats[0].title, 'Pertanyaan riwayat satu');
        ok(chats[0].path.startsWith(chatsDir(book)), chats[0].path);
        ok(chats[0].path.endsWith('-pertanyaan-riwayat-satu.md'), chats[0].path);
        const text = readTextFile(chats[0].path);
        contains(text, '## Anda\nPertanyaan riwayat satu');
        contains(text, '## Asisten\n');
        contains(text, 'model: deepseek-flash');
        eq(readTextFile(GLib.build_filenamev([book, '.nyerat', '.gitignore'])), '*\n');
    });

    test('giliran berikutnya menambah ke berkas yang sama', () => {
        settle(panel.ask('Lanjutan satu'));
        eq(savedFiles().length, 1, 'jumlah berkas');
        eq(savedFiles()[0].turns, 4);
    });

    test('riwayat tidak dibaca asisten sebagai naskah', () => {
        w.openFolder(book, false);
        ok(!w.chat.host.files().some(f => f.name.includes('.nyerat')), 'riwayat masuk daftar berkas naskah');
    });

    test('Percakapan baru membuat berkas baru; daftar memuat keduanya, terbaru dulu', () => {
        panel.reset();
        settle(panel.ask('Pertanyaan riwayat dua'));
        const chats = savedFiles();
        eq(chats.length, 2, 'jumlah berkas');
        eq(chats.map(c => c.title).sort(), ['Pertanyaan riwayat dua', 'Pertanyaan riwayat satu']);
    });

    test('popover riwayat menampilkan judul tiap percakapan', () => {
        const popover = panel.historyButton.get_popover()!;
        popover.popup();
        pump();
        const texts: string[] = [];
        const walk = (widget: Gtk.Widget) => {
            if (widget instanceof Gtk.Label) texts.push(widget.get_text());
            childrenOf(widget).forEach(walk);
        };
        walk(popover);
        popover.popdown();
        pump();
        contains(texts.join('\n'), 'Pertanyaan riwayat satu');
        contains(texts.join('\n'), 'Pertanyaan riwayat dua');
    });

    test('membuka percakapan lama memulihkan pesan dan riwayat, lalu melanjutkannya di berkas itu', () => {
        const first = savedFiles().find(c => c.title === 'Pertanyaan riwayat satu')!;
        ok(panel.openChat(first.path), 'openChat() gagal');
        eq(panel.session.history.length, 4);
        contains(all(), 'Pertanyaan riwayat satu');
        contains(all(), 'Lanjutan satu');
        contains(all(), 'Laras menyembunyikan surat itu.');
        ok(!all().includes('Pertanyaan riwayat dua'), 'percakapan lain ikut tampil');
        seen.length = 0;
        settle(panel.ask('Lanjutan dua'));
        eq(seen[0].messages.map(m => m.role), ['system', 'user', 'assistant', 'user', 'assistant', 'user']);   // riwayat lama ikut terkirim
        eq(savedFiles().length, 2, 'berkas baru dibuat padahal melanjutkan');
        eq(savedFiles().find(c => c.path === first.path)?.turns, 6);
    });

    test('berkas yang bukan percakapan diabaikan dan tidak bisa dibuka', () => {
        const stray = GLib.build_filenamev([chatsDir(book), 'catatan.md']);
        GLib.file_set_contents(stray, '# Catatan\n\nBukan percakapan.\n');
        eq(savedFiles().length, 2, 'berkas asing masuk daftar');
        ok(!panel.openChat(stray), 'openChat() seharusnya gagal');
        GLib.unlink(stray);
        panel.reset();
    });

    test('saklar simpan dimatikan: tidak ada yang ditulis, dan pilihan tersimpan di pengaturan', () => {
        rmChats();
        panel.saveCheck.set_active(false);
        eq(w.settings.chatSave, false);
        panel.reset();
        settle(panel.ask('Tidak untuk disimpan'));
        eq(savedFiles().length, 0, 'berkas tertulis padahal dimatikan');
        panel.saveCheck.set_active(true);
        eq(w.settings.chatSave, true);
    });

    test('tanpa folder naskah tidak ada yang ditulis', () => {
        const rootBefore = panel.host.root;
        panel.host.root = () => null;
        panel.reset();
        settle(panel.ask('Tanpa folder'));
        eq(savedFiles().length, 0, 'berkas tertulis tanpa folder');
        panel.host.root = rootBefore;
        panel.reset();
    });

    // ---------- Usulan perubahan agent ----------
    const proposalProvider = (name: string, args: object): Provider => {
        let round = 0;
        return {
            async chat(req) {
                round++;
                if (round === 1) return { usage: null, cancelled: false, reasoning: '', toolCalls: [{ id: 'u1', name, arguments: JSON.stringify(args) }] };
                req.onText('Sudah saya usulkan.');
                return { usage: { prompt: 50, cached: 0, completion: 5 }, cancelled: false, toolCalls: [], reasoning: '' };
            },
        };
    };
    // Kirim pertanyaan, tunggu jendela tinjau terbuka, ambil teks selisihnya, lalu tekan tombolnya dan tunggu giliran selesai.
    let lastDiff = '';
    let shotCount = 0;
    const proposeAndPress = (provider: Provider, button: 'apply' | 'reject' | 'close', prepare?: (viewer: ProposalViewer) => void): void => {
        panel.makeProvider = () => provider;
        panel.reset();
        const done = panel.ask('Tolong ubah');
        for (let i = 0; i < 300 && !panel.viewer; i++) { pump(); GLib.usleep(5000); }
        const viewer = panel.viewer;
        ok(viewer, 'jendela tinjau tidak terbuka');
        lastDiff = viewer.diffView.buffer.text;
        // --shot-proposal=<prefix>: simpan tangkapan jendela tinjau dan jendela utama (<prefix>-<n>-tinjau.png) untuk diperiksa mata.
        const prefix = optVal('shot-proposal');
        if (prefix) {
            for (let i = 0; i < 40; i++) { pump(); GLib.usleep(10000); }
            const n = shotCount++;
            widgetPixbuf(viewer.window)?.savev(`${prefix}-${n}-tinjau.png`, 'png', [], []);
            widgetPixbuf(w.win)?.savev(`${prefix}-${n}-utama.png`, 'png', [], []);
        }
        const agenticShot = optVal('shot-agentic');
        if (agenticShot && Array.isArray(viewer.change)) {
            const oldDark = w.dark;
            for (const dark of [false, true]) {
                w.setDark(dark);
                // Jendela tinjau yang terbuka harus mengikuti perubahan tema.
                for (let i = 0; i < 40; i++) { pump(); GLib.usleep(10000); }
                widgetPixbuf(viewer.window)?.savev(`${agenticShot}-paquet-${dark ? 'dark' : 'light'}.png`, 'png', [], []);
            }
            w.setDark(oldDark);
        }
        prepare?.(viewer);
        if (button === 'apply') viewer.applyButton.emit('clicked');
        else if (button === 'reject') viewer.rejectButton.emit('clicked');
        else viewer.window.destroy();
        settle(done);
        panel.makeProvider = () => provider;
    };
    const diskOf = (name: string) => readTextFile(GLib.build_filenamev([book, name]));

    test('usulan ubah: kartu menampilkan selisih; Terapkan mengubah editor dan bisa dibatalkan, disk belum tersentuh', () => {
        setText('# Bab 2\n\nBadai menghantam kapal.\n');
        w.editor.buffer.set_modified(false);
        const diskBefore = diskOf('bab-2.md');
        proposeAndPress(proposalProvider('ubah_berkas', { nama: 'bab-2.md', teks_lama: 'Badai menghantam kapal.', teks_baru: 'Badai menghantam kapal itu.', alasan: 'lebih jelas' }), 'apply');
        const text = all();
        contains(text, 'Ubah bab-2.md');
        contains(lastDiff, '@@ -1,3 +1,3 @@');
        contains(lastDiff, '-Badai menghantam kapal.');
        contains(lastDiff, '+Badai menghantam kapal itu.');
        contains(text, 'Diterapkan.');
        contains(text, '1 perubahan diterapkan');
        eq(w.editor.getText(), '# Bab 2\n\nBadai menghantam kapal itu.\n');
        eq(diskOf('bab-2.md'), diskBefore);
        w.editor.buffer.undo();
        eq(w.editor.getText(), '# Bab 2\n\nBadai menghantam kapal.\n');
    });

    test('usulan ubah pada berkas yang tidak terbuka ditulis ke disk setelah Terapkan', () => {
        proposeAndPress(proposalProvider('ubah_berkas', { nama: 'bab-1', teks_lama: 'membawa surat dari ayahnya', teks_baru: 'membawa surat dari ibunya', alasan: 'x' }), 'apply');
        contains(diskOf('bab-1.md'), 'membawa surat dari ibunya');
    });

    test('Tolak: berkas tidak berubah dan model diberi tahu', () => {
        const before = diskOf('bab-1.md');
        proposeAndPress(proposalProvider('ubah_berkas', { nama: 'bab-1.md', teks_lama: 'Raka bertemu Laras', teks_baru: 'Raka bertemu Hasan', alasan: 'x' }), 'reject');
        eq(diskOf('bab-1.md'), before);
        contains(all(), 'Ditolak.');
        ok(!all().includes('perubahan diterapkan'), 'dihitung diterapkan');
    });

    test('menutup jendela tinjau sama dengan menolak', () => {
        const before = diskOf('bab-1.md');
        proposeAndPress(proposalProvider('ubah_berkas', { nama: 'bab-1.md', teks_lama: 'Raka bertemu Laras', teks_baru: 'Raka bertemu Hasan', alasan: 'x' }), 'close');
        eq(diskOf('bab-1.md'), before);
        contains(all(), 'Ditolak.');
    });

    test('Hentikan saat usulan menunggu: jendela tinjau tertutup dan kartu menjadi Dibatalkan', () => {
        panel.makeProvider = () => proposalProvider('ubah_berkas', { nama: 'bab-1.md', teks_lama: 'Raka bertemu Laras', teks_baru: 'x', alasan: 'x' });
        panel.reset();
        const before = diskOf('bab-1.md');
        const done = panel.ask('Tolong ubah');
        for (let i = 0; i < 300 && !panel.viewer; i++) { pump(); GLib.usleep(5000); }
        ok(panel.viewer, 'jendela tinjau tidak terbuka');
        panel.stop();
        settle(done);
        contains(all(), 'Dibatalkan.');
        eq(panel.viewer, null);
        eq(diskOf('bab-1.md'), before);
    });

    test('usulan berkas baru: Terapkan menulis dan membukanya di tab', () => {
        proposeAndPress(proposalProvider('buat_berkas', { nama: 'rencana/oktober', isi: '# Oktober\n\n- Tulis bab 3\n', alasan: 'rencana bulan ini' }), 'apply');
        eq(diskOf('rencana/oktober.md'), '# Oktober\n\n- Tulis bab 3\n');
        contains(all(), 'Berkas baru rencana/oktober.md');
        contains(lastDiff, '@@ -0,0 +1,3 @@');
        ok(w.file?.endsWith('/rencana/oktober.md'), `tab aktif: ${w.file}`);
        ok(w.closeTab(), 'closeTab() gagal');
        pump();
    });

    test('usulan papan kanban: tambah dan pindah kartu muncul di papan yang sedang terbuka', () => {
        const papan = GLib.build_filenamev([book, 'tugas.md']);
        GLib.file_set_contents(papan, '---\nkanban: true\n---\n\n## Rencana\n\n- [ ] Tulis laporan #penting\n- [ ] Kirim undangan @{2026-10-20}\n\n## Dikerjakan\n\n- [ ] Riset pelabuhan\n\n## Selesai\n\n- [x] Pesan tempat\n');
        w.openFile(papan);
        for (let i = 0; i < 40; i++) { pump(); GLib.usleep(8000); }
        ok(w.boardMode, 'papan tidak terbuka sebagai papan');

        const press = (provider: Provider) => { proposeAndPress(provider, 'apply'); for (let i = 0; i < 40; i++) { pump(); GLib.usleep(8000); } };   // papan memuat ulang di idle
        try {
        press(proposalProvider('ubah_kanban', { nama: 'tugas', aksi: 'tambah', kartu: 'Susun jadwal revisi @{2026-11-02}', daftar: 'dikerjakan', alasan: 'permintaan pengguna' }));
        contains(lastDiff, '+- [ ] Susun jadwal revisi @{2026-11-02}');
        eq(w.board.getBoard().columns[1].cards.map(c => c.text), ['Riset pelabuhan', 'Susun jadwal revisi @{2026-11-02}']);

        press(proposalProvider('ubah_kanban', { nama: 'tugas', aksi: 'pindah', kartu: 'Kirim undangan', daftar: 'Selesai', alasan: 'sudah dikirim' }));
        eq(w.board.getBoard().columns[2].cards.map(c => c.text), ['Pesan tempat', 'Kirim undangan @{2026-10-20}']);
        eq(w.board.getBoard().columns[0].cards.map(c => c.text), ['Tulis laporan #penting']);
        const prefix = optVal('shot-proposal');
        if (prefix) {
            for (let i = 0; i < 40; i++) { pump(); GLib.usleep(10000); }
            widgetPixbuf(w.win)?.savev(`${prefix}-papan.png`, 'png', [], []);
        }
        } finally {
            w.editor.buffer.set_modified(false);   // jangan memunculkan dialog simpan saat menutup tab
            ok(w.closeTab(), 'closeTab() gagal');
            pump();
        }
    });

    test('paket beberapa berkas: satu keputusan menerapkan semua diff dan journal dipulihkan', () => {
        const tindakan = ['rencana/paket-a', 'rencana/paket-b'].map(nama => ({ alat: 'buat_berkas', argumen: JSON.stringify({ nama, isi: '# Jadwal rilis\n\nRilis: 22 November\n', alasan: 'Sinkronkan keputusan rapat dalam satu paket' }) }));
        proposeAndPress(proposalProvider('usulkan_paket', { tindakan }), 'apply');
        contains(lastDiff, 'Berkas: rencana/paket-a.md');
        contains(lastDiff, 'Berkas: rencana/paket-b.md');
        eq(diskOf('rencana/paket-a.md'), diskOf('rencana/paket-b.md'));
        contains(all(), 'Diterapkan.');
        const saved = listChats(book).find(chat => readTextFile(chat.path).includes('usulkan_paket'));
        ok(saved, 'checkpoint paket tidak tersimpan');
        ok(panel.openChat(saved.path), 'pemulihan gagal');
        eq(panel.session.events.find(e => e.tool === 'usulkan_paket')?.status, 'applied');
        contains(all(), 'Diterapkan: usulkan_paket');
        const prefix = optVal('shot-agentic');
        if (prefix) {
            for (let i = 0; i < 40; i++) { pump(); GLib.usleep(10000); }
            widgetPixbuf(w.win)?.savev(`${prefix}-journal.png`, 'png', [], []);
        }
    });

    test('checkpoint rencana terbuka lagi dengan tombol lanjutkan, tema terang dan gelap', () => {
        panel.reset();
        panel.makeProvider = () => proposalProvider('atur_pekerjaan', { tujuan: 'Sinkronkan jadwal rilis', langkah: [{ teks: 'Baca keputusan rapat', status: 'done' }, { teks: 'Periksa rencana dan kartu tugas', status: 'pending' }], catatan: 'Tanggal rilis: 22 November' });
        settle(panel.ask('Sinkronkan jadwal rilis'));
        // Rencana tampil sebagai daftar centang: satu baris per langkah, bukan teks "- [x]", dan tidak diulang di baris langkah.
        const workRows = (): Gtk.Widget[] => {
            const out: Gtk.Widget[] = [];
            const walk = (widget: Gtk.Widget) => {
                if (widget.has_css_class('chat-work-step')) out.push(widget);
                childrenOf(widget).forEach(walk);
            };
            walk(panel.messages);
            return out;
        };
        eq(workRows().length, 2);
        ok(workRows()[0].get_first_child()?.has_css_class('work-done'), 'langkah selesai tidak dicentang');
        ok(workRows()[1].get_first_child()?.has_css_class('work-pending'), 'langkah berikutnya tidak berupa lingkaran kosong');
        contains(all(), '1/2 langkah');
        ok(!all().includes('- [x]'), 'rencana masih tampil sebagai teks mentah');
        ok(!all().includes('Rencana pekerjaan →'), 'rencana diulang di baris langkah');
        const saved = listChats(book).find(chat => readTextFile(chat.path).includes('pekerjaan:'));
        ok(saved, 'rencana tidak disimpan');
        ok(panel.openChat(saved.path), 'rencana tidak dibuka');
        eq(panel.session.work?.status, 'paused');
        const resume = childrenOf(panel.messages).find(w => w instanceof Gtk.Button && w.get_label() === 'Lanjutkan pekerjaan');
        ok(resume, 'tombol lanjutkan hilang');
        eq(workRows().length, 2);
        const prefix = optVal('shot-agentic');
        if (prefix) {
            const oldDark = w.dark;
            for (const dark of [false, true]) {
                w.setDark(dark);
                for (let i = 0; i < 40; i++) { pump(); GLib.usleep(10000); }
                widgetPixbuf(w.win)?.savev(`${prefix}-rencana-${dark ? 'dark' : 'light'}.png`, 'png', [], []);
            }
            w.setDark(oldDark);
        }
        panel.reset();
    });

    // Provider yang mencatat hasil alat yang dikirim balik, untuk memeriksa catatan pengguna.
    const toolReplies: string[] = [];
    const recording = (name: string, args: object): Provider => {
        const inner = proposalProvider(name, args);
        return { chat: req => { for (const m of req.messages) if (m.role === 'tool') toolReplies.push(m.content); return inner.chat(req); } };
    };
    const buttons = (): Gtk.Button[] => {
        const out: Gtk.Button[] = [];
        const walk = (widget: Gtk.Widget) => { if (widget instanceof Gtk.Button) out.push(widget); childrenOf(widget).forEach(walk); };
        walk(panel.messages);
        return out;
    };

    test('paket: hapus centang satu berkas → hanya yang dicentang diterapkan; Urungkan mengembalikannya', () => {
        GLib.file_set_contents(GLib.build_filenamev([book, 'jadwal-a.md']), 'Rilis 15 November\n');
        GLib.file_set_contents(GLib.build_filenamev([book, 'jadwal-b.md']), 'Rilis 15 November\n');
        const tindakan = ['jadwal-a', 'jadwal-b'].map(nama => ({ alat: 'ubah_berkas', argumen: JSON.stringify({ nama, teks_lama: '15 November', teks_baru: '22 November', alasan: 'keputusan rapat' }) }));
        toolReplies.length = 0;
        proposeAndPress(recording('usulkan_paket', { tindakan }), 'apply', viewer => {
            eq(viewer.checks.length, 2);
            viewer.checks[1].set_active(false);
            eq(viewer.applyButton.get_label(), 'Terapkan 1 dari 2');
            viewer.noteEntry.set_text('jadwal-b menunggu konfirmasi');
            const prefix = optVal('shot-proposal');
            if (prefix) {
                for (let i = 0; i < 40; i++) { pump(); GLib.usleep(10000); }
                widgetPixbuf(viewer.window)?.savev(`${prefix}-sebagian.png`, 'png', [], []);
            }
        });
        contains(diskOf('jadwal-a.md'), '22 November');
        contains(diskOf('jadwal-b.md'), '15 November');
        contains(all(), 'Diterapkan 1 dari 2 berkas.');
        ok(toolReplies.some(m => m.includes('Ditolak (jangan ulangi tanpa ditanya): jadwal-b.md') && m.includes('Catatan pengguna: jadwal-b menunggu konfirmasi')), toolReplies.join('\n'));
        const undo = buttons().find(b => b.get_label() === 'Urungkan' && b.get_visible());
        ok(undo, 'tombol Urungkan tidak ada');
        const prefix = optVal('shot-proposal');
        if (prefix) {
            for (let i = 0; i < 40; i++) { pump(); GLib.usleep(10000); }
            widgetPixbuf(w.win)?.savev(`${prefix}-urungkan.png`, 'png', [], []);
        }
        undo.emit('clicked');
        eq(diskOf('jadwal-a.md'), 'Rilis 15 November\n');
        contains(all(), 'Diurungkan.');
        eq(panel.session.events.map(e => e.status), ['reverted', 'rejected']);
    });

    test('Urungkan gagal tanpa menimpa bila berkas sudah disunting lagi', () => {
        proposeAndPress(proposalProvider('ubah_berkas', { nama: 'jadwal-a', teks_lama: '15 November', teks_baru: '23 November', alasan: 'x' }), 'apply');
        GLib.file_set_contents(GLib.build_filenamev([book, 'jadwal-a.md']), 'Disunting pengguna\n');
        buttons().find(b => b.get_label() === 'Urungkan')!.emit('clicked');
        eq(diskOf('jadwal-a.md'), 'Disunting pengguna\n');
        contains(all(), 'Tidak dapat diurungkan: jadwal-a.md berubah sejak diusulkan');
        eq(panel.session.events[0].status, 'applied');
    });

    test('Tolak dengan catatan: catatan sampai ke model dan tampil di kartu', () => {
        toolReplies.length = 0;
        proposeAndPress(recording('ubah_berkas', { nama: 'bab-1.md', teks_lama: 'Raka bertemu Laras', teks_baru: 'Raka bertemu Hasan', alasan: 'x' }), 'reject', viewer => viewer.noteEntry.set_text('Namanya tetap Laras'));
        contains(all(), 'Ditolak: Namanya tetap Laras');
        ok(toolReplies.some(m => m.includes('Catatan pengguna: Namanya tetap Laras')), toolReplies.join('\n'));
    });

    test('pindah berkas yang terbuka: tab mengikuti path baru; Urungkan memindahkannya kembali', () => {
        const from = GLib.build_filenamev([book, 'pindahan.md']);
        GLib.file_set_contents(from, '# Pindahan\n');
        w.openFile(from);
        pump();
        try {
            proposeAndPress(proposalProvider('pindah_berkas', { nama: 'pindahan', tujuan: 'arsip/pindahan', alasan: 'arsipkan' }), 'apply');
            contains(lastDiff, 'Pindah: pindahan.md → arsip/pindahan.md');
            eq(diskOf('arsip/pindahan.md'), '# Pindahan\n');
            ok(!GLib.file_test(from, GLib.FileTest.EXISTS), 'asal masih ada');
            eq(w.file, GLib.build_filenamev([book, 'arsip', 'pindahan.md']));
            buttons().find(b => b.get_label() === 'Urungkan')!.emit('clicked');
            eq(w.file, from);
            ok(GLib.file_test(from, GLib.FileTest.EXISTS), 'tidak kembali');
        } finally {
            w.editor.buffer.set_modified(false);
            ok(w.closeTab(), 'closeTab() gagal');
            pump();
        }
    });

    test('hapus berkas: dibuang ke Tempat Sampah setelah Terapkan, ditolak tidak menyentuhnya', () => {
        const path = GLib.build_filenamev([book, 'usang.md']);
        GLib.file_set_contents(path, '# Usang\n');
        proposeAndPress(proposalProvider('hapus_berkas', { nama: 'usang', alasan: 'duplikat' }), 'reject');
        ok(GLib.file_test(path, GLib.FileTest.EXISTS), 'terhapus padahal ditolak');
        proposeAndPress(proposalProvider('hapus_berkas', { nama: 'usang', alasan: 'duplikat' }), 'apply');
        contains(lastDiff, 'Dibuang ke Tempat Sampah: usang.md');
        contains(lastDiff, '-# Usang');
        if (all().includes('Gagal diterapkan')) return;   // lingkungan tanpa Tempat Sampah
        ok(!GLib.file_test(path, GLib.FileTest.EXISTS), 'berkas masih ada');
    });

    test('penerapan menolak isi yang berubah sejak diusulkan dan path di luar folder', () => {
        const apply = panel.host.applyChange!;
        const stale = apply({ kind: 'edit', file: 'bab-1.md', before: 'isi lama', after: 'isi baru', reason: '' });
        contains(stale ?? '', 'berubah sejak diusulkan');
        contains(apply({ kind: 'create', file: '../luar.md', before: '', after: 'x', reason: '' }) ?? '', 'di luar folder');
        ok(!GLib.file_test(GLib.build_filenamev([tmp, 'luar.md']), GLib.FileTest.EXISTS), 'berkas tertulis di luar folder');
        contains(apply({ kind: 'create', file: 'bab-1.md', before: '', after: 'x', reason: '' }) ?? '', 'sudah ada');
    });

    test('jawaban panjang: panel menempel di bawah sampai baris terakhir dan footer terlihat', () => {
        const long = Array.from({ length: 14 }, (_, i) => `${i + 1}. **Butir ${i + 1}** — contoh \`kode ${i}\` dengan kalimat cukup panjang supaya membungkus ke beberapa baris di panel sempit.`).join('\n')
            + '\n\nKalau mau, saya bisa usulkan satu perubahan konkret. Mau saya buatkan usulannya?';
        panel.makeProvider = () => ({
            async chat(req) {
                for (const part of long.match(/\S+\s*/g) ?? []) req.onText(part);
                return { usage: { prompt: 3600, cached: 3000, completion: 400 }, cancelled: false, toolCalls: [], reasoning: '' };
            },
        });
        panel.reset();
        settle(panel.ask('Beri masukan panjang'));
        const vadj = panel.scroller.get_vadjustment();
        for (let i = 0; i < 60; i++) { pump(); GLib.usleep(10000); }
        ok(vadj.get_upper() > vadj.get_page_size(), 'jawaban tidak cukup panjang untuk menggulir');
        // Nilai adjustment saja tidak cukup (pernah benar sementara gambarnya terpotong): periksa posisi footer sebenarnya
        // di dalam area terlihat.
        let footer: Gtk.Label | null = null;
        const walk = (widget: Gtk.Widget) => {
            if (widget instanceof Gtk.Label && widget.get_text().startsWith('3,6 rb masuk')) footer = widget;
            childrenOf(widget).forEach(walk);
        };
        walk(panel.messages);
        ok(footer, 'footer pemakaian token tidak ada');
        const bounds = (footer as Gtk.Label).compute_bounds(panel.scroller);
        ok(bounds[0], 'posisi footer tidak terbaca');
        const bottom = bounds[1].get_y() + bounds[1].get_height();
        ok(bounds[1].get_y() >= 0 && bottom <= panel.scroller.get_height() + 1, `footer di luar area terlihat: y=${bounds[1].get_y().toFixed(0)}, bawah=${bottom.toFixed(0)}, tinggi=${panel.scroller.get_height()}`);
        const prefix = optVal('shot-chat');
        if (prefix) widgetPixbuf(w.win)?.savev(`${prefix}.png`, 'png', [], []);
        panel.makeProvider = () => provider;
        panel.reset();
    });

    test('menutup panel', () => {
        w.setOption('chat', false);
        pump();
        ok(!w.chatSplit.show_sidebar, 'tidak tertutup');
        eq(w.settings.chat, false);
    });

    cursorTo(0);

    function buf() { return w.editor.buffer; }
}
