// Papan kanban dalam file Markdown. Frontmatter menandai dokumen sebagai papan:
//
//   ---
//   kanban: true
//   ---
//
// Penanda lama "kanban-plugin: …" (dari plugin Kanban Obsidian) tetap dikenali, dan
// frontmatter yang sudah ada dipertahankan apa adanya saat disimpan. Isinya:
//
//   ## Rencana                      ← heading level 2 = daftar (kolom)
//
//   - [ ] Tulis laporan #penting    ← item daftar = kartu; [x] = selesai
//     catatan kartu (diindentasi)   ← baris yang diindentasi = catatan kartu
//   - [ ] Kirim undangan @{2026-10-20}
//   - [ ] Perbaiki checkout @pi     ← @nama = harness yang ditugasi mengerjakan kartu
//
//   ## Selesai
//
//   - [x] Pesan tempat
//
//   %% kanban:settings
//   ...                             ← sisanya dipertahankan apa adanya
//
// Murni TypeScript tanpa GTK. Semua operasi mengembalikan papan baru; papan asal
// tidak diubah, sehingga mudah diuji.

export interface Card {
    done: boolean | null;   // null = item biasa tanpa kotak centang ("- teks")
    text: string;           // baris pertama kartu, Markdown mentah (termasuk #tag dan @{tanggal})
    notes: string[];        // catatan: baris lanjutan kartu, tanpa indentasi
}

export interface Column {
    title: string;
    intro: string[];        // baris biasa sebelum kartu pertama (misalnya "**Complete**")
    cards: Card[];
    outro: string[];        // baris biasa setelah kartu terakhir (misalnya "***")
}

export interface Board {
    head: string[];         // semua baris sebelum daftar pertama: frontmatter dan judul
    columns: Column[];
    footer: string[];       // dari "%% kanban:settings" sampai akhir file
}

export interface Position {
    column: number;
    index: number;
}

export const DEFAULT_HEAD = ['---', 'kanban: true', '---'];

const COLUMN = /^##\s+(.*?)\s*$/;
const CARD = /^[-*+]\s+(?:\[([ xX])\]\s?)?(.*)$/;
const FOOTER = /^%%\s*kanban:settings/;
const INDENTED = /^( {2,}|\t)/;

// ---------- Mengenali dan membaca ----------

// Penanda papan di frontmatter: "kanban: true", atau "kanban-plugin: …" (nilai apa pun).
const MARKER = /^(?:kanban:\s*["']?(?:true|yes)["']?|kanban-plugin:\s*\S+)\s*$/i;

// Dokumen adalah papan kanban jika frontmatter-nya memuat penanda papan.
export function isKanban(text: string): boolean {
    const lines = text.split('\n', 40);
    if (lines[0]?.trim() !== '---') return false;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === '---') return false;
        if (MARKER.test(lines[i])) return true;
    }
    return false;
}

const trimBlankEnds = (lines: string[]): string[] => {
    let a = 0, b = lines.length;
    while (a < b && !lines[a].trim()) a++;
    while (b > a && !lines[b - 1].trim()) b--;
    return lines.slice(a, b);
};

const nextNonBlank = (lines: string[], from: number): string | undefined => {
    for (let i = from; i < lines.length; i++) if (lines[i].trim()) return lines[i];
    return undefined;
};

function parseColumn(title: string, lines: string[]): Column {
    const column: Column = { title, intro: [], cards: [], outro: [] };
    let current: Card | null = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const m = CARD.exec(line);
        if (m && !INDENTED.test(line)) {
            current = { done: m[1] === undefined ? null : m[1] !== ' ', text: m[2], notes: [] };
            column.cards.push(current);
        } else if (current && INDENTED.test(line)) {
            current.notes.push(line.replace(/^( {2}|\t)/, ''));
        } else if (!line.trim()) {
            // Baris kosong di tengah catatan kartu dipertahankan; selainnya hanya pemisah.
            if (current && INDENTED.test(nextNonBlank(lines, i + 1) ?? '')) current.notes.push('');
        } else {
            current = null;
            (column.cards.length ? column.outro : column.intro).push(line);
        }
    }
    return column;
}

