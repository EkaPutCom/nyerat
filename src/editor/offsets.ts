// GtkTextIter menghitung posisi per karakter Unicode (code point), sedangkan
// string JavaScript menghitung per unit UTF-16. Emoji seperti 🎉 = 1 karakter
// di GTK tetapi 2 unit di JavaScript, jadi posisi perlu dikonversi.

// Mengembalikan fungsi: offset UTF-16 → offset code point.
export function makeCpMap(text: string): (offset: number) => number {
    if (!/[\uD800-\uDFFF]/.test(text)) return x => x;
    const map = new Int32Array(text.length + 1);
    let cp = 0;
    for (let i = 0; i < text.length; i++) {
        map[i] = cp;
        const c = text.charCodeAt(i);
        if (c >= 0xD800 && c <= 0xDBFF && i + 1 < text.length) map[++i] = cp;
        cp++;
    }
    map[text.length] = cp;
    return x => map[x];
}

// Offset code point → offset UTF-16 di dalam string s.
export const cpToU16 = (s: string, cp: number): number => Array.from(s).slice(0, cp).join('').length;

// Panjang string dalam code point (satuan yang dipakai GtkTextBuffer).
export const cpLength = (s: string): number => Array.from(s).length;
