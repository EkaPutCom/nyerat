// Tes GUI: panel Asisten (chat) dengan penyedia model dan penyimpan key palsu.

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=3.0';
import type { KeyStore } from '../../src/agent/apikey.js';
import type { ChatRequest, Provider } from '../../src/agent/provider.js';
import { section, test, eq, ok, contains, settle, tmp } from '../framework.js';
import type { GuiContext } from './context.js';

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
            if (widget instanceof Gtk.Container) widget.get_children().forEach(walk);
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
            if (widget instanceof Gtk.Container) widget.get_children().forEach(walk);
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
        w.win.resize(1280, 760);
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
        const press = (state: number) => (panel as unknown as { onInputKey(e: unknown): boolean })
            .onInputKey({ get_keyval: () => [true, 0xff0d], get_state: () => [true, state] });
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

    test('menutup panel', () => {
        w.setOption('chat', false);
        pump();
        ok(!w.chatRevealer.reveal_child, 'tidak tertutup');
        eq(w.settings.chat, false);
    });

    cursorTo(0);

    function buf() { return w.editor.buffer; }
}
