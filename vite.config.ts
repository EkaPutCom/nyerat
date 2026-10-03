// Vite dipakai sebagai bundler saja (mode library): TypeScript → JavaScript, semua
// modul digabung menjadi file ESM yang dijalankan GJS. Dev server dan HMR tidak
// dipakai karena ini aplikasi GTK, bukan halaman web.

import { defineConfig } from 'vite';

export default defineConfig({
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
