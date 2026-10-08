// Gtk.Template files (.ui) are bundled as text through Vite.
declare module '*.ui?raw' {
    const xml: string;
    export default xml;
}
