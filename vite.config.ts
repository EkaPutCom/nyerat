// Vite dipakai sebagai bundler saja (mode library): TypeScript → JavaScript, semua
// modul digabung menjadi file ESM yang dijalankan GJS. Dev server dan HMR tidak
// dipakai karena ini aplikasi GTK, bukan halaman web.

import { copyFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

// Mermaid dijalankan di WebKitGTK (lihat src/editor/mermaid.ts), jadi yang dibutuhkan
// adalah file skrip browsernya, bukan modul yang dibundel ke dalam kode GJS.
const copyMermaid = (): Plugin => ({
    name: 'copy-mermaid',
    writeBundle(options) {
        copyFileSync('node_modules/mermaid/dist/mermaid.min.js', `${options.dir ?? 'dist'}/mermaid.min.js`);
    },
});

export default defineConfig({
    plugins: [copyMermaid()],
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
