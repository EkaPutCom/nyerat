// Tes GUI: panel Asisten (chat) dengan penyedia model dan penyimpan key palsu.

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import type { KeyStore } from '../../src/agent/apikey.js';
import { chatsDir, listChats } from '../../src/agent/chatstore.js';
import { readTextFile } from '../../src/files.js';
import type { ChatRequest, Provider } from '../../src/agent/provider.js';
import { section, test, eq, ok, contains, settle, tmp } from '../framework.js';
import type { GuiContext } from './context.js';
import { childrenOf } from '../../src/gtkutil.js';

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
        ok(!w.chatRevealer.reveal_child, 'awalnya tertutup');
        w.setOption('chat', true);   // aksi aplikasi sudah diarahkan ke jendela tes folder, jadi lewat jendela ini langsung
        pump();
        ok(w.chatRevealer.reveal_child, 'tidak terbuka');
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
        panel.modelCombo.set_active_id('deepseek-flash');
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
    const findButton = (prefix: string): Gtk.Button | null => {
        let found: Gtk.Button | null = null;
        const walk = (widget: Gtk.Widget) => {
            if (widget instanceof Gtk.Button && (widget.label ?? '').startsWith(prefix) && widget.get_visible() && widget.get_mapped()) found = widget;
            childrenOf(widget).forEach(walk);
            if (widget instanceof Gtk.ScrolledWindow && widget.get_child()) walk(widget.get_child()!);
        };
        walk(panel.messages);
        return found;
    };
    // Kirim pertanyaan, tunggu kartu persetujuan, tekan tombol, lalu tunggu giliran selesai.
    const proposeAndPress = (provider: Provider, button: string): void => {
        panel.makeProvider = () => provider;
        panel.reset();
        const done = panel.ask('Tolong ubah');
        let pressed = false;
        for (let i = 0; i < 300 && !pressed; i++) {
            pump();
            const b = findButton(button);
            if (b) { b.emit('clicked'); pressed = true; }
            else GLib.usleep(5000);
        }
        ok(pressed, `tombol ${button} tidak muncul`);
        settle(done);
        panel.makeProvider = () => provider;
    };
    const diskOf = (name: string) => readTextFile(GLib.build_filenamev([book, name]));

    test('usulan ubah: kartu menampilkan selisih; Terapkan mengubah editor dan bisa dibatalkan, disk belum tersentuh', () => {
        setText('# Bab 2\n\nBadai menghantam kapal.\n');
        w.editor.buffer.set_modified(false);
        const diskBefore = diskOf('bab-2.md');
        proposeAndPress(proposalProvider('ubah_berkas', { nama: 'bab-2.md', teks_lama: 'Badai menghantam kapal.', teks_baru: 'Badai menghantam kapal itu.', alasan: 'lebih jelas' }), 'Terapkan');
        const text = all();
        contains(text, 'Ubah bab-2.md');
        contains(text, '- Badai menghantam kapal.');
        contains(text, '+ Badai menghantam kapal itu.');
        contains(text, 'Diterapkan.');
        contains(text, '1 perubahan diterapkan');
        eq(w.editor.getText(), '# Bab 2\n\nBadai menghantam kapal itu.\n');
        eq(diskOf('bab-2.md'), diskBefore);
        w.editor.buffer.undo();
        eq(w.editor.getText(), '# Bab 2\n\nBadai menghantam kapal.\n');
    });

    test('usulan ubah pada berkas yang tidak terbuka ditulis ke disk setelah Terapkan', () => {
        proposeAndPress(proposalProvider('ubah_berkas', { nama: 'bab-1', teks_lama: 'membawa surat dari ayahnya', teks_baru: 'membawa surat dari ibunya', alasan: 'x' }), 'Terapkan');
        contains(diskOf('bab-1.md'), 'membawa surat dari ibunya');
    });

    test('Tolak: berkas tidak berubah dan model diberi tahu', () => {
        const before = diskOf('bab-1.md');
        proposeAndPress(proposalProvider('ubah_berkas', { nama: 'bab-1.md', teks_lama: 'Raka bertemu Laras', teks_baru: 'Raka bertemu Hasan', alasan: 'x' }), 'Tolak');
        eq(diskOf('bab-1.md'), before);
        contains(all(), 'Ditolak.');
        ok(!all().includes('perubahan diterapkan'), 'dihitung diterapkan');
    });

    test('usulan berkas baru: Terapkan menulis dan membukanya di tab', () => {
        proposeAndPress(proposalProvider('buat_berkas', { nama: 'rencana/oktober', isi: '# Oktober\n\n- Tulis bab 3\n', alasan: 'rencana bulan ini' }), 'Terapkan');
        eq(diskOf('rencana/oktober.md'), '# Oktober\n\n- Tulis bab 3\n');
        contains(all(), 'Berkas baru rencana/oktober.md');
        ok(w.file?.endsWith('/rencana/oktober.md'), `tab aktif: ${w.file}`);
        ok(w.closeTab(), 'closeTab() gagal');
        pump();
    });

    test('penerapan menolak isi yang berubah sejak diusulkan dan path di luar folder', () => {
        const apply = panel.host.applyChange!;
        const stale = apply({ kind: 'edit', file: 'bab-1.md', before: 'isi lama', after: 'isi baru', reason: '' });
        contains(stale ?? '', 'berubah sejak diusulkan');
        contains(apply({ kind: 'create', file: '../luar.md', before: '', after: 'x', reason: '' }) ?? '', 'di luar folder');
        ok(!GLib.file_test(GLib.build_filenamev([tmp, 'luar.md']), GLib.FileTest.EXISTS), 'berkas tertulis di luar folder');
        contains(apply({ kind: 'create', file: 'bab-1.md', before: '', after: 'x', reason: '' }) ?? '', 'sudah ada');
    });

    test('menutup panel', () => {
        w.setOption('chat', false);
        pump();
        ok(!w.chatRevealer.reveal_child, 'tidak tertutup');
        eq(w.settings.chat, false);
    });

    cursorTo(0);

    function buf() { return w.editor.buffer; }
}
