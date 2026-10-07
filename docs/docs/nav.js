// Navigasi bersama dokumentasi: sidebar, saringan halaman, daftar isi, dan tombol sebelumnya/berikutnya.
// Tambah halaman baru cukup di PAGES; urutannya juga menentukan pager.
const PAGES = [
  ['Memulai', [
    ['index.html', 'Mulai cepat'],
    ['konsep.html', 'Konsep dasar'],
  ]],
  ['Agent', [
    ['asisten.html', 'Panel Asisten'],
    ['konteks.html', 'Konteks dan privasi'],
    ['penelusuran.html', 'Menelusuri berkas dan Git'],
    ['usulan.html', 'Usulan dan persetujuan'],
    ['pekerjaan.html', 'Rencana dan verifikasi'],
    ['riwayat.html', 'Riwayat, journal, dan log'],
    ['orkestrator.html', 'Orkestrator pi'],
  ]],
  ['Ruang kerja', [
    ['editor.html', 'Editor Markdown'],
    ['diagram.html', 'Diagram Mermaid dan DBML'],
    ['kanban.html', 'Papan kanban'],
    ['inbox.html', 'Inbox'],
    ['beranda.html', 'Beranda'],
    ['jurnal.html', 'Jurnal harian'],
    ['berkas.html', 'Berkas, tab, dan sidebar'],
    ['git.html', 'Riwayat Git'],
  ]],
  ['Referensi', [
    ['alat.html', 'Daftar alat agent'],
    ['shortcut.html', 'Shortcut'],
    ['pengaturan.html', 'Pengaturan'],
    ['keterbatasan.html', 'Keterbatasan'],
  ]],
  ['Untuk developer', [
    ['../belajar-agent.html', 'Belajar membangun agent'],
    ['../belajar-performa.html', 'Belajar performa'],
  ]],
];

const here = location.pathname.split('/').pop() || 'index.html';
const flat = PAGES.flatMap(([, items]) => items).filter(([href]) => !href.startsWith('../'));

function el(tag, attrs = {}, text) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
}

// Sidebar dan saringan
const side = document.getElementById('side');
if (side) {
  const search = el('input', { type: 'search', placeholder: 'Saring halaman…', 'aria-label': 'Saring halaman' });
  side.append(search);
  const groups = [];
  for (const [title, items] of PAGES) {
    const h = el('h4', {}, title);
    const ul = el('ul');
    for (const [href, label] of items) {
      const a = el('a', { href }, label);
      if (href === here) a.setAttribute('aria-current', 'page');
      const li = el('li');
      li.append(a);
      ul.append(li);
    }
    side.append(h, ul);
    groups.push([h, ul]);
  }
  const empty = el('p', { class: 'empty', hidden: '' }, 'Tidak ada halaman yang cocok.');
  side.append(empty);
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    let any = false;
    for (const [h, ul] of groups) {
      let shown = 0;
      for (const li of ul.children) {
        const ok = !q || li.textContent.toLowerCase().includes(q);
        li.hidden = !ok;
        if (ok) shown++;
      }
      h.hidden = ul.hidden = shown === 0;
      any ||= shown > 0;
    }
    empty.hidden = any;
  });
}

// Tombol menu di layar sempit
const menuBtn = document.querySelector('.menu-btn');
menuBtn?.addEventListener('click', () => {
  const open = document.body.classList.toggle('nav-open');
  menuBtn.setAttribute('aria-expanded', String(open));
});
side?.addEventListener('click', (e) => {
  if (e.target.closest('a')) document.body.classList.remove('nav-open');
});

// Daftar isi dari h2, dengan penanda bagian yang sedang dibaca
const toc = document.getElementById('toc');
const heads = [...document.querySelectorAll('main.doc h2')];
if (toc && heads.length > 1) {
  toc.append(el('p', {}, 'Di halaman ini'));
  const links = heads.map((h) => {
    if (!h.id) h.id = h.textContent.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const a = el('a', { href: `#${h.id}` }, h.textContent);
    toc.append(a);
    return a;
  });
  const mark = () => {
    let i = 0;
    heads.forEach((h, j) => { if (h.getBoundingClientRect().top < 120) i = j; });
    links.forEach((a, j) => a.classList.toggle('on', j === i));
  };
  addEventListener('scroll', mark, { passive: true });
  mark();
}

// Sebelumnya / berikutnya
const main = document.querySelector('main.doc');
const idx = flat.findIndex(([href]) => href === here);
if (main && idx >= 0) {
  const pager = el('nav', { class: 'pager', 'aria-label': 'Halaman sebelumnya dan berikutnya' });
  const add = (item, cls, label) => {
    if (!item) return;
    const a = el('a', { href: item[0], class: cls });
    a.append(el('small', {}, label), document.createTextNode(item[1]));
    pager.append(a);
  };
  add(flat[idx - 1], 'prev', '← Sebelumnya');
  add(flat[idx + 1], 'next', 'Berikutnya →');
  main.append(pager);
}
