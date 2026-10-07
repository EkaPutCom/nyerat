// Warna, font, dan CSS aplikasi untuk mode terang dan gelap.
// Warna tag teks editor diatur terpisah di editor/tags.ts (paintTags).

import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import { FONT_MONO, FONT_TEXT } from '../config.js';

export interface Palette {
    bg: string; fg: string; heading: string; faint: string; dim: string;
    accent: string; codeBg: string; codeFg: string; quoteFg: string;
    quoteBg: string; markBg: string; sel: string; sideBg: string;
    codeScheme: string;  // skema warna GtkSourceView untuk isi blok kode
    columnBg: string;    // latar daftar di papan kanban
    dark: boolean;
}

export const PALETTES: Record<'light' | 'dark', Palette> = {
    light: {
        bg: '#ffffff', fg: '#333333', heading: '#1f2328', faint: '#b4b9bf', dim: '#cdd1d5',
        accent: '#1c71d8', codeBg: '#f3f4f4', codeFg: '#c7254e', quoteFg: '#6a737d',
        quoteBg: '#f7f7f9', markBg: '#fff3a3', sel: '#b3d4fc', sideBg: '#f7f7f7',
        codeScheme: 'tango',
        columnBg: '#e9ebef',
        dark: false,
    },
    dark: {
        bg: '#1e1e1e', fg: '#d4d4d4', heading: '#f0f0f0', faint: '#5f6368', dim: '#46494e',
        accent: '#78aeed', codeBg: '#2b2d31', codeFg: '#f78c6c', quoteFg: '#9aa0a6',
        quoteBg: '#26282c', markBg: '#6b5a12', sel: '#264f78', sideBg: '#18191b',
        codeScheme: 'cobalt',
        columnBg: '#2b2d31',
        dark: true,
    },
};

// Pilihan gelap/terang dari pengaturan sistem (GNOME: Gaya Gelap), sebelum aplikasi memaksa salah satunya.
export const systemPrefersDark = (): boolean => Adw.StyleManager.get_default().dark;

