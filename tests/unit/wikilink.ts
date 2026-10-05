// Tes tautan [[catatan]] gaya Obsidian: penguraian, pencarian berkas, saran nama, penyorotan inline, dan ekspor HTML.

import { section, test, eq, ok, contains } from '../framework.js';
import { newNotePath, parseWikiLink, resolveWikiLink, suggestNotes, wikiQuery, wikiTargetFor } from '../../src/markdown/wikilink.js';
import { parseInline } from '../../src/markdown/inline.js';
import { body } from './helpers.js';

const FILES = ['Ide.md', 'Jurnal/Catatan Harian.md', 'Jurnal/Ide.md', 'proyek/rencana-buku.md', 'proyek/sub/Bab 1.markdown', 'gambar.png'];

export function wikiLinkTests(): void {
    section('Tautan [[catatan]]');
    test('isi [[...]] diurai menjadi target, bagian, dan alias', () => {
        eq(parseWikiLink('Catatan'), { target: 'Catatan', heading: '', alias: '' });
        eq(parseWikiLink('Jurnal/Ide#Bagian Dua|lihat ide'), { target: 'Jurnal/Ide', heading: 'Bagian Dua', alias: 'lihat ide' });
        eq(parseWikiLink('#Pembuka'), { target: '', heading: 'Pembuka', alias: '' });
    });
    test('target dicari menurut nama berkas tanpa ekstensi dan tanpa membedakan huruf besar', () => {
        eq(resolveWikiLink('catatan harian', FILES, null), 'Jurnal/Catatan Harian.md');
        eq(resolveWikiLink('Bab 1', FILES, null), 'proyek/sub/Bab 1.markdown');
        eq(resolveWikiLink('rencana-buku.md', FILES, null), 'proyek/rencana-buku.md');
        eq(resolveWikiLink('tidak ada', FILES, null), null);
        eq(resolveWikiLink('gambar', FILES, null), null, 'berkas bukan Markdown');
    });
    test('nama kembar: folder dokumen asal menang, lalu path terpendek; target berfolder dicocokkan dengan akhir path', () => {
        eq(resolveWikiLink('Ide', FILES, 'Jurnal/Catatan Harian.md'), 'Jurnal/Ide.md');
        eq(resolveWikiLink('Ide', FILES, 'proyek/rencana-buku.md'), 'Ide.md');
        eq(resolveWikiLink('Ide', FILES, null), 'Ide.md');
        eq(resolveWikiLink('jurnal/ide', FILES, null), 'Jurnal/Ide.md');
        eq(resolveWikiLink('sub/Bab 1', FILES, null), 'proyek/sub/Bab 1.markdown');
    });
    test('catatan baru dibuat di samping dokumen asal; nama yang keluar folder atau tersembunyi ditolak', () => {
        eq(newNotePath('Baru', 'Jurnal/Catatan Harian.md'), 'Jurnal/Baru.md');
        eq(newNotePath('Baru', null), 'Baru.md');
        eq(newNotePath('arsip/Lama', 'Jurnal/x.md'), 'arsip/Lama.md');
        eq(newNotePath('Bab.markdown', null), 'Bab.markdown');
        for (const bad of ['../luar', 'a/../b', '.rahasia', 'a//b', 'a:b', '  ']) eq(newNotePath(bad, null), null, bad);
    });
    test('saran memakai nama pendek bila unik, path bila kembar', () => {
        eq(wikiTargetFor('Jurnal/Catatan Harian.md', FILES), 'Catatan Harian');
        eq(wikiTargetFor('Jurnal/Ide.md', FILES), 'Jurnal/Ide');
    });
    test('teks yang sedang diketik setelah [[ dikenali; [[ yang sudah ditutup, alias, bagian, dan kode tidak', () => {
        eq(wikiQuery('lihat [[cat'), 'cat');
        eq(wikiQuery('lihat [['), '');
        eq(wikiQuery('lihat [[a]] lalu'), null);
        eq(wikiQuery('[[a|teks'), null);
        eq(wikiQuery('[[a#bag'), null);
        eq(wikiQuery('`kode [[x'), null);
        eq(wikiQuery('tanpa tautan'), null);
    });
    test('saran: awalan nama dulu, awalan kata, lalu potongan path; berkas bukan Markdown dilewati', () => {
        eq(suggestNotes('ide', FILES), ['Ide.md', 'Jurnal/Ide.md']);
        eq(suggestNotes('har', FILES), ['Jurnal/Catatan Harian.md']);
        eq(suggestNotes('jurnal', FILES), ['Jurnal/Catatan Harian.md', 'Jurnal/Ide.md']);
        eq(suggestNotes('', FILES).length, 5);
        eq(suggestNotes('', FILES, 2).length, 2, 'batas jumlah');
        eq(suggestNotes('zzz', FILES), []);
    });
    test('penyorotan: hanya nama atau alias yang jadi tautan, kurung dan target alias disembunyikan', () => {
        const r = parseInline('a [[Catatan]] b');
        ok(r.tags.some(([n, s, e]) => n === 'link' && s === 4 && e === 11), JSON.stringify(r.tags));
        eq(r.marks, [[2, 4], [11, 13]]);
        const alias = parseInline('[[Jurnal/Ide|ide lama]]');
        ok(alias.tags.some(([n, s, e]) => n === 'link' && s === 13 && e === 21), JSON.stringify(alias.tags));
        eq(alias.marks, [[0, 13], [21, 23]]);
    });
    test('penyorotan: [[ ]] kosong, kode inline, dan isi tautan tidak diformat lagi', () => {
        eq(parseInline('[[ ]]').tags, []);
        ok(!parseInline('`[[x]]`').tags.some(([n]) => n === 'link'), 'tautan di dalam kode');
        ok(!parseInline('[[nama_file_ini]]').tags.some(([n]) => n === 'italic'), 'garis bawah jadi miring');
        eq(parseInline('- [ ] tugas').tags, [], 'kotak tugas');
    });
    test('ekspor HTML: [[catatan]] menjadi tautan ke berkas .md', () => {
        contains(body('lihat [[Catatan Harian]]'), '<a class="wikilink" href="Catatan%20Harian.md">Catatan Harian</a>');
        contains(body('[[Jurnal/Ide#Bagian Dua|ide]]'), '<a class="wikilink" href="Jurnal/Ide.md#bagian-dua">ide</a>');
        contains(body('[[#Pembuka]]'), '<a class="wikilink" href="#pembuka">Pembuka</a>');
        contains(body('[[a<b]]'), '>a&lt;b</a>');
        contains(body('`[[x]]`'), '<code>[[x]]</code>');
    });
}
