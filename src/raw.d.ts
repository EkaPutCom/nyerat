// Berkas Gtk.Template (.ui) dibundel sebagai teks lewat Vite.
declare module '*.ui?raw' {
    const xml: string;
    export default xml;
}
