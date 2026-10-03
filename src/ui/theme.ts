// Warna, font, dan CSS aplikasi untuk mode terang dan gelap.
// Warna tag teks editor diatur terpisah di editor/tags.ts (paintTags).

import Gtk from 'gi://Gtk?version=3.0';
import Gdk from 'gi://Gdk?version=3.0';
import { FONT_TEXT } from '../config.js';

export interface Palette {
    bg: string; fg: string; heading: string; faint: string; dim: string;
    accent: string; codeBg: string; codeFg: string; quoteFg: string;
    quoteBg: string; markBg: string; sel: string; sideBg: string; sideFg: string;
    codeScheme: string;  // skema warna GtkSourceView untuk isi blok kode
}

export const PALETTES: Record<'light' | 'dark', Palette> = {
    light: {
        bg: '#ffffff', fg: '#333333', heading: '#1f2328', faint: '#b4b9bf', dim: '#cdd1d5',
        accent: '#4183c4', codeBg: '#f3f4f4', codeFg: '#c7254e', quoteFg: '#6a737d',
        quoteBg: '#f7f7f9', markBg: '#fff3a3', sel: '#b3d4fc', sideBg: '#f7f7f7', sideFg: '#555555',
        codeScheme: 'tango',
    },
    dark: {
        bg: '#1f2023', fg: '#d4d4d4', heading: '#f0f0f0', faint: '#5f6368', dim: '#46494e',
        accent: '#6cb6ff', codeBg: '#2b2d31', codeFg: '#f78c6c', quoteFg: '#9aa0a6',
        quoteBg: '#26282c', markBg: '#6b5a12', sel: '#264f78', sideBg: '#18191b', sideFg: '#a0a4a8',
        codeScheme: 'cobalt',
    },
};

export const systemPrefersDark = (): boolean => /dark/i.test(Gtk.Settings.get_default()?.gtk_theme_name ?? '');

const buildCss = (p: Palette): string => `
    .editor, .editor text { background-color: ${p.bg}; color: ${p.fg}; }
    .editor { font-family: ${FONT_TEXT}; font-size: 16px; caret-color: ${p.accent}; }
    .editor text selection { background-color: ${p.sel}; color: ${p.fg}; }
    .sidebar, .sidebar list, .sidebar row, .sidebar viewport { background-color: ${p.sideBg}; color: ${p.sideFg}; }
    .sidebar row { padding: 5px 0; }
    .sidebar treeview { background-color: ${p.sideBg}; color: ${p.sideFg}; padding: 2px 0; }
    .sidebar treeview.view:selected, .sidebar treeview.view:selected:focus { background-color: alpha(${p.accent}, 0.22); background-image: none; color: ${p.fg}; }
    .sidebar row:hover { background-color: alpha(${p.accent}, 0.12); }
    .side-title { font-size: 11px; font-weight: bold; letter-spacing: 1px; color: ${p.faint}; }
    .md-table { border-top: 1px solid alpha(${p.fg}, 0.28); border-left: 1px solid alpha(${p.fg}, 0.28); }
    .md-table-cell { border-right: 1px solid alpha(${p.fg}, 0.28); border-bottom: 1px solid alpha(${p.fg}, 0.28); }
    .md-table-cell label { color: ${p.fg}; font-family: ${FONT_TEXT}; font-size: 15px; }
    .md-table-head { background-color: ${p.codeBg}; }
    .image-viewer, .image-viewer viewport { background-color: #1c1d20; }
    .image-note { color: ${p.faint}; font-style: italic; font-size: 14px; }
    .statusbar { background-color: ${p.bg}; color: ${p.faint}; font-size: 12px; padding: 4px 14px; }
`;

let provider: Gtk.CssProvider | null = null;

// Pasang CSS untuk seluruh aplikasi dan beri tahu GTK tema mana yang dipakai.
// Mengembalikan palet supaya pemanggil bisa mewarnai tag editor.
export function applyTheme(dark: boolean): Palette {
    const palette = PALETTES[dark ? 'dark' : 'light'];
    const settings = Gtk.Settings.get_default();
    if (settings) settings.gtk_application_prefer_dark_theme = dark;
    if (!provider) {
        provider = new Gtk.CssProvider();
        const screen = Gdk.Screen.get_default();
        if (screen) Gtk.StyleContext.add_provider_for_screen(screen, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    }
    provider.load_from_data(new TextEncoder().encode(buildCss(palette)));
    return palette;
}