export function parseBoard(text: string): Board {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const footerAt = lines.findIndex(l => FOOTER.test(l));
    const body = footerAt >= 0 ? lines.slice(0, footerAt) : lines;
    const footer = footerAt >= 0 ? trimBlankEnds(lines.slice(footerAt)) : [];

    const firstColumn = body.findIndex(l => COLUMN.test(l));
    const head = trimBlankEnds(firstColumn >= 0 ? body.slice(0, firstColumn) : body);
    const columns: Column[] = [];
    if (firstColumn >= 0) {
        let start = firstColumn;
        for (let i = firstColumn + 1; i <= body.length; i++) {
            if (i < body.length && !COLUMN.test(body[i])) continue;
            columns.push(parseColumn(COLUMN.exec(body[start])![1], body.slice(start + 1, i)));
            start = i;
        }
    }
    return { head, columns, footer };
}

// ---------- Menulis ----------

export function serializeBoard(board: Board): string {
    const out: string[] = [...(board.head.length ? board.head : DEFAULT_HEAD), ''];
    for (const column of board.columns) {
        out.push(`## ${column.title}`, '');
        if (column.intro.length) out.push(...column.intro, '');
        for (const card of column.cards) {
            const box = card.done === null ? '' : card.done ? '[x] ' : '[ ] ';
            out.push(`- ${box}${card.text}`, ...card.notes.map(n => (n ? `  ${n}` : '')));
        }
        if (column.cards.length) out.push('');
        if (column.outro.length) out.push(...column.outro, '');
    }
    if (board.footer.length) out.push(...board.footer, '');
    return `${trimBlankEnds(out).join('\n')}\n`;
}

// Papan baru dengan daftar-daftar kosong.
export function newBoard(titles: string[] = ['Rencana', 'Dikerjakan', 'Selesai']): Board {
    return { head: [...DEFAULT_HEAD], columns: titles.map(title => ({ title, intro: [], cards: [], outro: [] })), footer: [] };
}

export const countCards = (board: Board): number => board.columns.reduce((n, c) => n + c.cards.length, 0);

// ---------- Operasi ----------

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

function withColumn(board: Board, column: number, change: (c: Column) => Column): Board {
    return { ...board, columns: board.columns.map((c, i) => (i === column ? change(c) : c)) };
}

// Sisipkan kartu di `index` (default: paling bawah).
export function addCard(board: Board, column: number, text: string, index = Infinity): Board {
    const title = text.trim();
    if (!title) return board;
    return withColumn(board, column, c => {
        const cards = [...c.cards];
        cards.splice(clamp(index, 0, cards.length), 0, { done: false, text: title, notes: [] });
        return { ...c, cards };
    });
}

export function updateCard(board: Board, at: Position, patch: Partial<Card>): Board {
    return withColumn(board, at.column, c => ({ ...c, cards: c.cards.map((card, i) => (i === at.index ? { ...card, ...patch } : card)) }));
}

// Kartu biasa ("- teks") menjadi selesai pada pergantian pertama.
export const toggleDone = (board: Board, at: Position): Board =>
    updateCard(board, at, { done: board.columns[at.column]?.cards[at.index]?.done !== true });

export function deleteCard(board: Board, at: Position): Board {
    return withColumn(board, at.column, c => ({ ...c, cards: c.cards.filter((_, i) => i !== at.index) }));
}

// Pindahkan kartu. to.index adalah posisi akhir kartu di daftar tujuan (setelah kartu
// dicabut dari daftar asal), sehingga memindahkan ke bawah di daftar yang sama tidak
// perlu penyesuaian khusus.
export function moveCard(board: Board, from: Position, to: Position): Board {
    const card = board.columns[from.column]?.cards[from.index];
    if (!card || !board.columns[to.column]) return board;
    const removed = deleteCard(board, from);
    return withColumn(removed, to.column, c => {
        const cards = [...c.cards];
        cards.splice(clamp(to.index, 0, cards.length), 0, card);
        return { ...c, cards };
    });
}

export function addColumn(board: Board, title: string, index = Infinity): Board {
    const name = title.trim();
    if (!name) return board;
    const columns = [...board.columns];
    columns.splice(clamp(index, 0, columns.length), 0, { title: name, intro: [], cards: [], outro: [] });
    return { ...board, columns };
}

export function renameColumn(board: Board, column: number, title: string): Board {
    const name = title.trim();
    return name ? withColumn(board, column, c => ({ ...c, title: name })) : board;
}

