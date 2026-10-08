// Header bar (Adw.HeaderBar, wrapped in Adw.Bin because that class is final): the buttons and the ☰ menu, declared in headerbar.ui. Each button/menu
// only names an action ("app.save"); the action itself is registered in actions.ts.

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
