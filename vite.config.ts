// Vite dipakai sebagai bundler saja (mode library): TypeScript → JavaScript, semua
// modul digabung menjadi file ESM yang dijalankan GJS. Dev server dan HMR tidak
// dipakai karena ini aplikasi GTK, bukan halaman web.

import { copyFileSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { defineConfig, type Plugin } from 'vite';

// Mermaid dijalankan di WebKitGTK (lihat src/editor/mermaid.ts), jadi yang dibutuhkan
// adalah file skrip browsernya, bukan modul yang dibundel ke dalam kode GJS.
const copyMermaid = (): Plugin => ({
    name: 'copy-mermaid',
    writeBundle(options) {
        copyFileSync('node_modules/mermaid/dist/mermaid.min.js', `${options.dir ?? 'dist'}/mermaid.min.js`);
    },
});

// Schema GSettings dikompilasi ke dist/, tempat settings.ts mencarinya saat runtime.
const compileSchemas = (): Plugin => ({
    name: 'compile-gschemas',
    writeBundle(options) {
        const dir = options.dir ?? 'dist';
        copyFileSync('data/com.ekaput.Nyerat.gschema.xml', `${dir}/com.ekaput.Nyerat.gschema.xml`);
        execFileSync('glib-compile-schemas', ['--strict', dir]);
    },
});

// Ikon aplikasi disalin ke dist/icons supaya `npm start` tetap menampilkan ikon tanpa dipasang;
// app.ts menambahkannya ke jalur pencarian tema ikon. Versi terpasang memakai hicolor sistem.
const copyIcons = (): Plugin => ({
    name: 'copy-icons',
    writeBundle(options) {
        cpSync('data/icons', `${options.dir ?? 'dist'}/icons`, { recursive: true });
    },
});

export default defineConfig({
    plugins: [copyMermaid(), compileSchemas(), copyIcons()],
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        // GJS 1.80 memakai SpiderMonkey 115 (setara Firefox 115).
        target: 'firefox115',
        minify: false,
        sourcemap: false,
        lib: {
            entry: {
                nyerat: 'src/main.ts',
                'run-tests': 'tests/run-tests.ts',
                capture: 'scripts/capture.ts',
                bench: 'tests/bench.ts',
                'bench-agentic': 'tests/bench-agentic.ts',
                'live-test': 'tests/live.ts',
            },
            formats: ['es'],
            fileName: (_format, name) => `${name}.js`,
        },
        rollupOptions: {
            // Modul bawaan GJS: disediakan saat runtime, bukan dari node_modules.
            external: [/^gi:\/\//, 'system', 'gettext', 'cairo', 'console'],
            output: {
                chunkFileNames: 'chunks/[name].js',
            },
        },
    },
});
