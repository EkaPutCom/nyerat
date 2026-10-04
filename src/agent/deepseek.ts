// Klien API DeepSeek (kompatibel OpenAI: POST /chat/completions) lewat libsoup 3.
// GJS tidak punya fetch, jadi jawaban dibaca baris demi baris dari aliran SSE.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import type SoupModule from 'gi://Soup?version=3.0';
import type { ChatMessage, ChatRequest, ChatResult, Provider, ToolCall, Usage } from './provider.js';
import { httpErrorMessage, parseStreamLine } from './sse.js';

export const DEEPSEEK_URL = 'https://api.deepseek.com';
// Model yang tercantum di dokumentasi DeepSeek saat ini (konteks 1M token, mendukung alat dan mode berpikir).
export const DEEPSEEK_MODELS = ['deepseek-flash', 'deepseek-v4-pro'];

const encoder = new TextEncoder();

type Soup = typeof SoupModule;

// Bentuk pesan di API (snake_case). Saat mode berpikir aktif, reasoning_content wajib dikembalikan bersama tool_calls.
export function toApiMessage(m: ChatMessage): Record<string, unknown> {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    if (m.role === 'assistant' && m.toolCalls?.length) {
        return {
            role: 'assistant', content: m.content,
            ...(m.reasoning ? { reasoning_content: m.reasoning } : {}),
            tool_calls: m.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
        };
    }
    return { role: m.role, content: m.content };
}

export class DeepSeek implements Provider {
    constructor(private readonly apiKey: string, private readonly baseUrl = DEEPSEEK_URL) {}

    // libsoup dimuat saat dibutuhkan: tanpa typelib-nya (gir1.2-soup-3.0) hanya asisten yang tidak berfungsi, bukan seluruh aplikasi.
    async chat(request: ChatRequest): Promise<ChatResult> {
        let Soup: Soup;
        try {
            Soup = (await import('gi://Soup?version=3.0')).default;
        } catch (e) {
            throw new Error('libsoup 3 tidak terpasang (di Debian/Ubuntu: paket gir1.2-soup-3.0); asisten membutuhkannya untuk terhubung ke DeepSeek');
        }
        return this.stream(Soup, request);
    }

    private stream(Soup: Soup, { model, messages, tools, thinking, onText, onReasoning, cancellable }: ChatRequest): Promise<ChatResult> {
        return new Promise((resolve, reject) => {
            // Model penalar bisa lama diam sebelum jawaban mengalir; server mengirim keep-alive tiap beberapa detik.
            const session = new Soup.Session({ idle_timeout: 120 });
            const message = Soup.Message.new('POST', `${this.baseUrl}/chat/completions`);
            message.get_request_headers().append('Authorization', `Bearer ${this.apiKey}`);
            const body = {
                model, stream: true, stream_options: { include_usage: true },
                messages: messages.map(toApiMessage),
                thinking: { type: thinking ? 'enabled' : 'disabled' },
                ...(tools?.length ? { tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
            };
            message.set_request_body_from_bytes('application/json', new GLib.Bytes(encoder.encode(JSON.stringify(body))));

            const cancelled = () => !!cancellable?.is_cancelled();
            let usage: Usage | null = null;
            let reasoning = '';
            const calls: ToolCall[] = [];   // diindeks menurut ToolDelta.index

            session.send_async(message, GLib.PRIORITY_DEFAULT, cancellable ?? null, (_session, result) => {
                let stream: Gio.InputStream;
                try {
                    stream = session.send_finish(result);
                } catch (e) {
                    if (cancelled()) resolve({ usage, cancelled: true, toolCalls: [], reasoning });
                    else reject(new Error(`Tidak dapat terhubung ke DeepSeek: ${e instanceof Error ? e.message : e}`));
                    return;
                }
                const status = message.get_status();
                const reader = new Gio.DataInputStream({ base_stream: stream, close_base_stream: true });
                const finish = (error?: Error) => {
                    try { reader.close(null); } catch (e) { /* sudah tertutup */ }
                    if (error) reject(error);
                    else resolve({ usage, cancelled: cancelled(), toolCalls: calls.filter(Boolean), reasoning });
                };

                // Status bukan 200: seluruh isi adalah JSON galat, bukan aliran.
                let errorBody = '';
                const readLine = () => reader.read_line_async(GLib.PRIORITY_DEFAULT, cancellable ?? null, (_reader, res) => {
                    let line: string | null;
                    try {
                        [line] = reader.read_line_finish_utf8(res);
                    } catch (e) {
                        if (cancelled()) finish();
                        else finish(new Error(`Koneksi ke DeepSeek terputus: ${e instanceof Error ? e.message : e}`));
                        return;
                    }
                    if (line === null) {
                        finish(status === 200 ? undefined : new Error(httpErrorMessage(status, errorBody)));
                        return;
                    }
                    if (status !== 200) {
                        errorBody += line;
                    } else {
                        const event = parseStreamLine(line);
                        if (event?.kind === 'chunk') {
                            if (event.reasoning) { reasoning += event.reasoning; onReasoning?.(event.reasoning); }
                            if (event.text) onText(event.text);
                            for (const t of event.tools) {
                                const call = calls[t.index] ??= { id: '', name: '', arguments: '' };
                                if (t.id) call.id = t.id;
                                if (t.name) call.name += t.name;
                                if (t.arguments) call.arguments += t.arguments;
                            }
                            if (event.usage) usage = event.usage;
                        } else if (event?.kind === 'done') {
                            finish();
                            return;
                        }
                    }
                    readLine();
                });
                readLine();
            });
        });
    }
}
