// Tes pengaturan.

import GLib from 'gi://GLib';
import { DEFAULTS, loadSettings, saveSettings } from '../../src/settings.js';
import { section, test, eq, ok, tmp } from '../framework.js';

export function settingsTests(): void {
    section('Pengaturan');
    test('pengaturan disimpan lalu dibaca kembali', () => {
        eq(loadSettings().focus, false, 'nilai bawaan');
        saveSettings({ ...DEFAULTS, focus: true });
        ok(GLib.file_test(GLib.build_filenamev([tmp, 'nyerat', 'settings.json']), GLib.FileTest.EXISTS), 'file tidak dibuat');
        eq(loadSettings().focus, true, 'nilai tersimpan');
    });
}
