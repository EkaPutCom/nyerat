// Antarmuka penyedia model. Klien sungguhan (deepseek.ts) dan penyedia palsu di tes memakai bentuk yang sama.
// Murni TypeScript tanpa GTK.

import type Gio from 'gi://Gio';

// Satu alat yang boleh dipanggil model. `parameters` berupa JSON Schema.
export interface ToolSpec {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

// Permintaan model untuk menjalankan alat; arguments adalah string JSON mentah dari model.
export interface ToolCall {
    id: string;
    name: string;
    arguments: string;
}

export type ChatMessage =
    | { role: 'system' | 'user'; content: string }
    | { role: 'assistant'; content: string; reasoning?: string; toolCalls?: ToolCall[] }
    | { role: 'tool'; toolCallId: string; content: string };

export interface Usage {
    prompt: number;         // token masukan
    cached: number;         // dari masukan itu, yang dilayani dari cache prefiks
    completion: number;     // token keluaran
}

export interface ChatRequest {
    model: string;
    messages: ChatMessage[];
    tools?: ToolSpec[];
    thinking?: boolean;      // mode berpikir model; mati = lebih cepat dan murah
    onText: (delta: string) => void;
    onReasoning?: (delta: string) => void;   // "pikiran" model, terpisah dari jawaban
    cancellable?: Gio.Cancellable;
}

export interface ChatResult {
    usage: Usage | null;
    cancelled: boolean;
    toolCalls: ToolCall[];   // tidak kosong = model minta alat dijalankan, bukan menjawab
    reasoning: string;       // harus dikirim balik bersama toolCalls saat mode berpikir aktif
}

export interface Provider {
    // Mengalirkan jawaban lewat onText. Melempar Error berpesan bahasa Indonesia jika gagal.
    chat(request: ChatRequest): Promise<ChatResult>;
}
