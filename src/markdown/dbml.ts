// Penerjemah DBML (bahasa skema dbdiagram.io) ke diagram ER Mermaid.
//
// Diagramnya digambar oleh Mermaid (lihat editor/mermaidrender.ts), jadi di sini hanya
// ada penguraian DBML dan penulisan ulang sebagai `erDiagram`. Yang didukung: Table
// (alias, pengaturan kolom pk/unique/not null/note/ref, indexes, Note), Ref (satu baris
// dan blok, relasi > < - <>), dan Enum/TableGroup/Project yang dilewati. Tanpa GTK.
//
// Galat sintaks dilempar sebagai DbmlError berisi nomor baris.

export class DbmlError extends Error {
    constructor(message: string, readonly line: number) {
        super(`${message} (baris ${line})`);
    }
}

type Kind = 'word' | 'str' | 'punct' | 'expr';
interface Token { kind: Kind; text: string; line: number }

// ---------- Tokenizer ----------

function tokenize(src: string): Token[] {
    const tokens: Token[] = [];
    let line = 1, i = 0;
    const push = (kind: Kind, text: string, at: number) => tokens.push({ kind, text, line: at });
    while (i < src.length) {
        const c = src[i];
        if (c === '\n') { line++; i++; continue; }
        if (/\s/.test(c)) { i++; continue; }
        if (src.startsWith('//', i)) { while (i < src.length && src[i] !== '\n') i++; continue; }
        if (src.startsWith('/*', i)) {
            const end = src.indexOf('*/', i + 2);
            if (end < 0) throw new DbmlError('Komentar /* tidak ditutup', line);
            for (const ch of src.slice(i, end)) if (ch === '\n') line++;
            i = end + 2;
            continue;
        }
        if (src.startsWith("'''", i)) {
            const end = src.indexOf("'''", i + 3);
            if (end < 0) throw new DbmlError("Teks ''' tidak ditutup", line);
            const text = src.slice(i + 3, end), at = line;
            for (const ch of text) if (ch === '\n') line++;
            push('str', text, at);
            i = end + 3;
            continue;
        }
        if (c === "'" || c === '"' || c === '`') {
            let j = i + 1, text = '';
            while (j < src.length && src[j] !== c && src[j] !== '\n') {
                if (src[j] === '\\' && j + 1 < src.length) j++;
                text += src[j++];
            }
            if (src[j] !== c) throw new DbmlError('Tanda kutip tidak ditutup', line);
            // "nama" adalah pengenal; 'teks' adalah string; `ekspresi` adalah ekspresi.
            push(c === '"' ? 'word' : c === "'" ? 'str' : 'expr', text, line);
            i = j + 1;
            continue;
        }
        if (src.startsWith('<>', i)) { push('punct', '<>', line); i += 2; continue; }
        if (/[{}[\](),:.<>\-]/.test(c)) { push('punct', c, line); i++; continue; }
        const m = /^[^\s{}[\](),:.<>'"`\-/]+/.exec(src.slice(i));
        if (!m) throw new DbmlError(`Karakter tidak dikenali: ${c}`, line);
        push('word', m[0], line);
        i += m[0].length;
    }
    return tokens;
}

// ---------- Model ----------

interface Column { name: string; type: string; pk: boolean; unique: boolean; fk: boolean; note: string }
interface Table { name: string; alias: string | null; columns: Column[] }
interface Relation { from: string; fromCol: string; op: string; to: string; toCol: string }

export interface Schema { tables: Table[]; relations: Relation[] }

// ---------- Parser ----------

class Parser {
    private p = 0;
    readonly schema: Schema = { tables: [], relations: [] };

    constructor(private readonly t: Token[]) {}

    private get cur(): Token | undefined { return this.t[this.p]; }
    private get line(): number { return (this.cur ?? this.t[this.t.length - 1])?.line ?? 1; }
    private is(text: string): boolean { const c = this.cur; return !!c && c.kind !== 'str' && c.text.toLowerCase() === text; }
    private punct(text: string): boolean { const c = this.cur; return !!c && c.kind === 'punct' && c.text === text; }

    private expect(text: string): void {
        if (!this.punct(text)) throw new DbmlError(`Seharusnya "${text}", ditemukan ${this.cur ? `"${this.cur.text}"` : 'akhir kode'}`, this.line);
        this.p++;
    }

    private word(what: string): string {
        const c = this.cur;
        if (!c || c.kind === 'punct' || c.kind === 'str') throw new DbmlError(`Seharusnya ${what}`, this.line);
        this.p++;
        return c.text;
    }

    parse(): Schema {
        while (this.cur) {
            const kw = this.word('kata kunci').toLowerCase();
            if (kw === 'table') this.table();
            else if (kw === 'ref') this.ref();
            else if (kw === 'enum' || kw === 'tablegroup' || kw === 'project' || kw === 'tablepartial') this.skipBlock();
            else if (kw === 'note') this.skipNote();
            else throw new DbmlError(`Tidak dikenali: ${kw}`, this.t[this.p - 1].line);
        }
        return this.schema;
    }

    // Lewati sampai "{" lalu seluruh isinya (kurung kurawal bersarang).
    private skipBlock(): void {
        while (this.cur && !this.punct('{')) this.p++;
        this.expect('{');
        for (let depth = 1; depth > 0; this.p++) {
            if (!this.cur) throw new DbmlError('Blok tidak ditutup dengan "}"', this.line);
            if (this.punct('{')) depth++;
            else if (this.punct('}')) depth--;
        }
    }

    // Note: 'teks'   atau   Note { 'teks' }   atau   Note nama { 'teks' }
    private skipNote(): string {
        if (this.punct(':')) {
            this.p++;
            return this.str();
        }
        if (!this.punct('{')) this.word('nama note');   // Note nama { ... } di tingkat atas
        this.expect('{');
        const text = this.str();
        this.expect('}');
        return text;
    }

    private str(): string {
        const c = this.cur;
        if (!c || c.kind !== 'str') throw new DbmlError('Seharusnya teks dalam tanda kutip', this.line);
        this.p++;
        return c.text;
    }

    // schema.tabel.kolom → ['schema.tabel', 'kolom']; "(a, b)" di ujung berarti kolom gabungan.
    private endpoint(): [string, string] {
        const parts = [this.word('nama tabel')];
        let col = '';
        while (this.punct('.')) {
            this.p++;
            if (this.punct('(')) { col = this.columnList(); break; }
            parts.push(this.word('nama kolom'));
        }
        if (!col) col = parts.length > 1 ? parts.pop()! : '';
        return [parts.join('.'), col];
    }

    private columnList(): string {
        this.expect('(');
        const names = [this.word('nama kolom')];
        while (this.punct(',')) { this.p++; names.push(this.word('nama kolom')); }
        this.expect(')');
        return names.join(', ');
    }

    private operator(): string {
        const c = this.cur;
        if (c && c.kind === 'punct' && ['>', '<', '-', '<>'].includes(c.text)) { this.p++; return c.text; }
        throw new DbmlError('Seharusnya jenis relasi (>, <, - atau <>)', this.line);
    }

    // Ref: a.x > b.y   atau   Ref nama: ...   atau   Ref { ... }
    private ref(): void {
        if (!this.punct(':') && !this.punct('{')) this.word('nama ref');
        if (this.punct(':')) {
            this.p++;
            this.relation();
            return;
        }
        this.expect('{');
        while (!this.punct('}')) {
            if (!this.cur) throw new DbmlError('Blok Ref tidak ditutup dengan "}"', this.line);
            this.relation();
        }
        this.p++;
    }

    private relation(): void {
        // Kolom gabungan di sisi kiri ditulis "a.(x, y)" dan ditangani endpoint().
        const [from, fromCol] = this.endpoint();
        const op = this.operator();
        const [to, toCol] = this.endpoint();
        this.addRelation({ from, fromCol, op, to, toCol });
        // Pengaturan relasi ([delete: cascade]) tidak mengubah diagram.
        if (this.punct('[')) this.settings();
    }

    private addRelation(r: Relation): void {
        this.schema.relations.push(r);
    }

    // Isi [ ... ] dipecah di koma tingkat atas; tiap butir berupa deretan token.
    private settings(): Token[][] {
        this.expect('[');
        const items: Token[][] = [[]];
        for (let depth = 0; ; this.p++) {
            const c = this.cur;
            if (!c) throw new DbmlError('Pengaturan "[" tidak ditutup dengan "]"', this.line);
            if (c.kind === 'punct') {
                if (c.text === '(' || c.text === '[') depth++;
                else if (c.text === ')' || (c.text === ']' && depth > 0)) depth--;
                else if (c.text === ']') break;
                else if (c.text === ',' && depth === 0) { items.push([]); continue; }
            }
            items[items.length - 1].push(c);
        }
        this.p++;
        return items.filter(i => i.length);
    }

    private table(): void {
        const parts = [this.word('nama tabel')];
        while (this.punct('.')) { this.p++; parts.push(this.word('nama tabel')); }
        const table: Table = { name: parts.join('.'), alias: null, columns: [] };
        if (this.is('as')) { this.p++; table.alias = this.word('alias'); }
        if (this.punct('[')) this.settings();
        this.expect('{');
        while (!this.punct('}')) {
            if (!this.cur) throw new DbmlError(`Tabel ${table.name} tidak ditutup dengan "}"`, this.line);
            if (this.is('note') && this.t[this.p + 1] && ['{', ':'].includes(this.t[this.p + 1].text)) { this.p++; this.skipNote(); }
            else if (this.is('indexes') && this.t[this.p + 1]?.text === '{') { this.p++; this.skipBlock(); }
            else this.column(table);
        }
        this.p++;
        this.schema.tables.push(table);
    }

    private column(table: Table): void {
        const name = this.word('nama kolom');
        const type = this.type();
        const col: Column = { name, type, pk: false, unique: false, fk: false, note: '' };
        table.columns.push(col);
        // Pengaturan kolom hanya dibaca bila "[" masih di baris yang sama dengan jenisnya.
        while (this.punct('[') && this.cur!.line === this.t[this.p - 1].line) {
            for (const item of this.settings()) this.columnSetting(table, col, item);
        }
    }

    // varchar(255), decimal(10,2), schema.tipe, int[] (kurung siku kosong menempel).
    private type(): string {
        let type = this.word('jenis kolom');
        while (this.punct('.')) { this.p++; type += `.${this.word('jenis kolom')}`; }
        if (this.punct('(')) {
            let depth = 0, args = '';
            do {
                const c = this.cur;
                if (!c) throw new DbmlError('Tanda kurung pada jenis kolom tidak ditutup', this.line);
                if (c.text === '(' && c.kind === 'punct') depth++;
                else if (c.text === ')' && c.kind === 'punct') depth--;
                args += c.text;
                this.p++;
            } while (depth > 0);
            type += args;
        }
        while (this.punct('[') && this.t[this.p + 1]?.text === ']') { this.p += 2; type += '[]'; }
        return type;
    }

    private columnSetting(table: Table, col: Column, item: Token[]): void {
        const head = item[0].text.toLowerCase();
        if (item[0].kind === 'punct') return;
        if (head === 'pk' || (head === 'primary' && item[1]?.text.toLowerCase() === 'key')) col.pk = true;
        else if (head === 'unique') col.unique = true;
        else if (head === 'note' && item[2]?.kind === 'str') col.note = item[2].text;
        else if (head === 'ref' && item[1]?.text === ':') {
            const sub = new Parser(item.slice(2));
            const op = sub.operator();
            const [to, toCol] = sub.endpoint();
            this.addRelation({ from: table.name, fromCol: col.name, op, to, toCol });
        }
    }
}

export function parseDbml(src: string): Schema {
    return new Parser(tokenize(src)).parse();
}

// ---------- Penulisan ulang sebagai Mermaid ----------

const CARDINALITY: Record<string, string> = {
    '>': '}o--||',    // banyak ke satu
    '<': '||--o{',    // satu ke banyak
    '-': '||--||',
    '<>': '}o--o{',
};

const quote = (s: string): string => `"${s.replace(/"/g, "'")}"`;
// Nama atribut dan jenis di Mermaid tidak boleh berisi spasi atau koma.
const ident = (s: string): string => s.replace(/[^\w\-[\]()]/g, '_') || '_';

export function dbmlToMermaid(src: string): string {
    const schema = parseDbml(src);
    const alias = new Map<string, string>();
    for (const t of schema.tables) if (t.alias) alias.set(t.alias, t.name);
    const resolve = (name: string): string => alias.get(name) ?? name;

    // Kolom di sisi "banyak" suatu relasi adalah kunci asing.
    const byName = new Map(schema.tables.map(t => [t.name, t]));
    const mark = (table: string, col: string): void => {
        const c = byName.get(resolve(table))?.columns.find(c => c.name === col);
        if (c) c.fk = true;
    };
    for (const r of schema.relations) {
        if (r.op === '>') mark(r.from, r.fromCol);
        else if (r.op === '<') mark(r.to, r.toCol);
    }

    const out = ['erDiagram'];
    for (const t of schema.tables) {
        out.push(`    ${quote(t.name)} {`);
        for (const c of t.columns) {
            const keys = [c.pk ? 'PK' : '', c.fk ? 'FK' : '', c.unique && !c.pk ? 'UK' : ''].filter(Boolean).join(', ');
            out.push(`        ${ident(c.type)} ${ident(c.name)}${keys ? ` ${keys}` : ''}${c.note ? ` ${quote(c.note.replace(/\s+/g, ' '))}` : ''}`);
        }
        out.push('    }');
    }
    for (const r of schema.relations) {
        const label = r.op === '<' ? r.toCol : r.fromCol;
        out.push(`    ${quote(resolve(r.from))} ${CARDINALITY[r.op]} ${quote(resolve(r.to))} : ${quote(label || ' ')}`);
    }
    return out.join('\n');
}
