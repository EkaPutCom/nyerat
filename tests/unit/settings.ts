// Tes pengaturan (GSettings dengan backend memori).

import { AppSettings } from '../../src/settings.js';
import { section, test, eq } from '../framework.js';

export function settingsTests(): void {
    section('Pengaturan');
    test('nilai bawaan sesuai schema', () => {
        const s = AppSettings.inMemory();
        eq(s.focus, false, 'focus');
        eq(s.autosave, true, 'autosave');
        eq(s.dark, null, 'dark = ikuti sistem');
        eq(s.folder, null, 'folder');
        eq(s.tabs, [], 'tabs');
        eq(s.projects, {}, 'projects');
        eq(s.sidebarPage, 'outline', 'sidebarPage');
        eq(s.activeTab, -1, 'activeTab');
    });
    test('pengaturan ditulis lalu dibaca kembali, termasuk tipe majemuk', () => {
        const s = AppSettings.inMemory();
        s.focus = true;
        s.dark = false;
        s.folder = '/tmp/proyek';
        s.tabs = [{ file: '/tmp/a.md', cursor: 7 }, { file: '/tmp/b.md', cursor: 0 }];
        s.projects = { toko: '/tmp/toko' };
        s.sidebarPage = 'history';
        eq(s.focus, true, 'focus');
        eq(s.dark, false, 'dark');
        eq(s.folder, '/tmp/proyek', 'folder');
        eq(s.tabs, [{ file: '/tmp/a.md', cursor: 7 }, { file: '/tmp/b.md', cursor: 0 }], 'tabs');
        eq(s.projects, { toko: '/tmp/toko' }, 'projects');
        eq(s.sidebarPage, 'history', 'sidebarPage');
        s.dark = null;
        s.folder = null;
        eq(s.dark, null, 'dark kembali ke sistem');
        eq(s.folder, null, 'folder kosong');
    });
}
