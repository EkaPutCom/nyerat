// Deterministic checks of the actual contents; it does not claim to prove the meaning of the whole document.
import type { SourceFile } from './context.js';
import type { ToolSpec } from './provider.js';
import { isKanban, parseBoard } from '../markdown/kanban.js';
import { newIssues, resolveLink, scanDocument, type Issue } from '../markdown/lint.js';

export interface Verification {
    passed: boolean;
    checks: { file: string; label: string; passed: boolean }[];
}

const MARKDOWN_EXTENSION = /\.(md|markdown|mdown|mkd)$/i;
const MAX_LISTED = 8;

export const VERIFY_TOOL: ToolSpec = {
    name: 'verify_work',
    description: 'Check the actual result after changes. State the criteria from the user\'s request: text that must be present/absent, kanban cards in a given list and status, or Markdown structure (tables, headings, code blocks, links to other files) without new problems. file "*" means the whole folder, e.g. making sure an old date remains in no file. Check all changed files. A failed result means the work is not finished.',
    parameters: { type: 'object', properties: {
        checks: { type: 'array', minItems: 1, maxItems: 40, items: { type: 'object', properties: {
            file: { type: 'string', description: 'File name, or "*" for the whole folder (present/absent only)' },
            kind: { type: 'string', enum: ['present', 'absent', 'kanban', 'structure'] },
            text: { type: 'string', description: 'present/absent: the exact text; kanban: the card text. Not used for structure' },
            list: { type: 'string' }, done: { type: 'boolean' },
        }, required: ['file', 'kind'], additionalProperties: false } },
    }, required: ['checks'], additionalProperties: false },
};

const listLines = (hits: string[]): string => `${hits.slice(0, MAX_LISTED).join('; ')}${hits.length > MAX_LISTED ? `; +${hits.length - MAX_LISTED} more` : ''}`;

// File lines containing the text, as "file:line".
function occurrences(file: SourceFile, text: string): string[] {
    if (!file.text.includes(text)) return [];
    return file.text.split('\n').flatMap((line, i) => line.includes(text) ? [`${file.name}:${i + 1}`] : []);
}

// Structure problems of one file, including links to Markdown files that are not in the folder.
export function fileIssues(name: string, text: string, files: SourceFile[]): Issue[] {
    const { issues, links } = scanDocument(text);
    const names = new Set(files.map(f => f.name));
    for (const link of links) {
        if (!MARKDOWN_EXTENSION.test(link.target)) continue;   // images and other files are not visible to the agent
        const path = resolveLink(name, link.target);
        if (path === null || !names.has(path)) issues.push({ line: link.line, key: `link:${link.target}`, text: `the link to "${link.target}" (line ${link.line}) does not point to a file in the folder` });
    }
    return issues;
}

// baseline(file) = contents before the work started (null = unknown; '' = new file). With a baseline, the structure
// check only fails problems that appeared because of the changes, not old problems that were already there.
export function structureCheck(file: SourceFile, files: SourceFile[], baseline: string | null): { label: string; passed: boolean } {
    const after = fileIssues(file.name, file.text, files);
    // Unchanged contents cannot have new problems; skip the second parse.
    const found = baseline === null ? after : baseline === file.text ? [] : newIssues(fileIssues(file.name, baseline, files), after);
    const old = after.length - found.length;
    const label = found.length
        ? `structure: ${found.length} problems${baseline === null ? '' : ' new'} (${listLines(found.map(i => i.text))})`
        : `structure: no${baseline === null ? '' : ' new'} problems${old ? ` (${old} old problems left alone)` : ''}`;
    return { label, passed: !found.length };
}

export function verifyWork(raw: string, files: SourceFile[], baseline: (file: string) => string | null = () => null): Verification {
    try {
        const a = JSON.parse(raw);
        if (!Array.isArray(a.checks) || !a.checks.length || a.checks.length > 40) throw Error();
        const checks = a.checks.map((c: any) => {
            if (!c || typeof c.file !== 'string' || !['present', 'absent', 'kanban', 'structure'].includes(c.kind)) throw Error();
            const text: string = typeof c.text === 'string' ? c.text : '';
            if (c.kind !== 'structure' && (!text.trim() || text.length > 10000)) throw Error();
            if (c.file === '*') {
                if (c.kind !== 'present' && c.kind !== 'absent') throw Error();
                const hits = files.flatMap(f => occurrences(f, text));
                const passed = c.kind === 'present' ? hits.length > 0 : !hits.length;
                return { file: '*', label: `${c.kind} in the whole folder: ${text}${hits.length && c.kind === 'absent' ? ` — still present in ${listLines(hits)}` : ''}`, passed };
            }
            const file = files.find(f => f.name === c.file);
            if (!file) return { file: c.file, label: `${c.kind}: file does not exist`, passed: false };
            if (c.kind === 'structure') return { file: c.file, ...structureCheck(file, files, baseline(c.file)) };
            let passed = false;
            if (c.kind === 'present') passed = file.text.includes(text);
            if (c.kind === 'absent') passed = !file.text.includes(text);
            if (c.kind === 'kanban' && isKanban(file.text) && typeof c.list === 'string' && typeof c.done === 'boolean') {
                const cards = parseBoard(file.text).columns.filter(l => l.title === c.list).flatMap(l => l.cards).filter(card => card.text === text);
                passed = cards.length === 1 && cards[0].done === c.done;
            }
            const where = !passed && c.kind === 'absent' ? ` — still present in ${listLines(occurrences(file, text))}` : '';
            return { file: c.file, label: `${c.kind}: ${text}${c.kind === 'kanban' ? ` → ${c.list} (${c.done ? 'done' : 'not done'})` : ''}${where}`, passed };
        });
        return { passed: checks.every((c: { passed: boolean }) => c.passed), checks };
    } catch { return { passed: false, checks: [{ file: '', label: 'Invalid check', passed: false }] }; }
}
