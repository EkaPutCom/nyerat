// Tes penerjemah DBML → Mermaid.

import { section, test, eq, ok, contains } from '../framework.js';
import { dbmlToMermaid, parseDbml, DbmlError } from '../../src/markdown/dbml.js';

const SCHEMA = `// toko
Table users {
  id integer [pk, increment]
  email varchar(255) [unique, not null, note: 'surel login']
  created_at timestamp [default: \`now()\`]
  Note: 'pengguna'
  indexes {
    (id, email) [unique]
  }
}

Table orders as O {
  id int [pk]
  user_id int [not null, ref: > users.id]
  total decimal(10,2)
}

Ref: O.user_id > users.id
`;

export function dbmlTests(): void {
    section('DBML → Mermaid');
    test('tabel, kolom, dan jenisnya terbaca', () => {
        const s = parseDbml(SCHEMA);
        eq(s.tables.map(t => t.name), ['users', 'orders'], 'nama tabel');
        eq(s.tables[0].columns.map(c => [c.name, c.type]), [['id', 'integer'], ['email', 'varchar(255)'], ['created_at', 'timestamp']], 'kolom users');
        eq(s.tables[1].alias, 'O', 'alias');
        eq(s.tables[1].columns[2].type, 'decimal(10,2)', 'jenis dengan koma');
    });
    test('pengaturan kolom: pk, unique, note', () => {
        const [id, email] = parseDbml(SCHEMA).tables[0].columns;
        eq([id.pk, id.unique], [true, false], 'id');
        eq([email.unique, email.note], [true, 'surel login'], 'email');
    });
    test('ref satu baris dan ref di dalam kolom menjadi relasi', () => {
        const r = parseDbml(SCHEMA).relations;
        eq(r.map(x => [x.from, x.fromCol, x.op, x.to, x.toCol]),
            [['orders', 'user_id', '>', 'users', 'id'], ['O', 'user_id', '>', 'users', 'id']], 'relasi');
    });
    test('hasil Mermaid: entitas, kunci, komentar, dan kardinalitas', () => {
        const m = dbmlToMermaid(SCHEMA);
        contains(m, 'erDiagram');
        contains(m, '"users" {');
        contains(m, 'integer id PK');
        contains(m, 'varchar(255) email UK "surel login"');
        contains(m, 'decimal(10_2) total');
        contains(m, 'int user_id FK');
        contains(m, '"orders" }o--|| "users" : "user_id"');
        contains(m, '"orders" }o--|| "users"');   // alias O dipetakan kembali ke orders
        ok(!m.includes('"O"'), 'alias bocor ke hasil');
    });
    test('jenis relasi: < - <>', () => {
        const m = dbmlToMermaid('Table a { id int }\nTable b {\nid int\na_id int\n}\nRef: a.id < b.a_id\nRef: a.id - b.id\nRef: a.id <> b.id');
        contains(m, '"a" ||--o{ "b" : "a_id"');
        contains(m, '"a" ||--|| "b"');
        contains(m, '"a" }o--o{ "b"');
        contains(m, 'int a_id FK');
    });
    test('Ref dengan nama, blok Ref, skema, dan komentar', () => {
        const m = dbmlToMermaid('/* x */ Table public.a { id int }\nTable b { a_id int }\nRef fk_b { b.a_id > public.a.id }\nRef { public.a.id < b.a_id [delete: cascade] }');
        contains(m, '"public.a" {');
        contains(m, '"b" }o--|| "public.a" : "a_id"');
        contains(m, '"public.a" ||--o{ "b" : "a_id"');
    });
    test('Enum, TableGroup, Project, dan Note dilewati; jenis array dibaca', () => {
        const s = parseDbml("Project p { database_type: 'PostgreSQL' }\nEnum st { a\n b [note: 'x'] }\nTable t { tags text[]\n st st [not null] }\nTableGroup g { t }\nNote n { 'catatan' }");
        eq(s.tables[0].columns.map(c => c.type), ['text[]', 'st'], 'jenis kolom');
    });
    test('nama dengan spasi/tanda kutip dan atribut tak valid dibersihkan', () => {
        const m = dbmlToMermaid('Table "data pelanggan" { "nama lengkap" varchar }');
        contains(m, '"data pelanggan" {');
        contains(m, 'varchar nama_lengkap');
    });
    test('kode yang salah dilaporkan dengan nomor baris', () => {
        const fails = (src: string): number => {
            try { parseDbml(src); } catch (e) { return e instanceof DbmlError ? e.line : -1; }
            return 0;
        };
        eq(fails('Table a {\n id int\n'), 2, 'tabel tidak ditutup');
        eq(fails('Table a { id int }\nfoo'), 2, 'kata kunci tidak dikenal');
        eq(fails('Table a { id int }\nRef: a.id ? b.id'), 2, 'operator tidak dikenal');
        eq(fails('Table a { id int [pk }'), 1, 'pengaturan tidak ditutup');
    });
}