// Warna permukaan dokumen (editor, tabel, tag teks) tetap dari palet karena tag GtkTextTag dan render
// diagram butuh nilai warna nyata, dan tag `hidden` harus persis sama dengan latar editor. Selebihnya
// (sidebar, panel asisten, papan, status bar, warna status) memakai warna bernama Adwaita, sehingga
// ikut aksen sistem dan mode kontras tinggi tanpa CSS tambahan.
const buildCss = (p: Palette): string => `
    .editor, .editor text { background-color: ${p.bg}; color: ${p.fg}; }
    .editor { font-family: ${FONT_TEXT}; font-size: 16px; caret-color: ${p.accent}; }
    .editor text selection { background-color: ${p.sel}; color: ${p.fg}; }
    .sidebar { background-color: @sidebar_bg_color; color: @sidebar_fg_color; }
    .side-title { font-size: 11px; font-weight: bold; letter-spacing: 1px; color: alpha(currentColor, 0.55); }
    .side-drop { background-color: alpha(@accent_bg_color, 0.25); }
    .sidebar-tabs button { padding: 3px 6px; min-width: 0; font-size: 12px; }
    .side-meta { font-size: 11px; color: alpha(currentColor, 0.55); }
    .chat-input, .chat-input text { background-color: @view_bg_color; color: @view_fg_color; font-size: 13px; }
    .chat-composer { background-color: @view_bg_color; border: 1px solid alpha(currentColor, 0.15); border-radius: 12px; }
    .chat-composer:focus-within { outline: 2px solid alpha(@accent_color, 0.5); outline-offset: -1px; }
    .chat-user { background-color: alpha(@accent_bg_color, 0.16); border-radius: 10px; padding: 8px 10px; font-size: 13px; }
    .chat-assistant { font-size: 13px; }
    .chat-thinking { color: alpha(currentColor, 0.55); font-size: 12px; font-style: italic; }
    /* Popover memakai latar tema GTK, bukan latar sidebar: warna redup sidebar jadi tak terbaca di sana. */
    .chat-pop label { color: @popover_fg_color; }
    .chat-pop label.side-title, .chat-pop label.side-meta { opacity: 0.7; }
    .chat-work { font-size: 13px; }
    .chat-work-goal { font-weight: bold; }
    .work-done { background-color: @success_bg_color; color: @success_fg_color; border-radius: 50%; min-width: 16px; min-height: 16px; }
    .work-pending { border: 1.5px solid alpha(currentColor, 0.45); border-radius: 50%; min-width: 13px; min-height: 13px; margin: 1px; }
    .work-blocked { color: @warning_color; }
    .work-step-done { color: alpha(currentColor, 0.7); }
    .chat-step { color: alpha(currentColor, 0.55); font-size: 12px; }
    .chat-proposal { background-color: @card_bg_color; color: @card_fg_color; border-radius: 8px; padding: 8px 10px; font-size: 13px; }
    .chat-diff { font-family: monospace; font-size: 12px; }
    .chat-error { color: @error_color; font-size: 12px; }
    .history-text, .history-text text { background-color: @view_bg_color; color: @view_fg_color; font-size: 13px; }
    .md-table { border-top: 1px solid alpha(${p.fg}, 0.28); border-left: 1px solid alpha(${p.fg}, 0.28); }
    .md-table-cell { border-right: 1px solid alpha(${p.fg}, 0.28); border-bottom: 1px solid alpha(${p.fg}, 0.28); }
    .md-table-cell label { color: ${p.fg}; font-family: ${FONT_TEXT}; font-size: 15px; }
    .md-codeblock { background-color: ${p.codeBg}; border-radius: 6px; }
    .md-codeblock label { color: ${p.fg}; font-family: ${FONT_MONO}; font-size: 14px; }
    .md-table-head { background-color: ${p.codeBg}; }
    scrolledwindow.kanban-board, scrolledwindow.kanban-board viewport.frame, scrolledwindow.kanban-board viewport, .kanban-row { background-color: @window_bg_color; background-image: none; }
    .kanban-row { padding: 16px; }
    .kanban-column { background-color: alpha(@window_fg_color, 0.06); border-radius: 10px; padding: 10px; }
    .kanban-column-title { font-weight: bold; font-size: 14px; color: @window_fg_color; }
    .kanban-count { color: alpha(@window_fg_color, 0.5); font-size: 12px; }
    scrolledwindow.kanban-board .kanban-column scrolledwindow, scrolledwindow.kanban-board .kanban-column scrolledwindow viewport.frame,
    scrolledwindow.kanban-board .kanban-column scrolledwindow viewport, scrolledwindow.kanban-board .kanban-column scrolledwindow viewport box { background-color: transparent; background-image: none; }
    .kanban-card { background-color: @card_bg_color; color: @card_fg_color; border: 1px solid alpha(@card_fg_color, 0.12); border-radius: 8px; padding: 8px 10px; box-shadow: 0 1px 2px @shade_color; }
    .kanban-card:hover { border-color: @accent_color; }
    .kanban-card-text { font-size: 14px; }
    .kanban-card-done .kanban-card-text { color: alpha(currentColor, 0.5); }
    .kanban-placeholder { background-color: alpha(@accent_bg_color, 0.16); border: 2px dashed @accent_color; border-radius: 8px; }
    .kanban-add-list { background-color: alpha(@window_fg_color, 0.05); border-radius: 10px; padding: 6px; }
    list.inbox-list { background-color: transparent; }
    list.inbox-list > row { background-color: @card_bg_color; color: @card_fg_color; border: 1px solid alpha(@card_fg_color, 0.12); border-radius: 10px; margin-bottom: 8px; }
    list.inbox-list > row:hover { border-color: @accent_color; }
    .inbox-tag { border-radius: 9px; padding: 1px 8px; font-size: 11px; background-color: alpha(@accent_bg_color, 0.18); color: @accent_color; }
    .kanban-chip { border-radius: 9px; padding: 0 8px; font-size: 11px; color: #ffffff; background-color: #6b7280; }
    .kanban-notes { background-color: transparent; color: alpha(currentColor, 0.55); padding: 0 2px; }
    .kanban-card-text link, .kanban-note-link link { color: @accent_color; }
    .kanban-note-link { font-size: 12px; }
    .kanban-due { background-color: alpha(currentColor, 0.12); color: @card_fg_color; }
    .kanban-due-overdue { background-color: @error_bg_color; color: @error_fg_color; }
    .kanban-due-today { background-color: @warning_bg_color; color: @warning_fg_color; }
    .kanban-due-soon { background-color: alpha(@warning_bg_color, 0.45); color: @card_fg_color; }
    .kanban-tag-0 { background-color: #4c9a6a; } .kanban-tag-1 { background-color: #3b7dd8; }
    .kanban-tag-2 { background-color: #8e5bd6; } .kanban-tag-3 { background-color: #d6602e; }
    .kanban-tag-4 { background-color: #c2417a; } .kanban-tag-5 { background-color: #2f8f99; }
    .kanban-tag-6 { background-color: #8a7a1c; } .kanban-tag-7 { background-color: #5e6c84; }
    .kanban-agent { background-color: alpha(currentColor, 0.10); color: @card_fg_color; font-weight: bold; }
    .kanban-agent-queued { background-color: alpha(@warning_bg_color, 0.25); color: @card_fg_color; }
    .kanban-agent-working { background-color: @success_bg_color; color: @success_fg_color; }
    .kanban-agent-waiting { background-color: @warning_bg_color; color: @warning_fg_color; }
    .kanban-agent-done { background-color: @accent_bg_color; color: @accent_fg_color; }
    .kanban-agent-failed { background-color: @error_bg_color; color: @error_fg_color; }
    .image-viewer, .image-viewer viewport { background-color: #1c1d20; }
    .image-note { color: ${p.faint}; font-style: italic; font-size: 14px; }
    .statusbar { background-color: ${p.bg}; color: alpha(${p.fg}, 0.55); font-size: 12px; padding: 4px 14px; }
`;

