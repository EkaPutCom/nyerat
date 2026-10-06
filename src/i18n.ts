// Terjemahan antarmuka (gettext). Bahasa sumber adalah Indonesia: teks di kode dan berkas .ui
// tetap ditulis dalam bahasa Indonesia dan dibungkus _(), lalu po/*.po menerjemahkannya.
//
// Domain diikat saat modul ini dievaluasi, sebelum modul lain yang memanggil _() di tingkat atas
// (mis. label palet perintah), karena modul ES dievaluasi berurutan dari impor terdalam. Berkas
// .ui (Gtk.Template) memakai domain bawaan yang diatur textdomain() di sini.

import gettext from 'gettext';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const GETTEXT_DOMAIN = 'nyerat';

// Folder locale: terpasang = <prefix>/share/locale (bundel di <prefix>/share/nyerat), dari dist/ =
// <repo>/locale yang biasanya tidak ada sehingga teks sumber tampil apa adanya.
function localeDir(): string {
    let dir = Gio.File.new_for_uri(import.meta.url).get_parent();
    if (dir && !dir.get_child('nyerat.js').query_exists(null)) dir = dir.get_parent();   // dari dist/chunks/
    return GLib.build_filenamev([dir?.get_parent()?.get_path() ?? '.', 'locale']);
}

gettext.bindtextdomain(GETTEXT_DOMAIN, localeDir());
gettext.textdomain(GETTEXT_DOMAIN);

export const _ = (text: string): string => gettext.dgettext(GETTEXT_DOMAIN, text);
export const ngettext = (one: string, many: string, n: number): string => gettext.dngettext(GETTEXT_DOMAIN, one, many, n);
// Teks yang sama dengan arti berbeda (mis. "Buka" tombol vs judul) dibedakan dengan konteks.
export const pgettext = (context: string, text: string): string => gettext.dpgettext(GETTEXT_DOMAIN, context, text);

// Isi {nama} dalam teks terjemahan. Placeholder bernama (bukan template literal) supaya xgettext bisa
// mengambil teksnya dan penerjemah bisa mengubah urutan kata.
export const fmt = (text: string, values: Record<string, string | number>): string =>
    text.replace(/\{(\w+)\}/g, (match, key: string) => key in values ? String(values[key]) : match);
