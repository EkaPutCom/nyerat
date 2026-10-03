#!/usr/bin/env -S gjs -m
// Nyerat — editor Markdown ala Typora dengan GTK 3 + GtkSourceView 4 (GJS).
// Jalankan: gjs -m nyerat.js [file.md]
//
// File ini hanya titik masuk. Kodenya ada di src/; lihat README.md bagian Arsitektur.

import System from 'system';
import { main } from './src/app.js';

System.exit(main(System.programArgs));
