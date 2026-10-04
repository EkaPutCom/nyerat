// Nyerat — editor Markdown AI-native dengan GTK 4 + GtkSourceView 5 (GJS).
// Titik masuk aplikasi. Build: npm run build, lalu jalankan: gjs -m dist/nyerat.js [file.md]

import System from 'system';
import { main } from './app.js';

System.exit(main(System.programArgs));
