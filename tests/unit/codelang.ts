// Tes pemilihan bahasa blok kode.

import { resolveLanguage } from '../../src/editor/codehighlight.js';
import { section, test, eq } from '../framework.js';

export function codeLanguageTests(): void {
    section('Bahasa blok kode');
    test('nama bahasa umum dan alias dikenali', () => {
        const ids = ['js', 'javascript', 'ts', 'py', 'python', 'bash', 'rs', 'go', 'c++', 'yml', 'json', 'html', 'sql']
            .map(n => resolveLanguage(n)?.get_id() ?? null);
        eq(ids, ['js', 'js', 'typescript', 'python3', 'python3', 'sh', 'rust', 'go', 'cpp', 'yaml', 'json', 'html', 'sql']);
    });
    test('nama tak dikenal dan kosong tidak diwarnai', () => {
        eq([resolveLanguage('bahasa-ngarang'), resolveLanguage('')], [null, null]);
    });
}
