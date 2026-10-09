// Takes screenshots of the real app for the landing page (docs/). Bundled by Vite into dist/capture.js.
//
//   npm run docs
//
// Writes PNGs and GIFs to docs/assets/. A real window is opened, so a desktop session is needed.

import GLib from 'gi://GLib';
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import Gio from 'gi://Gio';
import System from 'system';

import { AppSettings } from '../src/settings.js';
import { MainWindow } from '../src/window.js';
import { isKanban, moveCard, parseBoard } from '../src/markdown/kanban.js';
import type { Provider } from '../src/agent/provider.js';
import { listChats, saveChat } from '../src/agent/chatstore.js';
import { iterAtLine } from '../src/gtkutil.js';
import { whenDialogReady, widgetPixbuf } from '../tests/widgets.js';
import { editCardDialog, findDialog, harnessAskDialog } from '../src/ui/dialogs.js';
import { findEntry } from '../src/ui/menu.js';
import { localDate } from '../src/markdown/home.js';

// A sample work folder for the Assistant panel screenshots (a fake provider; no network and no API key):
// a product launch project with a plan, meeting notes, research, and a task board.
const WORK: Record<string, string> = {
    'plans/launch.md': '# Nyerat 1.0 Launch Plan\n\n## Goal\n\nRelease Nyerat 1.0 for Linux users, complete with folder syncing.\n\n## Schedule\n\n- Closed beta: 20 October\n- Public release: 15 November\n- Evaluation: 30 November\n\n## Budget\n\nTotal $3,000, including the redesign and a test server.\n',
    'notes/meeting-1-oct.md': '# Weekly meeting, 1 October\n\n## Decisions\n\n- The public release is postponed to **22 November** because the sync testing is not finished.\n- The budget does not change.\n- Sari prepares the release material.\n\n## Follow-up\n\n- [ ] Budi fixes the sync bug\n- [ ] Dewi schedules the beta trial\n',
    'notes/meeting-8-oct.md': '# Weekly meeting, 8 October\n\nThe sync bug is still open. The closed beta stays on 20 October.\n',
    'research/competitors.md': '# Competitor research\n\nThree similar note apps; all of them are paid and closed.\n',
    'research/users.md': '# User interviews\n\nFive users want syncing without an account.\n',
    'tasks.md': '---\nkanban: true\n---\n\n## Plan\n\n- [ ] Prepare the release material #marketing @{2026-11-10}\n- [ ] Write the release notes #docs\n\n## In Progress\n\n- [ ] Fix the sync bug #bug #important @{2026-10-25}\n\n## Done\n\n- [x] Redesign the home page #design\n',
    'ideas.md': '# Ideas\n\nA PDF export feature.\n',
};
const ASK_READ = 'Is there a meeting decision that has not made it into the launch plan yet?';
const ANSWER = `There is **one decision that is not in the plan yet**:

- In *notes/meeting-1-oct.md* › Decisions: "The public release is postponed to 22 November because the sync testing is not finished."
- In *plans/launch.md* › Schedule: "Public release: 15 November."

The budget is already consistent ($3,000) and the closed beta stays on 20 October. Shall I propose a change to the date?`;
const ASK_ACT = 'Yes, update the release date and move the release material card to In Progress.';
const ANSWER_ACT = 'Done. The release date in the plan is now **22 November**, and the card *Prepare the release material* is in the *In Progress* list.';

// A development board for the orchestrator scene: @pi cards are worked on in another project repo.
const PI_BOARD = `---
kanban: true
project: web-ecommerce
---

## Plan

- [ ] Checkout with QRIS @pi #feature
  Use the official SDK.
- [ ] Test the cart @pi #test
- [ ] Tidy up the README #docs

## In Progress

## Review

## Done

- [x] Product page #feature
`;

// A fake pi that speaks RPC over stdin/stdout (the same as the harness GUI test): MODE slow waits for the file
// "release", ask ends the turn with a question. It calls neither the real pi nor any API.
const fakePi = (dir: string) => `#!/bin/sh
mode=$(cat "${dir}/mode")
read -r cmd
echo '{"id":"nyerat-state","type":"response","command":"get_state","success":true,"data":{"sessionId":"7f3c2a91"}}'
read -r cmd
echo '{"type":"response","command":"prompt","success":true,"data":{"disposition":"started"}}'
echo '{"type":"turn_start"}'
echo '{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"Look at the project structure first, then find the payment module."}}'
echo '{"type":"tool_execution_start","toolCallId":"t1","toolName":"bash","args":{"command":"ls src/checkout"}}'
printf '%s\\n' '{"type":"tool_execution_end","toolCallId":"t1","toolName":"bash","result":{"content":[{"type":"text","text":"cart.ts\\npayment.ts\\nindex.ts"}]},"isError":false}'
echo '{"type":"tool_execution_start","toolCallId":"t2","toolName":"edit","args":{"path":"src/checkout/qris.ts"}}'
if [ "$mode" = slow ]; then while [ ! -e "${dir}/release" ]; do sleep 0.05; done; fi
echo '{"type":"tool_execution_end","toolCallId":"t2","toolName":"edit","result":{"content":[{"type":"text","text":"ok"}]},"isError":false}'
if [ "$mode" = ask ]; then
  printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"I have read the README.\\n\\nThe installation section uses both npm and pnpm. Shall I standardize it on pnpm only?"}],"stopReason":"stop"}}'
  echo '{"type":"agent_settled"}'
  read -r ans || exit 0
fi
echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"QRIS added in src/checkout/qris.ts with 3 tests"}],"stopReason":"stop","usage":{"input":5210,"output":640,"totalTokens":5850,"cost":{"total":0.0042}}}}'
echo '{"type":"agent_settled"}'
while read -r x; do :; done
`;

