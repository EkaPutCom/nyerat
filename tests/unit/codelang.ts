// Tests for choosing the code block language.

import { resolveLanguage } from '../../src/editor/codehighlight.js';
import { section, test, eq } from '../framework.js';

export function codeLanguageTests(): void {
    section('Code block language');
    test('common language names and aliases are recognized', () => {
        const ids = ['js', 'javascript', 'ts', 'py', 'python', 'bash', 'rs', 'go', 'c++', 'yml', 'json', 'html', 'sql']
            .map(n => resolveLanguage(n)?.get_id() ?? null);
        eq(ids, ['js', 'js', 'typescript', 'python3', 'python3', 'sh', 'rust', 'go', 'cpp', 'yaml', 'json', 'html', 'sql']);
    });
    test('unknown and empty names are not colored', () => {
        eq([resolveLanguage('made-up-language'), resolveLanguage('')], [null, null]);
    });
}
