// Tes klien DeepSeek terhadap server SSE tiruan di 127.0.0.1 (libsoup), tanpa jaringan sungguhan.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import System from 'system';
import { DeepSeek } from '../../src/agent/deepseek.js';
import { section, test, eq, ok, contains, settle } from '../framework.js';

const enc = new TextEncoder();

export function deepseekTests(): void {
    section('Klien DeepSeek (server tiruan)');
    // Tes unit sebelumnya berjalan tanpa main loop dan bisa meninggalkan GC tertunda; callback Soup yang tiba
    // saat itu diblokir GJS ("callback during garbage collection"). Di aplikasi main loop selalu berjalan.
    System.gc();

    let auth = '', requested = '';
    let mode: 'stream' | 'unauthorized' | 'tools' | 'busy' | 'truncated' = 'stream';
    let body: any = null;
    let requests = 0;
    const server = new Soup.Server();
    server.add_handler('/chat/completions', (_server, msg) => {
        requests++;
        if (mode === 'busy') {
            if (requests === 1) { msg.set_status(503, null); msg.get_response_body().append(enc.encode('{}')); return; }
            mode = 'stream';
        }
        if (mode === 'truncated') {
            msg.set_status(200, null);
            msg.get_response_body().append(enc.encode('data: {"choices":[{"delta":{"content":"sebagian"}}]}\n\n'));
            return;
        }
        auth = msg.get_request_headers().get_one('Authorization') ?? '';
        requested = msg.get_method();
        try {
            body = JSON.parse(new TextDecoder().decode(msg.get_request_body().data ?? new Uint8Array()));
        } catch (e) {
            body = null;
        }
        if (mode === 'unauthorized') {
            msg.set_status(401, null);
            msg.get_response_headers().set_content_type('application/json', null);
            msg.get_response_body().append(enc.encode('{"error":{"message":"Authentication Fails"}}'));
            return;
        }
        msg.set_status(200, null);
        msg.get_response_headers().set_content_type('text/event-stream', null);
        if (mode === 'tools') {
            // Dua alat, argumennya datang bertahap dan berselang-seling menurut index.
            const delta = (tool_calls: object[]) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls } }] })}`;
            const lines = [
                'data: {"choices":[{"delta":{"reasoning_content":"perlu mencari"}}]}',
                delta([{ index: 0, id: 'c1', type: 'function', function: { name: 'cari_teks', arguments: '{"te' } }]),
                delta([{ index: 1, id: 'c2', type: 'function', function: { name: 'daftar_berkas', arguments: '' } }]),
                delta([{ index: 0, function: { arguments: 'ks":"Laras"}' } }]),
                'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":50,"completion_tokens":9}}',
                'data: [DONE]',
            ];
            msg.get_response_body().append(enc.encode(lines.join('\n\n') + '\n\n'));
            return;
        }
        const lines = [
            ': keep-alive',
            'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}',
            'data: {"choices":[{"delta":{"reasoning_content":"Menimbang… "}}]}',
            'data: {"choices":[{"delta":{"content":"Halo "}}]}',
            'data: {"choices":[{"delta":{"content":"penulis"}}]}',
            'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":7,"prompt_cache_hit_tokens":100}}',
            'data: [DONE]',
        ];
        msg.get_response_body().append(enc.encode(lines.join('\n\n') + '\n\n'));
    });
    server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
    const port = server.get_uris()[0].get_port();
    const client = (key: string) => new DeepSeek(key, `http://127.0.0.1:${port}`);
    const request = { model: 'deepseek-chat', messages: [{ role: 'user' as const, content: 'hai' }] };

    test('jawaban mengalir per potongan, penalaran terpisah, usage terbaca, key dikirim sebagai Bearer', () => {
        mode = 'stream';
        let text = '', thinking = '';
        const result = settle(client('sk-uji').chat({ ...request, onText: d => { text += d; }, onReasoning: d => { thinking += d; } }));
        eq(text, 'Halo penulis');
        eq(thinking, 'Menimbang… ');
        eq(result, { usage: { prompt: 120, cached: 100, completion: 7 }, cancelled: false, toolCalls: [], reasoning: 'Menimbang… ' });
        eq(body.thinking, { type: 'disabled' });   // bawaan: tanpa mode berpikir
        eq(body.stream, true);
        ok(!('tools' in body), 'tanpa alat tidak boleh mengirim tools');
        eq(auth, 'Bearer sk-uji');
        eq(requested, 'POST');
    });

    test('alat dikirim sebagai tools; pemanggilan alat yang datang bertahap dirakit per index', () => {
        mode = 'tools';
        let text = '';
        const result = settle(client('sk-uji').chat({
            model: 'deepseek-flash', thinking: true, onText: d => { text += d; },
            tools: [{ name: 'cari_teks', description: 'cari', parameters: { type: 'object', properties: {} } }],
            messages: [
                { role: 'system', content: 'sistem' },
                { role: 'user', content: 'tanya' },
                { role: 'assistant', content: '', reasoning: 'pikir', toolCalls: [{ id: 'x', name: 'daftar_berkas', arguments: '{}' }] },
                { role: 'tool', toolCallId: 'x', content: 'hasil' },
            ],
        }));
        eq(text, '');
        eq(result.toolCalls, [{ id: 'c1', name: 'cari_teks', arguments: '{"teks":"Laras"}' }, { id: 'c2', name: 'daftar_berkas', arguments: '' }]);
        eq(result.reasoning, 'perlu mencari');
        eq(result.usage, { prompt: 50, cached: 0, completion: 9 });
        eq(body.thinking, { type: 'enabled' });
        eq(body.tools, [{ type: 'function', function: { name: 'cari_teks', description: 'cari', parameters: { type: 'object', properties: {} } } }]);
        eq(body.messages[2], { role: 'assistant', content: '', reasoning_content: 'pikir', tool_calls: [{ id: 'x', type: 'function', function: { name: 'daftar_berkas', arguments: '{}' } }] });
        eq(body.messages[3], { role: 'tool', tool_call_id: 'x', content: 'hasil' });
    });

    test('503 sebelum keluaran dicoba ulang; aliran terpotong setelah teks tidak diulang', () => {
        mode = 'busy'; requests = 0;
        let text = '';
        settle(client('sk-uji').chat({ ...request, onText: d => { text += d; } }));
        eq(requests, 2); eq(text, 'Halo penulis');
        mode = 'truncated'; requests = 0; text = '';
        let failed = false;
        try { settle(client('sk-uji').chat({ ...request, onText: d => { text += d; } })); } catch (e) { failed = true; contains(String(e), 'penanda selesai'); }
        eq(failed, true); eq(requests, 1); eq(text, 'sebagian');
    });

    test('pembatalan selama jeda retry selesai tanpa mengirim permintaan kedua', () => {
        mode = 'busy'; requests = 0;
        const cancellable = new Gio.Cancellable();
        const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { cancellable.cancel(); return GLib.SOURCE_REMOVE; });
        const r = settle(client('sk-uji').chat({ ...request, cancellable, onText: () => {} }));
        eq(r.cancelled, true); eq(requests, 1);
        // Timer sudah dijalankan ketika settle selesai.
        ok(timer > 0, 'timer tidak dibuat');
    });

    test('status 401 menjadi galat berbahasa Indonesia dengan pesan server', () => {
        mode = 'unauthorized';
        let message = '';
        try {
            settle(client('salah').chat({ ...request, onText: () => {} }));
        } catch (e) {
            message = e instanceof Error ? e.message : String(e);
        }
        contains(message, 'API key ditolak');
        contains(message, 'Authentication Fails');
    });

    test('permintaan yang sudah dibatalkan selesai sebagai cancelled, bukan galat', () => {
        mode = 'stream';
        const cancellable = new Gio.Cancellable();
        cancellable.cancel();
        const result = settle(client('sk-uji').chat({ ...request, onText: () => {}, cancellable }));
        ok(result.cancelled, 'seharusnya cancelled');
    });

    test('server yang tak terjangkau menghasilkan galat yang jelas', () => {
        let message = '';
        try {
            settle(new DeepSeek('k', 'http://127.0.0.1:1').chat({ ...request, onText: () => {} }));
        } catch (e) {
            message = e instanceof Error ? e.message : String(e);
        }
        contains(message, 'DeepSeek');
    });

    server.disconnect();
    GLib.usleep(1000);
}