const GIF_WIDTH = 900;   // the original PNG is larger
const GIF_STEP = 140;    // ms per frame
const GIF_COLORS = 128;
const OUT = GLib.getenv('NYERAT_OUT') ?? 'docs/assets';

const DOC = `# Product Meeting Notes

Weekly meeting, **Friday morning**. Things that *need* follow-up are below, this text is ==highlighted== and ~~this one is struck through~~.

## Decisions

- The \`1.0\` release is postponed by one week
- [x] Fix the HTML export bug
- [ ] Write the kanban feature [documentation](https://github.com/EkaPutCom/nyerat)

> A quote from a user: "At last, an editor that stays out of the way."

\`\`\`ts
function remainingBudget(total: number, spent: number): number {
    return total - spent;
}
\`\`\`

## Schedule

| Task | Owner | Deadline |
| :---- | :--------------: | ------: |
| Redesign | **Sari** | 10 Oct |
| Trial run | *Budi* | 17 Oct |
`;

const TABLE_DOC = `# Project Budget

Tables are rendered as a grid. Click a cell to edit it.

| Item | Owner | Cost ($) |
| :-- | :--------------: | ---------: |
| **Design** | Sari | 750 |
| Development | *Budi* | 2,800 |
| Testing | Dewi | 530 |
| \`Server\` | Andi | 375 |
| [License](https://example.com) | Rina | 200 |

The total cost is still below the **budget**.
`;

const DIAGRAM_DOC = `# Diagrams from Text

Write a diagram as code and see the result right away.

\`\`\`mermaid
graph LR
    A[Note] --> B{Needs follow-up?}
    B -->|yes| C[Create a task]
    B -->|not yet| A
    C --> D[Review together with the agent]
\`\`\`

\`\`\`mermaid
sequenceDiagram
    You->>Agent: Update the release schedule
    Agent-->>You: Change proposal (diff)
    You->>Agent: Apply
\`\`\`
`;

const DBML_DOC = `# Database Schema

A \`dbml\` block (the dbdiagram.io language) is drawn as an ER diagram.

\`\`\`dbml
Table projects {
  id int [pk]
  name varchar
}

Table tasks {
  id int [pk]
  title varchar
  project_id int
}

Ref: tasks.project_id > projects.id
\`\`\`
`;

const BOARD = `---
kanban: true
---

## Plan

- [ ] User research #research @{2026-10-10}
  Interview five active users.
- [ ] Redesign the home page #design
- [ ] Write the **API** documentation #docs @{2026-10-25}

## In Progress

- [ ] Implement the kanban board #feature #important
- [ ] Fix the \`HTML export\` bug #bug @{2026-10-03}

## Review

- [ ] Trial on Ubuntu 24.04 #qa

## Done

- [x] Choose the project name: Nyerat
- [x] Set up the GitHub repository #infra
`;

const CODE_DOC = `# Colored Code Blocks

\`\`\`python
from datetime import date

def days_left(release, today):
    return (release - today).days

print(days_left(date(2026, 11, 22), date(2026, 10, 5)))
\`\`\`

\`\`\`rust
fn total_budget(costs: &[u64]) -> u64 {
    costs.iter().sum()
}
\`\`\`

\`\`\`bash
git add plans/ && git commit -m "Update the release schedule"
\`\`\`
`;

