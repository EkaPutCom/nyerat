// Warna, font, dan CSS aplikasi untuk mode terang dan gelap.
// Warna tag teks editor diatur terpisah di editor/tags.js (paintTags).

import Gtk from 'gi://Gtk?version=3.0';
import Gdk from 'gi://Gdk?version=3.0';
import { FONT_TEXT } from '../config.js';

export const PALETTES = {
    light: {
        bg: '#ffffff', fg: '#333333', heading: '#1f2328', faint: '#b4b9bf', dim: '#cdd1d5',
        accent: '#4183c4', codeBg: '#f3f4f4', codeFg: '#c7254e', quoteFg: '#6a737d',
        quoteBg: '#f7f7f9', markBg: '#fff3a3', sel: '#b3d4fc', sideBg: '#f7f7f7', sideFg: '#555555',
    },
    dark: {
        bg: '#1f2023', fg: '#d4d4d4', heading: '#f0f0f0', faint: '#5f6368', dim: '#46494e',
        accent: '#6cb6ff', codeBg: '#2b2d31', codeFg: '#f78c6c', quoteFg: '#9aa0a6',
        quoteBg: '#26282c', markBg: '#6b5a12', sel: '#264f78', sideBg: '#18191b', sideFg: '#a0a4a8',
    },
};

export const systemPrefersDark = () => /dark/i.test(Gtk.Settings.get_default().gtk_theme_name ?? '');

const buildCss = p => `
    .editor, .editor text { background-color: ${p.bg}; color: ${p.fg}; }
    .editor { font-family: ${FONT_TEXT}; font-size: 16px; caret-color: ${p.accent}; }
    .editor text selection { background-color: ${p.sel}; color: ${p.fg}; }
    .sidebar, .sidebar list, .sidebar row, .sidebar viewport { background-color: ${p.sideBg}; color: ${p.sideFg}; }
    .sidebar row { padding: 5px 0; }
    .sidebar row:hover { background-color: alpha(${p.accent}, 0.12); }
    .side-title { font-size: 11px; font-weight: bold; letter-spacing: 1px; color: ${p.faint}; }
    .image-note { color: ${p.faint}; font-style: italic; font-size: 14px; }
    .statusbar { background-color: ${p.bg}; color: ${p.faint}; font-size: 12px; padding: 4px 14px; }
`;

let provider = null;

// Pasang CSS untuk seluruh aplikasi dan beri tahu GTK tema mana yang dipakai.
// Mengembalikan palet supaya pemanggil bisa mewarnai tag editor.
export function applyTheme(dark) {
    const palette = PALETTES[dark ? 'dark' : 'light'];
    Gtk.Settings.get_default().gtk_application_prefer_dark_theme = dark;
    if (!provider) {
        provider = new Gtk.CssProvider();
        Gtk.StyleContext.add_provider_for_screen(Gdk.Screen.get_default(), provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    }
    provider.load_from_data(new TextEncoder().encode(buildCss(palette)));
    return palette;
}
