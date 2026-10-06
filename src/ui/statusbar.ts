// Bilah status di bawah editor.
//   kiri:  mode aktif
//   kanan: jumlah kata/karakter dan posisi kursor

import Gtk from 'gi://Gtk?version=4.0';
import GObject from 'gi://GObject';

import { cpLength } from '../editor/offsets.js';
import { uiTemplate } from '../gtkutil.js';
import template from './statusbar.ui?raw';
import { _, fmt } from '../i18n.js';

export class StatusBar extends Gtk.Box {
    static {
        GObject.registerClass({
            GTypeName: 'NyeratStatusBar',
            Template: uiTemplate(template),
            InternalChildren: ['left', 'right'],
        }, this);
    }
    declare _left: Gtk.Label;
    declare _right: Gtk.Label;

    private counts = '';
    private cursorText = '';
    private modes = '';

    get left(): Gtk.Label { return this._left; }
    get right(): Gtk.Label { return this._right; }

    setCounts(text: string): void {
        // Simbol Markdown tidak dihitung sebagai kata.
        const words = (text.match(/[^\s#>*_`~=|-]+/g) || []).length;
        this.setDocumentCounts(words, cpLength(text));
    }

    setDocumentCounts(words: number, characters: number): void {
        this.counts = `${words} kata   ${characters} karakter`;
        this.render();
    }

    // Ringkasan papan kanban; menggantikan hitungan kata dan posisi kursor selama papan tampil.
    setBoardCounts(lists: number, cards: number): void {
        this.counts = `${lists} daftar · ${cards} kartu`;
        this.cursorText = '';
        this.render();
    }

    setCursor(line: number, column: number): void {
        this.cursorText = fmt(_('Baris {line}, Kolom {column}'), { line: line + 1, column: column + 1 });
        this.render();
    }

    setModes(names: string[]): void {
        this.modes = names.length ? fmt(_('Mode: {modes}'), { modes: names.join(' · ') }) : '';
        this.left.label = this.modes;
    }

    private render(): void {
        this.right.label = `${this.counts}   ${this.cursorText}`;
    }
}
