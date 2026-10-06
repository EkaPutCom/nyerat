// Pengaturan pengguna di GSettings (schema: data/com.ekaput.Nyerat.gschema.xml).
//
// AppSettings hanya membungkus Gio.Settings dengan properti bertipe, jadi kode lain tetap
// menulis `settings.autosave = true`. Setiap penulisan langsung disimpan; tidak ada save().
// Dialog preferensi mengikat widgetnya ke `gsettings` yang sama, dan jendela mendengarkan
// "changed::<kunci>" untuk menerapkan perubahan itu.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { APP_ID } from './config.js';

// Tab berfile yang terbuka saat jendela terakhir ditutup, dipulihkan pada pembukaan berikutnya.
export interface SavedTab {
    file: string;
    cursor: number;          // posisi kursor (code point)
}

export type SidebarPage = 'files' | 'outline' | 'history';

// Saat dijalankan dari dist/, schema yang sudah dikompilasi ada di samping bundel (lihat vite.config.ts).
// Saat terpasang (Meson/Flatpak), schema ada di direktori schema sistem dan tidak ada salinan di samping bundel.
function loadSchema(): Gio.SettingsSchema {
    // Kode bersama dibundel ke dist/chunks/, jadi cari juga satu tingkat di atasnya.
    let folder = Gio.File.new_for_uri(import.meta.url).get_parent()!;
    if (!folder.get_child('gschemas.compiled').query_exists(null)) folder = folder.get_parent()!;
    const dir = folder.get_path()!;
    const system = Gio.SettingsSchemaSource.get_default();
    const source = folder.get_child('gschemas.compiled').query_exists(null)
        ? Gio.SettingsSchemaSource.new_from_directory(dir, system, false)
        : system;
    const schema = source?.lookup(APP_ID, true) ?? null;
    if (!schema) throw new Error(`schema ${APP_ID} tidak ditemukan di ${dir} maupun direktori schema sistem`);
    return schema;
}

export class AppSettings {
    readonly gsettings: Gio.Settings;

    // backend: tes memakai Gio.memory_settings_backend_new() supaya dconf pengguna tidak tersentuh.
    constructor(backend?: Gio.SettingsBackend) {
        this.gsettings = new Gio.Settings({ settings_schema: loadSchema(), ...(backend && { backend }) });
    }

    // null = ikuti tema sistem.
    get dark(): boolean | null {
        const scheme = this.gsettings.get_string('color-scheme');
        return scheme === 'system' ? null : scheme === 'dark';
    }
    set dark(value: boolean | null) { this.gsettings.set_string('color-scheme', value === null ? 'system' : value ? 'dark' : 'light'); }

    get sidebar(): boolean { return this.gsettings.get_boolean('sidebar'); }
    set sidebar(value: boolean) { this.gsettings.set_boolean('sidebar', value); }
    get sidebarPage(): SidebarPage { return this.gsettings.get_string('sidebar-page') as SidebarPage; }
    set sidebarPage(value: SidebarPage) { this.gsettings.set_string('sidebar-page', value); }
    get chat(): boolean { return this.gsettings.get_boolean('chat'); }
    set chat(value: boolean) { this.gsettings.set_boolean('chat', value); }
    get chatModel(): string { return this.gsettings.get_string('chat-model'); }
    set chatModel(value: string) { this.gsettings.set_string('chat-model', value); }
    get chatThinking(): boolean { return this.gsettings.get_boolean('chat-thinking'); }
    set chatThinking(value: boolean) { this.gsettings.set_boolean('chat-thinking', value); }
    get chatSave(): boolean { return this.gsettings.get_boolean('chat-save'); }
    set chatSave(value: boolean) { this.gsettings.set_boolean('chat-save', value); }
    get typewriter(): boolean { return this.gsettings.get_boolean('typewriter'); }
    set typewriter(value: boolean) { this.gsettings.set_boolean('typewriter', value); }
    get focus(): boolean { return this.gsettings.get_boolean('focus'); }
    set focus(value: boolean) { this.gsettings.set_boolean('focus', value); }
    get autosave(): boolean { return this.gsettings.get_boolean('autosave'); }
    set autosave(value: boolean) { this.gsettings.set_boolean('autosave', value); }
    get welcomed(): boolean { return this.gsettings.get_boolean('welcomed'); }
    set welcomed(value: boolean) { this.gsettings.set_boolean('welcomed', value); }
    get width(): number { return this.gsettings.get_int('width'); }
    set width(value: number) { this.gsettings.set_int('width', Math.round(value)); }
    get height(): number { return this.gsettings.get_int('height'); }
    set height(value: number) { this.gsettings.set_int('height', Math.round(value)); }
    get activeTab(): number { return this.gsettings.get_int('active-tab'); }
    set activeTab(value: number) { this.gsettings.set_int('active-tab', value); }

    // Folder terakhir; null = tidak ada.
    get folder(): string | null { return this.gsettings.get_string('folder') || null; }
    set folder(value: string | null) { this.gsettings.set_string('folder', value ?? ''); }

    get tabs(): SavedTab[] {
        return (this.gsettings.get_value('tabs').deepUnpack() as [string, number][]).map(([file, cursor]) => ({ file, cursor }));
    }
    set tabs(value: SavedTab[]) {
        this.gsettings.set_value('tabs', new GLib.Variant('a(si)', value.map(t => [t.file, t.cursor] as [string, number])));
    }

    get projects(): Record<string, string> {
        return this.gsettings.get_value('projects').deepUnpack() as Record<string, string>;
    }
    set projects(value: Record<string, string>) {
        this.gsettings.set_value('projects', new GLib.Variant('a{ss}', value));
    }

    // Pengaturan di memori dengan nilai bawaan, plus `overrides`; untuk tes, bench, dan tangkapan layar.
    static inMemory(overrides: Partial<Omit<AppSettings, 'gsettings'>> = {}): AppSettings {
        return Object.assign(new AppSettings(Gio.memory_settings_backend_new()), overrides);
    }
}
