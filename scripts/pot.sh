#!/bin/sh
# Buat po/nyerat.pot dari berkas di po/POTFILES.in (npm run pot).
#
# xgettext baru mengenal TypeScript sejak gettext 0.23; versi lebih lama (mis. 0.21 di Ubuntu 24.04)
# membaca .ts sebagai JavaScript, yang cukup karena teks dibungkus _(), pgettext(), atau ngettext().
# Berkas .ui dibaca sebagai Glade, sisanya (desktop, metainfo, schema) lewat aturan ITS bawaan xgettext.
set -eu
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
files=$(grep -v '^#' po/POTFILES.in | grep -v '^$')
common="--from-code=UTF-8 --add-comments=Penerjemah: --package-name=nyerat --msgid-bugs-address=https://nyerat.ekaput.com/"
xgettext $common -L JavaScript --keyword=_ --keyword=pgettext:1c,2 --keyword=ngettext:1,2 -o "$tmp/ts.pot" $(echo "$files" | grep '\.ts$')
xgettext $common -L Glade -o "$tmp/ui.pot" $(echo "$files" | grep '\.ui$')
xgettext $common -o "$tmp/data.pot" $(echo "$files" | grep -E '\.(desktop\.in|metainfo\.xml\.in|gschema\.xml)$')
msgcat --use-first -o po/nyerat.pot "$tmp"/*.pot
echo "po/nyerat.pot: $(grep -c '^msgid ' po/nyerat.pot) teks"