function main(app: Adw.Application): void {
    GLib.mkdir_with_parents(OUT, 0o755);
    const settings = AppSettings.inMemory({ welcomed: true, home: false, dark: false, sidebarPage: 'outline', width: 1280, height: 780 });
    const w = new MainWindow(app, settings, null);
    const ed = w.editor, buf = ed.buffer;
    const ctx = GLib.MainContext.default();
    const pump = () => { for (let i = 0; i < 200 && ctx.pending(); i++) ctx.iteration(false); };
    const settle = (n = 12) => { for (let i = 0; i < n; i++) { pump(); GLib.usleep(15000); } };
    // Dialogs answer through a Promise; the capture is scheduled by a timer and then the dialog is closed, so wait for its answer.
    const waitPromise = (promise: Promise<unknown>) => {
        let done = false;
        void promise.finally(() => { done = true; });
        for (let i = 0; i < 2000 && !done; i++) { pump(); GLib.usleep(5000); }
    };
    const waitMermaid = () => {
        for (let i = 0; i < 3000 && ed.mermaid.blocks.some(b => b.busy || b.timer); i++) { pump(); GLib.usleep(10000); }
        settle();
    };
    // In the middle of layout (e.g. while an answer streams) the window size can briefly be 0 and the capture empty; retry.
    const grab = () => {
        for (let i = 0; i < 50; i++) {
            settle();
            const px = widgetPixbuf(w.win);
            if (px) return px;
        }
        throw new Error('the window cannot be captured');
    };
    const shot = (name: string) => grab().savev(`${OUT}/${name}.png`, 'png', [], []);

    // GIF: frame() collects frames; finishGifs() builds one palette per GIF, marks the pixels that did not
    // change from the previous frame as transparent (much smaller), and then writes the file.
    const pending = new Map<string, { px: GdkPixbuf.Pixbuf; delay: number }[]>();
    // `hold` = how many steps (GIF_STEP ms) this frame is held before it changes.
    // Only the pixbuf is stored (native memory): a large array on the JS heap triggers GC in the middle of capturing.
    const frame = (gif: string, hold = 0) => {
        const src = grab();
        const px = src.scale_simple(GIF_WIDTH, Math.round(src.get_height() * GIF_WIDTH / src.get_width()), GdkPixbuf.InterpType.HYPER)!;
        if (!pending.has(gif)) pending.set(gif, []);
        pending.get(gif)!.push({ px, delay: GIF_STEP * (1 + hold) });
    };
    // A pixbuf can be RGB or RGBA and its rows can contain padding; gifenc needs packed RGBA.
    const toRgba = (px: GdkPixbuf.Pixbuf) => {
        const width = px.get_width(), height = px.get_height();
        const raw = px.get_pixels(), stride = px.get_rowstride(), n = px.get_n_channels();
        const rgba = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = y * stride + x * n, o = (y * width + x) * 4;
                rgba[o] = raw[i]; rgba[o + 1] = raw[i + 1]; rgba[o + 2] = raw[i + 2]; rgba[o + 3] = 255;
            }
        }
        return rgba;
    };
    const finishGifs = () => {
        const width = GIF_WIDTH;
        for (const [name, frames] of pending) {
            const height = frames[0].px.get_height();
            const list = frames.map(f => ({ rgba: toRgba(f.px), delay: f.delay }));
            // One palette from all the frames at once (sampled every 4 pixels), leaving one index for "transparent".
            const sample = new Uint8Array(list.reduce((sum, f) => sum + Math.ceil(f.rgba.length / 16) * 4, 0));
            let at = 0;
            for (const f of list) for (let i = 0; i < f.rgba.length; i += 16) { sample.set(f.rgba.subarray(i, i + 4), at); at += 4; }
            const palette = quantize(sample, GIF_COLORS - 1);
            const clear = palette.length;
            palette.push([0, 0, 0]);
            const enc = GIFEncoder();
            let prev: Uint8Array | null = null;
            for (const f of list) {
                const index = applyPalette(f.rgba, palette);
                if (!prev) {
                    enc.writeFrame(index, width, height, { palette, delay: f.delay });
                } else {
                    const diff = index.slice();
                    for (let i = 0; i < diff.length; i++) if (diff[i] === prev[i]) diff[i] = clear;
                    enc.writeFrame(diff, width, height, { delay: f.delay, transparent: true, transparentIndex: clear, dispose: 1 });
                }
                prev = index;
            }
            enc.finish();
            const bytes = enc.bytes();
            GLib.file_set_contents(`${OUT}/${name}.gif`, bytes);
            print(`${name}.gif: ${list.length} frames,  ${Math.round(bytes.length / 1024)} KB`);
        }
    };
    const load = (text: string, dark = false, line = 0, sidebar = true) => {
        w.setOption('dark', dark);
        w.setOption('sidebar', sidebar);
        w.file = null;
        ed.setText(text);
        w.setBoardMode(isKanban(text));
        const it = iterAtLine(buf, line);
        buf.place_cursor(it);
        ed.view.scroll_to_iter(buf.get_start_iter(), 0, false, 0, 0);
        settle(20);
    };
    const cursorTo = (line: number, col = 0) => {
        const it = iterAtLine(buf, line);
        it.forward_chars(col);
        buf.place_cursor(it);
        settle(4);
    };

    settle(30);

    // ───────── Screenshots ─────────
    load(DOC, false, 0);
    cursorTo(2, 5);
    shot('editor-light');

    load(DOC, true, 0);
    cursorTo(2, 5);
    shot('editor-dark');
    load(DOC, false, 0);

    load(TABLE_DOC);
    cursorTo(0);
    shot('table');

    load(CODE_DOC);
    cursorTo(0);
    shot('code');

    load(DIAGRAM_DOC, false, 0, false);
    cursorTo(0);
    waitMermaid();
    shot('diagram');
    load(DBML_DOC, false, 0, false);
    cursorTo(0);
    waitMermaid();
    shot('dbml');

    load(BOARD, false, 0, false);
    shot('kanban');
    load(BOARD, true, 0, false);
    shot('kanban-dark');
    load(BOARD, false, 0, false);

    // ───────── GIF 1: syntax appears and disappears ─────────
    load(DOC, false, 0);
    for (const [line, col] of [[0, 8], [2, 20], [2, 55], [5, 12], [6, 8], [7, 20], [0, 0]] as const) {
        cursorTo(line, col);
        frame('syntax', 2);
    }

    // ───────── GIF 2: typing Markdown ─────────
    load('', false, 0);
    const typed = '# Meeting Notes\n\nDecision: release on **22 November**, the budget is *unchanged*, and the bug is in `syncing`.\n\n- [ ] Budi: fix the bug\n- [x] Sari: prepare the material\n- [ ] Dewi: schedule the beta\n';
    let acc = '';
    frame('typing', 2);
    for (const ch of typed) {
        buf.insert_at_cursor(ch, -1);
        acc += ch;
        if (ch === ' ' || ch === '\n' || ch === '*' || ch === '`' || ch === '#' || /[a-z]/i.test(ch) && acc.length % 3 === 0) frame('typing');
    }
    frame('typing', 6);

    // ───────── GIF 3: a live diagram ─────────
    load('# Workflow\n\n```mermaid\ngraph LR\n    A[Note] --> B[Plan]\n```\n', false, 0, false);
    waitMermaid();
    frame('diagram', 3);
    cursorTo(4, 20);
    waitMermaid();
    frame('diagram', 3);
    for (const add of ['\n    B --> C[Do it]', '\n    C --> D[Review]', '\n    D --> A']) {
        const it = iterAtLine(buf, 4);
        it.forward_to_line_end();
        buf.insert(it, add, -1);
        waitMermaid();
        frame('diagram', 3);
    }
    cursorTo(0);
    waitMermaid();
    frame('diagram', 8);

    // ───────── GIF 4: the kanban board ─────────
    load(BOARD, false, 0, false);
    frame('kanban', 5);
    let board = parseBoard(w.editor.getText());
    // Move cards through the same board model that drag-and-drop uses.
    const moves: [[number, number], [number, number]][] = [
        [[0, 0], [1, 0]],
        [[1, 1], [2, 0]],
        [[1, 0], [2, 0]],
    ];
    for (const [from, to] of moves) {
        board = moveCard(board, { column: from[0], index: from[1] }, { column: to[0], index: to[1] });
        w.board.commit(board);
        settle(20);
        frame('kanban', 5);
    }
    frame('kanban', 5);

    // ───────── GIF 5: light ↔ dark mode ─────────
    load(DOC, false, 0);
    cursorTo(0);
    frame('theme', 8);
    load(DOC, true, 0);
    cursorTo(0);
    frame('theme', 8);

    // ───────── The Assistant panel ─────────
    // The folder name is shown in the Files tab and the window title, so give it a sensible name (not a temporary one).
    const proj = GLib.build_filenamev([GLib.dir_make_tmp('nyerat-work-XXXXXX'), 'nyerat-launch']);
    GLib.mkdir_with_parents(proj, 0o755);
    const put = (rel: string, text: string) => {
        const path = GLib.build_filenamev([proj, ...rel.split('/')]);
        GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
        GLib.file_set_contents(path, text);
        return path;
    };
    for (const [rel, text] of Object.entries(WORK)) put(rel, text);
    const plan = GLib.build_filenamev([proj, 'plans', 'launch.md']);
    w.openFolder(proj, false);
    w.load(plan);

    // A fake model provider that plays a script: every round contains a tool call or the final answer.
    type Call = { id: string; name: string; arguments: string };
    let streamFrames = false;
    const scripted = (rounds: (Call[] | string)[], gif = 'assistant'): Provider => {
        let at = 0;
        return {
            async chat(req) {
                const step = rounds[Math.min(at++, rounds.length - 1)];
                if (typeof step === 'string') {
                    const parts = step.match(/\S+\s*/g) ?? [];
                    parts.forEach((part, i) => {
                        req.onText(part);
                        if (streamFrames && i % 6 === 5) frame(gif, 0);
                    });
                    return { usage: { prompt: 3920, cached: 1536, completion: 148 }, cancelled: false, toolCalls: [], reasoning: '' };
                }
                return { usage: { prompt: 1840, cached: 1536, completion: 40 }, cancelled: false, reasoning: '', toolCalls: step };
            },
        };
    };
    w.chat.keyStore = { get: async () => ({ key: 'example', source: 'env' }), set: async () => 'env', clear: async () => {} };
    for (const dark of [false, true]) {
        w.chat.makeProvider = () => scripted([
            [{ id: 'a', name: 'search_text', arguments: '{"text":"Public release"}' }, { id: 'b', name: 'read_file', arguments: '{"name":"meeting-1-oct"}' }],
            ANSWER,
        ]);
        w.setDark(dark);
        w.chat.reset();
        w.setOption('chat', true);
        w.sidebar.setPage('files');
        let done = false;
        streamFrames = !dark;
        if (streamFrames) frame('assistant', 4);
        void w.chat.ask(ASK_READ).then(() => { done = true; });
        while (!done) { pump(); GLib.usleep(5000); }
        settle(20);
        if (streamFrames) frame('assistant', 10);
        shot(dark ? 'assistant-dark' : 'assistant-light');
    }
    w.setDark(false);

    // ───────── The agent proposes changes (review window, then applied) ─────────
    const idle = (ms: number) => { for (let i = 0; i < ms / 10; i++) { pump(); GLib.usleep(10000); } };
    w.chat.makeProvider = () => scripted([
        [{ id: 'u1', name: 'edit_file', arguments: JSON.stringify({ name: 'plans/launch.md', old_text: '- Public release: 15 November', new_text: '- Public release: 22 November', reason: 'The 1 October meeting postponed the public release to 22 November.' }) }],
        [{ id: 'u2', name: 'edit_kanban', arguments: JSON.stringify({ name: 'tasks.md', action: 'move', card: 'Prepare the release material', list: 'In Progress', reason: 'Sari started preparing the release material.' }) }],
        ANSWER_ACT,
    ], 'agent');
    const nextViewer = () => {
        for (let i = 0; i < 800 && !w.chat.viewer; i++) { pump(); GLib.usleep(10000); }
        const viewer = w.chat.viewer;
        if (!viewer) throw new Error('the review window did not appear');
        idle(400);
        return viewer;
    };
    streamFrames = true;
    w.chat.reset();
    let acted = false;
    void w.chat.ask(ASK_ACT).then(() => { acted = true; });
    const first = nextViewer();
    frame('agent', 8);
    widgetPixbuf(first.window)!.savev(`${OUT}/proposal-diff.png`, 'png', [], []);
    first.applyButton.emit('clicked');
    idle(400);
    frame('agent', 6);
    const second = nextViewer();
    frame('agent', 8);
    widgetPixbuf(second.window)!.savev(`${OUT}/proposal-kanban.png`, 'png', [], []);
    second.applyButton.emit('clicked');
    while (!acted) { pump(); GLib.usleep(5000); }
    idle(600);
    frame('agent', 14);
    const agentShot = grab();
    agentShot.savev(`${OUT}/agent-done.png`, 'png', [], []);
    // The social share image (1200x631): the whole window is scaled down, and then its empty bottom part is cropped.
    agentShot.scale_simple(1200, Math.round(agentShot.get_height() * 1200 / agentShot.get_width()), GdkPixbuf.InterpType.HYPER)!
        .new_subpixbuf(0, 0, 1200, 631).savev(`${OUT}/og-image.png`, 'png', [], []);
    streamFrames = false;
    w.setOption('chat', false);
    w.editor.buffer.set_modified(false);

    // ───────── Files: the folder tree ─────────
    // Restore the sample contents (the proposals above changed the plan and the board), so the next screenshots are consistent with the Assistant answers.
    for (const [rel, text] of Object.entries(WORK)) put(rel, text);
    w.openFolder(proj, false);
    w.load(plan);
    w.setOption('sidebar', true);
    w.sidebar.setPage('files');
    w.fileTree.reveal(GLib.build_filenamev([proj, 'research', 'competitors.md']));
    w.fileTree.reveal(plan);
    settle(20);
    shot('files');

    // ───────── Git history ─────────
    const repo = GLib.dir_make_tmp('nyerat-history-XXXXXX');
    const env = [...GLib.get_environ(), 'GIT_CONFIG_GLOBAL=/dev/null', 'GIT_CONFIG_SYSTEM=/dev/null'];
    const git = (...args: string[]) => {
        const [, , err, status] = GLib.spawn_sync(repo, ['git', '-c', 'user.name=Eka Putra', '-c', 'user.email=eka@example.com', ...args], env, GLib.SpawnFlags.SEARCH_PATH, null);
        if (status !== 0) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(err ?? undefined)}`);
    };
    const note = GLib.build_filenamev([repo, 'plan.md']);
    const versions = [
        ['Create the plan outline', '# Launch Plan\n\n## Goal\n\nRelease Nyerat 1.0.\n'],
        ['Add a schedule section', '# Launch Plan\n\n## Goal\n\nRelease Nyerat 1.0.\n\n## Schedule\n\n- Closed beta: October\n'],
        ['Clarify the goal and the dates', '# Launch Plan\n\n## Goal\n\nRelease Nyerat 1.0 for Linux users, complete with folder syncing.\n\n## Schedule\n\n- Closed beta: 20 October\n- Public release: 15 November\n'],
    ];
    git('init', '-q');
    for (const [msg, text] of versions) {
        GLib.file_set_contents(note, text);
        git('add', 'plan.md');
        git('commit', '-q', '-m', msg);
    }
    GLib.file_set_contents(note, versions[2][1] + '- Evaluation: 30 November\n');
    GLib.file_set_contents(GLib.build_filenamev([repo, 'ideas.md']), '# Ideas\n\nA PDF export feature (not in git yet).\n');
    w.openFolder(repo, false);
    w.load(note);
    w.setOption('sidebar', true);
    w.sidebar.setPage('history');
    idle(3000);
    shot('history');
    w.setDark(true);
    idle(300);
    shot('history-dark');
    w.setDark(false);
    idle(300);

    // The commit reading window: taken from the history list like a user click.
    const toplevels = () => Gtk.Window.list_toplevels();
    // Only the child window (the viewer); the invisible WebKit window of Mermaid is a toplevel too.
    const child = () => toplevels().find(t => t.get_visible() && (t as unknown as Gtk.Window).get_transient_for() === (w.win as unknown as Gtk.Window));
    w.history.list.emit('activate', 0);
    idle(1500);
    const viewer = child();
    if (viewer) {
        idle(500);
        widgetPixbuf(viewer)!.savev(`${OUT}/history-diff.png`, 'png', [], []);
        (viewer as Gtk.Window).destroy();
    }

    // ───────── Image zoom ─────────
    const picture = GLib.build_filenamev([GLib.get_current_dir(), 'tests/samples/images/example.png']);
    load(`# Image\n\nDouble-click the image to enlarge it.\n\n![Example image](${picture})\n`, false, 4, false);
    idle(1200);
    cursorTo(4);
    ed.zoomImage();
    idle(800);
    const zoomWin = child();
    if (zoomWin) {
        widgetPixbuf(zoomWin)!.savev(`${OUT}/image-zoom.png`, 'png', [], []);
        (zoomWin as Gtk.Window).destroy();
    }

    // ───────── Document tabs ─────────
    w.setOption('sidebar', true);
    w.sidebar.setPage('files');
    w.openFolder(proj, false);
    w.file = null;
    ed.setText('');
    w.setOption('autosave', false);   // so the • mark (unsaved) is shown on the tab
    for (const rel of ['notes/meeting-1-oct.md', 'plans/launch.md', 'research/competitors.md', 'research/users.md']) w.openFile(GLib.build_filenamev([proj, ...rel.split('/')]));
    w.switchTab(-2);   // the plan is active
    w.editor.buffer.place_cursor(w.editor.buffer.get_end_iter());
    w.editor.buffer.insert_at_cursor('\n## Risks\n\nThe sync bug could push back the public release.\n', -1);
    w.editor.view.scroll_to_iter(w.editor.buffer.get_start_iter(), 0, false, 0, 0);
    idle(600);
    shot('tab');
    // Clean up: save the changes and then close the tabs, back to one document.
    w.editor.buffer.set_modified(false);
    w.setOption('autosave', true);
    while (w.documentCount > 1) w.closeTab();
    w.file = null;
    ed.setText('');

    // ───────── Conversation history ─────────
    const earlier: [string, string, string, string][] = [
        ['2026-10-02T21:05:00', 'Summarize this week\'s meeting notes', 'Summarize this week\'s meeting notes', 'The public release is postponed to 22 November, Sari prepares the release material, and Budi fixes the sync bug.'],
        ['2026-10-03T08:40:00', 'List the launch risks', 'List the launch risks', 'Main risks: the sync bug, a closed beta that slips, and a limited test server budget.'],
    ];
    // Remove the conversations from the Assistant scene above so the list only contains these examples.
    for (const old of listChats(proj)) GLib.unlink(old.path);
    for (const [created, title, q, a] of earlier) saveChat(proj, { title, model: 'deepseek-flash', created, turns: [{ role: 'user', content: q }, { role: 'assistant', content: a }] }, null);
    w.openFolder(proj, false);
    w.load(plan);
    w.setOption('sidebar', true);
    w.sidebar.setPage('files');
    w.setOption('chat', true);
    w.chat.reset();
    w.chat.makeProvider = () => scripted([ANSWER]);
    void w.chat.ask(ASK_READ);
    idle(1500);
    // A GTK 4 popover has its own surface and its position cannot be read; place it the way GTK places it:
    // below (or above) its button, centered, and not outside the window.
    const grabWithPopover = (button: Gtk.MenuButton, above = false) => {
        const popover = button.get_popover()!;
        popover.popup();
        idle(500);
        const main = grab();
        const pop = widgetPixbuf(popover);
        const [, tx, ty] = button.translate_coordinates(w.win, 0, 0);
        // The window capture includes the CSD frame; the widget coordinates start inside it.
        const [sx, sy] = w.win.get_surface_transform();
        const bx = tx + sx, by = ty + sy;
        if (pop) {
            const x = Math.max(0, Math.min(main.get_width() - pop.get_width(), Math.round(bx + button.get_width() / 2 - pop.get_width() / 2)));
            const y = above ? Math.max(0, Math.round(by - pop.get_height())) : Math.round(by + button.get_height());
            const h = Math.min(pop.get_height(), main.get_height() - y);
            pop.composite(main, x, y, pop.get_width(), h, x, y, 1, 1, GdkPixbuf.InterpType.NEAREST, 255);
        }
        popover.popdown();
        idle(200);
        return main;
    };
    for (const dark of [false, true]) {
        w.setDark(dark);
        grabWithPopover(w.chat.historyButton).savev(`${OUT}/chat-history${dark ? '-dark' : ''}.png`, 'png', [], []);
    }
    w.setDark(false);

    // ───────── Context: the breakdown sent to the model, with switches ─────────
    w.chat.reset();
    const sel = (from: string, to: string) => {
        const text = w.editor.getText();
        const a = text.indexOf(from), b = text.indexOf(to) + to.length;
        w.editor.buffer.select_range(w.editor.buffer.get_iter_at_offset(a), w.editor.buffer.get_iter_at_offset(b));
    };
    sel('- Public release', '15 November');
    w.chat.updateContextSummary();
    idle(300);
    grabWithPopover(w.chat.contextButton, true).savev(`${OUT}/context.png`, 'png', [], []);
    w.editor.buffer.place_cursor(w.editor.buffer.get_start_iter());

    // ───────── Plan, partial batch, verification (GIF + screenshot) ─────────
    for (const [rel, text] of Object.entries(WORK)) put(rel, text);
    w.openFolder(proj, false);
    w.load(plan);
    w.setOption('sidebar', false);
    const tool = (id: string, name: string, args: object): Call => ({ id, name, arguments: JSON.stringify(args) });
    const steps = (...status: string[]) => ['Find meeting decisions that are not in the plan yet', 'Update the plan, the board, and the meeting notes', 'Check the result'].map((text, i) => ({ text, status: status[i] }));
    const goal = 'Sync the release schedule with the 1 October meeting decisions';
    w.chat.makeProvider = () => scripted([
        [tool('p1', 'set_work', { goal, steps: steps('done', 'pending', 'pending'), note: 'The public release is postponed to 22 November.' })],
        [tool('p2', 'propose_batch', { actions: [
            { tool: 'edit_file', arguments: JSON.stringify({ name: 'plans/launch.md', old_text: '- Public release: 15 November', new_text: '- Public release: 22 November', reason: 'The 1 October meeting postponed the public release.' }) },
            { tool: 'edit_kanban', arguments: JSON.stringify({ name: 'tasks.md', action: 'move', card: 'Prepare the release material', list: 'In Progress', reason: 'Sari started preparing the release material.' }) },
            { tool: 'insert_text', arguments: JSON.stringify({ name: 'notes/meeting-8-oct.md', position: 'end', text: '\nThe launch plan has been updated to 22 November.\n', reason: 'Record that the plan has been synced.' }) },
        ] })],
        [tool('p3', 'set_work', { goal, steps: steps('done', 'done', 'pending'), note: 'The batch was applied.' })],
        [tool('p4', 'verify_work', { checks: [
            { file: 'plans/launch.md', kind: 'present', text: 'Public release: 22 November' },
            { file: '*', kind: 'absent', text: '15 November' },
            { file: 'tasks.md', kind: 'kanban', text: 'Prepare the release material #marketing @{2026-11-10}', list: 'In Progress', done: false },
            { file: 'notes/meeting-8-oct.md', kind: 'present', text: 'has been updated to 22 November' },
        ] })],
        [tool('p5', 'set_work', { goal, steps: steps('done', 'done', 'done'), note: 'All the checks passed.' })],
        'Done and verified. The plan uses **22 November**, the old date is left in no file, the card *Prepare the release material* is in *In Progress*, and the 8 October meeting notes record the update.',
    ], 'work');
    streamFrames = true;
    w.chat.reset();
    w.setOption('chat', true);
    frame('work', 4);
    let worked = false;
    void w.chat.ask('Sync the release schedule with the meeting decisions, and then make sure nothing is left behind.').then(() => { worked = true; });
    const pack = nextViewer();
    frame('work', 8);
    // Partial approval: uncheck one file and write a note, capture, then restore and apply everything.
    pack.checks[2].set_active(false);
    pack.noteEntry.set_text('I will write the 8 October meeting notes myself');
    idle(300);
    widgetPixbuf(pack.window)!.savev(`${OUT}/proposal-batch.png`, 'png', [], []);
    pack.checks[2].set_active(true);
    pack.noteEntry.set_text('');
    pack.applyButton.emit('clicked');
    while (!worked) { pump(); GLib.usleep(5000); }
    idle(600);
    frame('work', 16);
    shot('work');
    streamFrames = false;
    // The plan checklist at the start of the answer: scroll the panel to the top and then capture just the panel.
    w.chat.scroller.get_vadjustment().set_value(0);
    idle(300);
    widgetPixbuf(w.chat.widget)!.savev(`${OUT}/plan.png`, 'png', [], []);

    // ───────── The agent log of the work above ─────────
    w.chat.showLog();
    idle(600);
    const logWin = w.chat.logViewer?.window;
    if (logWin) {
        widgetPixbuf(logWin)!.savev(`${OUT}/agent-log.png`, 'png', [], []);
        logWin.close();
        idle(300);
    }

    // ───────── The agent reads the Git history ─────────
    w.openFolder(repo, false);
    w.load(note);
    w.setOption('sidebar', true);
    w.sidebar.setPage('history');
    w.chat.makeProvider = () => scripted([
        [tool('g1', 'git_log', { file: 'plan.md' })],
        [tool('g2', 'show_commit', { commit: 'HEAD', file: 'plan.md' })],
        'The date **15 November** first entered in the commit *Clarify the goal and the dates* by Eka Putra; the earlier commit only wrote "Closed beta: October". The line *Evaluation: 30 November* is not committed yet.',
    ]);
    w.chat.reset();
    let gitDone = false;
    void w.chat.ask('When was the public release date written in the plan, and by whom?').then(() => { gitDone = true; });
    while (!gitDone) { pump(); GLib.usleep(5000); }
    idle(1500);
    shot('agent-git');
    w.setOption('chat', false);

    // ───────── The kanban card dialog (a due date with a calendar) ─────────
    load(BOARD, false, 0, false);
    whenDialogReady(() => findDialog('Edit Card'), dialog => {
        widgetPixbuf(dialog)?.savev(`${OUT}/kanban-card.png`, 'png', [], []);
        dialog.close();
    });
    waitPromise(editCardDialog(w.win, { text: 'User research #research @{2026-10-10 09:00}', notes: ['Interview five active users.'] }));

    // ───────── The orchestrator: cards worked on by pi (a fake RPC, no API) ─────────
    const piDir = GLib.dir_make_tmp('nyerat-pi-XXXXXX');
    const shop = GLib.build_filenamev([GLib.dir_make_tmp('nyerat-repo-XXXXXX'), 'web-ecommerce']);
    GLib.mkdir_with_parents(shop, 0o755);
    const piScript = GLib.build_filenamev([piDir, 'pi']);
    GLib.file_set_contents(piScript, fakePi(piDir));
    GLib.spawn_command_line_sync(`chmod +x ${piScript}`);
    const piMode = (m: string) => GLib.file_set_contents(GLib.build_filenamev([piDir, 'mode']), m);
    const savedProgram = w.harness.orchestrator.program, savedDialogs = w.harness.dialogs;
    w.harness.orchestrator.program = () => piScript;
    w.harness.dialogs = { ...savedDialogs, answer: () => null };
    w.settings.projects = { 'web-ecommerce': shop };
    const piBoard = put('development.md', PI_BOARD);
    w.load(piBoard);
    w.setOption('sidebar', false);
    settle(20);
    const waitFor = (cond: () => boolean, ms = 8000) => { for (let i = 0; i < ms / 10 && !cond(); i++) { pump(); GLib.usleep(10000); } idle(200); return cond(); };
    const cardAt = (text: string) => {
        const b = w.board.getBoard();
        for (let column = 0; column < b.columns.length; column++) {
            const index = b.columns[column].cards.findIndex(c => c.text.startsWith(text));
            if (index >= 0) return { column, index, text: b.columns[column].cards[index].text };
        }
        throw new Error(`card "${text}" does not exist`);
    };
    const cardMenu = (text: string, label: string) => {
        const { column, index } = cardAt(text);
        const entry = findEntry(w.board.cardMenu(column, index), label);
        if (!entry?.run) throw new Error(`menu "${label}" does not exist for "${text}"`);
        entry.run();
    };
    const runOf = (text: string) => w.harness.orchestrator.queue.find(piBoard, cardAt(text).text);
    frame('pi', 8);
    piMode('slow');
    cardMenu('Checkout', 'Work on it with pi');
    cardMenu('Test the cart',  'Work on it with pi');
    waitFor(() => runOf('Checkout')?.status === 'working');
    frame('pi', 10);
    shot('pi-board');
    GLib.file_set_contents(GLib.build_filenamev([piDir, 'release']), '');
    waitFor(() => runOf('Checkout')?.status === 'done');
    waitFor(() => runOf('Test the cart')?.status === 'done');
    frame('pi', 8);
    piMode('ask');
    cardMenu('Tidy up the README', 'Work on it with pi');
    waitFor(() => runOf('Tidy up the README')?.status === 'waiting');
    frame('pi', 14);
    shot('pi-waiting');
    const ask = runOf('Tidy up the README')?.ask;
    if (ask) {
        whenDialogReady(() => findDialog('Answer pi'), dialog => {
            widgetPixbuf(dialog)?.savev(`${OUT}/pi-answer.png`, 'png', [], []);
            dialog.close();
        });
        waitPromise(harnessAskDialog(w.win, ask, 'pi'));
    }
    const done = runOf('Checkout');
    if (done) {
        const log = w.harness.showLog(done);
        idle(600);
        widgetPixbuf(log.window)!.savev(`${OUT}/pi-log.png`, 'png', [], []);
        log.window.destroy();
    }
    const waiting = runOf('Tidy up the README');
    if (waiting) w.harness.orchestrator.stop(waiting);
    waitFor(() => !w.harness.orchestrator.queue.runs.some(r => r.status === 'working' || r.status === 'waiting'));
    w.harness.orchestrator.program = savedProgram;
    w.harness.dialogs = savedDialogs;
    w.editor.buffer.set_modified(false);

    // ───────── The daily flow: Home, Inbox, Journal (one work folder, relative dates so Home always has due dates) ─────────
    const day = (offset: number) => { const d = new Date(); d.setDate(d.getDate() + offset); return localDate(d); };
    const flowDir = GLib.build_filenamev([GLib.dir_make_tmp('nyerat-flow-XXXXXX'), 'nyerat-launch']);
    const flowPut = (rel: string, text: string) => {
        const path = GLib.build_filenamev([flowDir, ...rel.split('/')]);
        GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
        GLib.file_set_contents(path, text);
        return path;
    };
    for (const [rel, text] of Object.entries(WORK)) flowPut(rel, text);
    const flowBoard = flowPut('tasks.md', `---\nkanban: true\nproject: launch\n---\n\n## Plan\n\n- [ ] Prepare the release material #marketing @{${day(1)}}\n- [ ] Write the release notes #docs @{${day(2)}}\n\n## In Progress\n\n- [ ] Fix the sync bug #bug #important @{${day(0)}}\n\n## Done\n\n- [x] Redesign the home page #design\n`);
    const flowInbox = flowPut('inbox.md', `---\ninbox: true\n---\n\n# Inbox\n\nA place to capture ideas, notes, and things to process later.\n\n- Read the article about the GNOME HIG #read ➕ ${day(0)} 08:10\n- Idea: offer a PDF export #idea ➕ ${day(-1)} 17:45\n`);
    w.openFolder(flowDir, false);
    w.setOption('chat', false);
    w.setOption('sidebar', true);
    w.sidebar.setPage('files');
    w.setDark(false);
    // Toasts from earlier scenes expire (3 s each, one at a time) and new ones are not shown, so they do not cover the frames.
    w.toast = () => {};
    idle(30000);
    w.settings.recentFiles = [];   // so Continue only shows this folder's files, not the earlier scenes'
    const flowFrame = (gif: string, hold = 0) => frame(gif, hold);
    for (const rel of ['plans/launch.md', 'notes/meeting-1-oct.md', 'research/users.md']) w.openFile(GLib.build_filenamev([flowDir, ...rel.split('/')]));
    while (w.documentCount > 1) w.closeTab();
    w.file = null;
    ed.setText('');
    w.editor.buffer.set_modified(false);
    w.settings.recentFiles = w.settings.recentFiles.filter(r => r.path.startsWith(`${flowDir}/`));
    w.openHome();
    idle(600);
    flowFrame('home', 10);
    // Home → check the task that is due today: written straight back to its board.
    const due = w.homePage.data().tasks.find(t => t.card.startsWith('Fix the sync bug'));
    if (due) w.home.onToggleTask(due, true);
    w.refreshHome();
    idle(400);
    flowFrame('home', 6);
    w.journal.addNote('Standup: the sync bug is done, the beta is next');
    idle(400);
    flowFrame('home', 12);

    w.openFile(flowInbox);
    idle(500);
    flowFrame('inbox', 8);
    for (const text of ['Ask Dewi about the beta schedule #question', 'Write the release notes for 1.0 #docs']) {
        w.inbox.capture(text);
        idle(300);
        flowFrame('inbox', 8);
    }
    w.editor.buffer.set_modified(false);

    // A card moved on the board is recorded as activity, then merged into the journal.
    w.openFile(flowBoard);
    idle(500);
    let flow = parseBoard(w.editor.getText());
    flow = moveCard(flow, { column: 0, index: 0 }, { column: 1, index: 0 });
    w.board.commit(flow);
    idle(300);
    const journal = w.journal.open();
    if (journal) waitPromise(journal);
    idle(600);
    w.editor.view.scroll_to_iter(w.editor.buffer.get_start_iter(), 0, false, 0, 0);
    flowFrame('journal', 10);
    w.journal.addNote('? Does the beta need the sync fix first');
    idle(400);
    flowFrame('journal', 14);
    w.editor.buffer.set_modified(false);

    finishGifs();
    print(`Done: ${OUT}`);
    buf.set_modified(false);
    w.win.destroy();
}

const app = new Adw.Application({ application_id: 'com.ekaput.Nyerat.Capture', flags: Gio.ApplicationFlags.NON_UNIQUE });
app.connect('activate', () => {
    app.hold();
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        try { main(app); } catch (e) { printerr(e instanceof Error ? `${e.message}\n${e.stack}` : String(e)); }
        app.release();
        app.quit();
        return GLib.SOURCE_REMOVE;
    });
});
app.run([System.programInvocationName]);