export const deleteColumn = (board: Board, column: number): Board =>
    ({ ...board, columns: board.columns.filter((_, i) => i !== column) });

export function moveColumn(board: Board, from: number, to: number): Board {
    const column = board.columns[from];
    if (!column) return board;
    const columns = board.columns.filter((_, i) => i !== from);
    columns.splice(clamp(to, 0, columns.length), 0, column);
    return { ...board, columns };
}

// ---------- Isi kartu ----------

export interface CardMeta {
    title: string;         // teks tanpa #tag, @{tanggal}, dan @penugasan, untuk ditampilkan
    tags: string[];
    due: string | null;    // "YYYY-MM-DD"
    agent: string | null;  // harness yang ditugasi ("@pi" → "pi"); yang pertama bila lebih dari satu
}

const TAG = /(^|\s)#([\p{L}\p{N}_/-]+)/gu;
const DUE = /\s*@\{(\d{4}-\d{2}-\d{2})(?:[ T]\d{1,2}:\d{2})?\}/;
// Harus berdiri sendiri (diawali spasi), jadi alamat email dan @{tanggal} tidak ikut.
const AGENT = /(^|\s)@([a-z][a-z0-9_-]*)(?=\s|$)/g;

export function cardMeta(text: string): CardMeta {
    const tags = [...text.matchAll(TAG)].map(m => m[2]);
    const due = DUE.exec(text)?.[1] ?? null;
    const agent = [...text.matchAll(AGENT)][0]?.[2] ?? null;
    const title = text.replace(TAG, '$1').replace(DUE, '').replace(AGENT, '$1').replace(/\s{2,}/g, ' ').trim();
    return { title: title || text.trim(), tags, due, agent };
}

// Pecah teks kartu menjadi judul, tag, dan tenggat (tanggal dengan jam bila ada) untuk
// formulir sunting; composeCard menyatukannya kembali.
export interface CardParts {
    title: string;
    tags: string[];
    due: string;
    agent?: string;   // kosong = tidak ditugaskan
}

const DUE_FULL = /\s*@\{(\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?)\}/;
export const DUE_INPUT = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?$/;

export function splitCard(text: string): CardParts {
    const meta = cardMeta(text);
    return { title: meta.title, tags: meta.tags, due: DUE_FULL.exec(text)?.[1] ?? '', agent: meta.agent ?? '' };
}

export function composeCard({ title, tags, due, agent = '' }: CardParts): string {
    const tagText = tags.map(t => t.replace(/^#+/, '')).filter(Boolean).map(t => `#${t}`);
    const dueText = due.trim() ? `@{${due.trim()}}` : '';
    const name = agent.trim().replace(/^@+/, '').toLowerCase();
    const agentText = AGENT_NAME.test(name) ? `@${name}` : '';
    return [title.trim(), agentText, ...tagText, dueText].filter(Boolean).join(' ');
}

export const AGENT_NAME = /^[a-z][a-z0-9_-]*$/;

// Tugaskan kartu ke harness `agent` (ganti penugasan lama, atau hapus bila null) tanpa menyentuh bagian lain teksnya.
export function assignCard(text: string, agent: string | null): string {
    const rest = text.replace(AGENT, '$1').replace(/\s{2,}/g, ' ').trim();
    if (!agent) return rest;
    const meta = cardMeta(rest);
    // Sisipkan tepat setelah judul supaya urutannya sama dengan composeCard.
    const at = rest.indexOf(meta.title);
    return at < 0 ? `${rest} @${agent}` : `${rest.slice(0, at + meta.title.length)} @${agent}${rest.slice(at + meta.title.length)}`;
}

export type DueStatus = 'overdue' | 'today' | 'soon' | 'later';

const DAY = 24 * 60 * 60 * 1000;

// today: "YYYY-MM-DD". 'soon' = dalam dua hari ke depan.
export function dueStatus(due: string, today: string): DueStatus {
    const days = Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY);
    return days < 0 ? 'overdue' : days === 0 ? 'today' : days <= 2 ? 'soon' : 'later';
}

// ---------- Menyeret ----------

// Posisi sisip kartu yang diseret: jumlah kartu lain yang titik tengahnya di atas pointer.
export const dropIndex = (centers: number[], y: number): number => centers.filter(c => c < y).length;
