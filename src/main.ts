// Nyerat — editor Markdown ala Typora dengan GTK 3 + GtkSourceView 4 (GJS).
// Titik masuk aplikasi. Build: npm run build, lalu jalankan: gjs -m dist/nyerat.js [file.md]

import System from 'system';
import { main } from './app.js';

System.exit(main(System.programArgs));
