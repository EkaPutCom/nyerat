// Titik awal aplikasi GTK.

import Gtk from 'gi://Gtk?version=3.0';
import Gio from 'gi://Gio';
import System from 'system';

import { APP_ID } from './config.js';
import { loadSettings, saveSettings } from './settings.js';
import { MainWindow } from './window.js';

// argv: argumen baris perintah; argumen pertama yang bukan opsi = file atau folder yang dibuka.
export function main(argv: string[]): number {
    const path = argv.find(a => !a.startsWith('-')) ?? null;
    // NON_UNIQUE: setiap perintah membuka jendela (proses) sendiri.
    const app = new Gtk.Application({ application_id: APP_ID, flags: Gio.ApplicationFlags.NON_UNIQUE });
    app.connect('activate', () => {
        const settings = loadSettings();
        new MainWindow(app, settings, path);
        saveSettings(settings);
    });
    // Argumen tidak diteruskan ke GApplication; path sudah dibaca di atas.
    return app.run([System.programInvocationName]);
}