let provider: Gtk.CssProvider | null = null;

// Warna aksen pilihan pengguna (libadwaita ≥ 1.6, GNOME 47+) untuk tag teks dan kursor; libadwaita
// yang lebih tua tidak punya API-nya, jadi aksen bawaan Adwaita di palet tetap dipakai.
function withSystemAccent(palette: Palette, style: Adw.StyleManager): Palette {
    const manager = style as Adw.StyleManager & { get_system_supports_accent_colors?(): boolean; get_accent_color_rgba?(): Gdk.RGBA };
    if (!manager.get_system_supports_accent_colors?.() || !manager.get_accent_color_rgba) return palette;
    const rgba = manager.get_accent_color_rgba();
    // Aksen standalone (untuk teks) berbeda dari latar aksen; di mode gelap Adwaita memakai versi yang lebih terang.
    const hex = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
    const mix = palette.dark ? 0.35 : 0;
    const lift = (v: number) => v + (1 - v) * mix;
    return { ...palette, accent: `#${hex(lift(rgba.red))}${hex(lift(rgba.green))}${hex(lift(rgba.blue))}` };
}

// Pasang CSS untuk seluruh aplikasi dan beri tahu libadwaita tema mana yang dipakai;
// null = ikuti tema sistem. Mengembalikan palet supaya pemanggil bisa mewarnai tag editor.
export function applyTheme(dark: boolean | null): Palette {
    const style = Adw.StyleManager.get_default();
    style.set_color_scheme(dark === null ? Adw.ColorScheme.DEFAULT : dark ? Adw.ColorScheme.FORCE_DARK : Adw.ColorScheme.FORCE_LIGHT);
    const palette = withSystemAccent(PALETTES[style.get_dark() ? 'dark' : 'light'], style);
    if (!provider) {
        provider = new Gtk.CssProvider();
        const display = Gdk.Display.get_default();
        if (display) Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    }
    provider.load_from_string(buildCss(palette));
    return palette;
}
