// Header bar (Adw.HeaderBar, dibungkus Adw.Bin karena kelas itu final): tombol-tombol dan menu ☰, dideklarasikan di headerbar.ui. Setiap tombol/menu
// hanya menyebut nama aksi ("app.save"); aksinya sendiri didaftarkan di actions.ts.

import Adw from 'gi://Adw?version=1';
import GObject from 'gi://GObject';

import { uiTemplate } from '../gtkutil.js';
import template from './headerbar.ui?raw';

export class HeaderBar extends Adw.Bin {
    static {
        GObject.registerClass({
            GTypeName: 'NyeratHeaderBar',
            Template: uiTemplate(template),
            InternalChildren: ['windowTitle'],
        }, this);
    }
    declare _windowTitle: Adw.WindowTitle;

    setTitle(title: string, subtitle: string): void {
        this._windowTitle.set_title(title);
        this._windowTitle.set_subtitle(subtitle);
    }
}
