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
    columnBg: string;    // latar daftar di papan kanban
    dark: boolean;
}

export const PALETTES: Record<'light' | 'dark', Palette> = {
    light: {
        bg: '#ffffff', fg: '#333333', heading: '#1f2328', faint: '#b4b9bf', dim: '#cdd1d5',
        accent: '#4183c4', codeBg: '#f3f4f4', codeFg: '#c7254e', quoteFg: '#6a737d',
        quoteBg: '#f7f7f9', markBg: '#fff3a3', sel: '#b3d4fc', sideBg: '#f7f7f7', sideFg: '#555555',
        codeScheme: 'tango',
        columnBg: '#e9ebef',
        dark: false,
    },
    dark: {
        bg: '#1f2023', fg: '#d4d4d4', heading: '#f0f0f0', faint: '#5f6368', dim: '#46494e',
        accent: '#6cb6ff', codeBg: '#2b2d31', codeFg: '#f78c6c', quoteFg: '#9aa0a6',
        quoteBg: '#26282c', markBg: '#6b5a12', sel: '#264f78', sideBg: '#18191b', sideFg: '#a0a4a8',
        codeScheme: 'cobalt',
        columnBg: '#2b2d31',
        dark: true,
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
    scrolledwindow.kanban-board, scrolledwindow.kanban-board viewport.frame, scrolledwindow.kanban-board viewport, .kanban-row { background-color: ${p.sideBg}; background-image: none; }
    .kanban-row { padding: 16px; }
    .kanban-column button { color: ${p.sideFg}; }
    .kanban-column { background-color: ${p.columnBg}; border-radius: 10px; padding: 10px; }
    .kanban-column-title { font-weight: bold; font-size: 14px; color: ${p.heading}; }
    .kanban-count { color: ${p.faint}; font-size: 12px; }
    scrolledwindow.kanban-board .kanban-column scrolledwindow, scrolledwindow.kanban-board .kanban-column scrolledwindow viewport.frame,
    scrolledwindow.kanban-board .kanban-column scrolledwindow viewport, scrolledwindow.kanban-board .kanban-column scrolledwindow viewport box { background-color: transparent; background-image: none; }
    .kanban-card { background-color: ${p.bg}; border: 1px solid alpha(${p.fg}, 0.16); border-radius: 8px; padding: 8px 10px; box-shadow: 0 1px 2px alpha(#000000, 0.14); }
    .kanban-card:hover { border-color: ${p.accent}; }
    .kanban-card-text { color: ${p.fg}; font-size: 14px; }
    .kanban-card-done .kanban-card-text { color: ${p.faint}; }
    .kanban-placeholder { background-color: alpha(${p.accent}, 0.16); border: 2px dashed ${p.accent}; border-radius: 8px; }
    .kanban-add { color: ${p.sideFg}; }
    .kanban-add-list { background-color: alpha(${p.fg}, 0.05); border-radius: 10px; padding: 6px; }
    .kanban-chip { border-radius: 9px; padding: 0 8px; font-size: 11px; color: #ffffff; background-color: #6b7280; }
    .kanban-notes { background-color: transparent; color: ${p.faint}; padding: 0 2px; }
    .kanban-due { background-color: alpha(${p.fg}, 0.12); color: ${p.fg}; }
    .kanban-due-overdue { background-color: #c9372c; color: #ffffff; }
    .kanban-due-today { background-color: #b7791f; color: #ffffff; }
    .kanban-due-soon { background-color: #d9a406; color: #1f2328; }
    .kanban-tag-0 { background-color: #4c9a6a; } .kanban-tag-1 { background-color: #3b7dd8; }
    .kanban-tag-2 { background-color: #8e5bd6; } .kanban-tag-3 { background-color: #d6602e; }
    .kanban-tag-4 { background-color: #c2417a; } .kanban-tag-5 { background-color: #2f8f99; }
    .kanban-tag-6 { background-color: #8a7a1c; } .kanban-tag-7 { background-color: #5e6c84; }
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
