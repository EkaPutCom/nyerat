// Checks the direction of dependencies between layers (see "Layers and the direction of
// dependencies" in README.md). Run by `npm run build`; exits 1 and lists every forbidden import.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');

const GTK = /^gi:\/\/(Gtk|Gdk|GdkPixbuf|GdkX11|Gsk|Adw|GtkSource|WebKit|Pango|Graphene)(\?|$)/;
const BASE = ['settings.ts', 'files.ts', 'workspace.ts', 'git.ts', 'gitlog.ts', 'config.ts', 'colors.ts'];

// [files the rule applies to, what they may not import, why]. Targets are src-relative paths of
// local modules or gi:// specifiers.
const rules = [
    [f => f.startsWith('markdown/'), t => t.startsWith('gi://') || !t.startsWith('markdown/'), 'markdown/ only holds string → data functions: no GI, nothing outside markdown/'],
    [f => f.startsWith('agent/'), t => GTK.test(t) || /^(ui|editor|window)\//.test(t) || t === 'window.ts', 'agent/ is free of GTK and knows nothing about the editor, widgets, or the window'],
    [f => f.startsWith('editor/'), t => /^(ui|window|agent)\//.test(t) || t === 'window.ts', 'editor/ knows nothing about files, menus, the sidebar, or the agent'],
    [f => f.startsWith('ui/') || f.startsWith('window/') || f === 'actions.ts', t => t === 'window.ts', 'only app.ts composes MainWindow; components and controllers get a host interface'],
    [f => BASE.includes(f), t => /^(ui|editor|agent|window)\//.test(t) || t === 'window.ts', 'base modules do not reach up into the layers above them'],
];

const files = readdirSync(src, { recursive: true }).filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts')).map(f => f.split('\\').join('/'));
const IMPORT = /(?:^|\n)\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

const errors = [];
for (const file of files) {
    const text = readFileSync(join(src, file), 'utf8');
    for (const m of text.matchAll(IMPORT)) {
        const spec = m[1] ?? m[2] ?? m[3];
        let target = spec;
        if (spec.startsWith('.')) {
            target = relative(src, normalize(join(src, dirname(file), spec.split('?')[0]))).split('\\').join('/').replace(/\.js$/, '.ts');
        } else if (!spec.startsWith('gi://')) continue;   // gjs built-ins (system, cairo) and npm packages
        for (const [applies, forbidden, why] of rules) {
            if (applies(file) && forbidden(target)) errors.push(`src/${file}: imports ${spec} (${why})`);
        }
    }
}

if (errors.length) {
    console.error(`Layer rule violations:\n  ${errors.join('\n  ')}`);
    process.exit(1);
}
console.log(`Layer rules: ${files.length} modules checked`);
