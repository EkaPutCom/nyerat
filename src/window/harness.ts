// External harnesses (@pi cards): the card menu, choosing the project folder, answering/steering/replying to a run,
// and its log window. The runs themselves are managed by the Orchestrator this controller owns.

import GLib from 'gi://GLib';
import { after, type Awaitable } from '../gtkutil.js';
import { readTextFile } from '../files.js';
import type { AppSettings } from '../settings.js';
import { Orchestrator } from '../orchestrator.js';
import { cardProject, checkProjectFolder, HARNESSES, isActive, PROJECT_NAME, type HarnessAsk, type HarnessReply, type LinkedNote, type Run } from '../agent/harness.js';
import { chooseFile, harnessAskDialog, harnessTextDialog } from '../ui/dialogs.js';
import type { KanbanBoard } from '../ui/kanban.js';
import { LogViewer } from '../ui/logviewer.js';
import type { MenuEntry } from '../ui/menu.js';
import { harnessActivity, type ActivityKind } from '../markdown/journal.js';
import { assignCard, cardMeta, updateCard, type Board, type Card, type Position } from '../markdown/kanban.js';
import { noteSection, resolveWikiLink, type WikiLink } from '../markdown/wikilink.js';
import type { WorkspaceRepository } from '../workspace.js';
import { _, fmt } from '../i18n.js';
import { docFor, type DocumentHost } from './doc.js';

export interface HarnessHost extends DocumentHost {
    readonly settings: AppSettings;
    readonly board: KanbanBoard;
    readonly workspace: WorkspaceRepository;
    boardShown(file: string): boolean;    // the board in `file` is the one on screen
    updateBoardFile(file: string, edit: (board: Board) => Board): string | null;
    record(kind: ActivityKind, text: string): void;
    refreshHome(): void;
}

export class HarnessController {
    readonly orchestrator: Orchestrator;
    // Harness dialogs can be replaced in tests with immediate answers; the real dialog answers through a Promise.
    dialogs: {
        chooseFolder: (title: string) => Awaitable<string | null>;
        answer: (ask: HarnessAsk, agent: string) => Awaitable<HarnessReply | null>;
        text: (options: { title: string; label: string; context?: string }) => Awaitable<string | null>;
    } = {
        chooseFolder: title => chooseFile(this.host.win, { title, selectFolder: true }),
        answer: (ask, agent) => harnessAskDialog(this.host.win, ask, agent),
        text: options => harnessTextDialog(this.host.win, options),
    };
    private readonly logs = new Map<number, LogViewer>();
    private readonly logged = new WeakSet<object>();   // results already recorded in the activity log

    constructor(private readonly host: HarnessHost) {
        this.orchestrator = new Orchestrator({
            workspace: () => host.root(),
            updateBoard: (file, edit) => host.updateBoardFile(file, edit),
            linkedNotes: (file, links) => this.linkedNotes(file, links),
            changed: (run, message) => {
                if (run.result && (run.status === 'done' || run.status === 'failed') && !this.logged.has(run.result)) {
                    this.logged.add(run.result);
                    host.record('harness', harnessActivity(HARNESSES[run.agent]?.label ?? run.agent, run.title, run.project, run.status === 'done'));
                }
                if (host.boardShown(run.board)) host.board.queueRender();
                host.refreshHome();
                if (message) host.toast(message);
            },
        });
    }

    // The status of the run for a card on the board that is shown, for its badge.
    status(card: Card): Run['status'] | null {
        const file = this.host.active().file;
        return (file && this.orchestrator.queue.find(file, card.text)?.status) || null;
    }

    // Notes linked by the cards on the board `boardFile`, for the harness prompt context. Looked up with the same rules
    // as Ctrl+click; the document that is currently open is read from its editor so unsaved edits are included.
    private linkedNotes(boardFile: string, links: WikiLink[]): LinkedNote[] {
        const workspace = this.host.root();
        const root = workspace && boardFile.startsWith(`${workspace}/`) ? workspace : GLib.path_get_dirname(boardFile);
        const from = boardFile.slice(root.length + 1);
        const files = this.host.workspace.names(root);
        return links.map(link => {
            const file = resolveWikiLink(link.target, files, from);
            if (!file) return { link, file: null, text: null };
            const path = GLib.build_filenamev([root, ...file.split('/')]);
            let text: string;
            try {
                text = docFor(this.host, path)?.editor.getText() ?? readTextFile(path);
            } catch {
                return { link, file: null, text: null };
            }
            return { link, file, text: link.heading ? noteSection(text, link.heading) : text };
        });
    }

    // Card menu entries to assign, stop, and monitor harnesses.
    menu(card: Card, at: Position): MenuEntry[] {
        const file = this.host.active().file;
        const run = file ? this.orchestrator.queue.find(file, card.text) : null;
        const active = run && isActive(run.status) ? run : null;
        return [...this.assignEntries(card, at, !!file && !active), ...(run ? this.runEntries(run, active) : []), ...this.cardEntries(card, at, !active)];
    }

    // "Work on it with …" for every harness; only on a saved board, for a card that is not done or already running.
    private assignEntries(card: Card, at: Position, free: boolean): MenuEntry[] {
        return Object.values(HARNESSES).map(spec => ({
            label: fmt(_('Work on it with {label}'), { label: spec.label }),
            enabled: free && card.done !== true,
            run: () => this.run(at, spec.name),
        }));
    }

    // The card's run: answer or steer it while it is going, reply after it finished, stop it, and view its log.
    private runEntries(run: Run, active: Run | null): MenuEntry[] {
        const entries: MenuEntry[] = [];
        if (active?.status === 'waiting') entries.push({ label: fmt(_('Answer {agent}…'), { agent: active.agent }), run: () => this.answer(active) });
        if (active?.status === 'working') entries.push({ label: fmt(_('Steer {agent}…'), { agent: active.agent }), run: () => this.steer(active) });
        if (!active && run.result?.sessionId) entries.push({ label: fmt(_('Reply to {agent}…'), { agent: run.agent }), run: () => this.reply(run) });
        if (active) entries.push({ label: active.status === 'queued' ? _('Cancel Queue') : fmt(_('Stop {agent}'), { agent: active.agent }), run: () => this.orchestrator.stop(active) });
        entries.push({ label: fmt(_('View {agent} Log'), { agent: run.agent }), run: () => this.showLog(run) });
        return entries;
    }

    // Removing an assignment (when nothing runs) and changing the card's remembered project folder.
    private cardEntries(card: Card, at: Position, idle: boolean): MenuEntry[] {
        const board = this.host.board;
        const entries: MenuEntry[] = [];
        if (cardMeta(card.text).agent && idle) entries.push({ label: _('Remove Assignment'), run: () => board.commit(updateCard(board.getBoard(), at, { text: assignCard(card.text, null) })) });
        const project = cardProject(board.getBoard(), card);
        if (project && this.host.settings.projects[project]) entries.push({ label: _('Change Project Folder…'), run: () => this.chooseProjectFolder(project) });
        return entries;
    }

    // Run a harness for a card on the active board. The project folder is asked once and then remembered in the settings.
    run(at: Position, agent: string): void {
        const board = this.host.board;
        const file = this.host.active().file;
        if (!file) { this.host.toast(_('Save the board first before assigning cards')); return; }
        const card = board.getBoard().columns[at.column]?.cards[at.index];
        if (!card) return;
        const project = cardProject(board.getBoard(), card);
        if (project && this.host.settings.projects[project]) {
            this.start(file, at, agent, project);
            return;
        }
        void after(this.chooseProjectFolder(project), folder => {
            if (!folder) return;
            // The folder dialog can stay open for a long time: the assigned card must still be on the same board.
            if (this.host.active().file !== file || board.getBoard().columns[at.column]?.cards[at.index]?.text !== card.text) {
                this.host.toast(_('The board changed while choosing a folder; assign the card again'));
                return;
            }
            if (!project) {
                // No project name yet: use the folder name and note it on the card so the next turn does not ask again.
                const tagged = `${card.text} #project/${folder.name}`;
                board.commit(updateCard(board.getBoard(), at, { text: tagged }));
            }
            this.start(file, at, agent, project ?? folder.name);
        });
    }

    private start(file: string, at: Position, agent: string, project: string): void {
        const error = this.orchestrator.start(file, this.host.board.getBoard(), at, agent, project, this.host.settings.projects[project], GLib.path_get_basename(file));
        if (error) this.host.toast(fmt(_('Cannot run {agent}: {error}'), { agent, error }));
    }

    // Choose a folder for project `name` (or a new project if null) and save the mapping.
    private chooseProjectFolder(name: string | null): Awaitable<{ name: string; path: string } | null> {
        return after(this.dialogs.chooseFolder(name ? fmt(_('Project folder “{name}”'), { name }) : _('Choose a project folder')), path => this.mapProjectFolder(name, path));
    }

    private mapProjectFolder(name: string | null, path: string | null): { name: string; path: string } | null {
        if (!path) return null;
        const project = name ?? GLib.path_get_basename(path).replace(/\s+/g, '-');
        const problem = !PROJECT_NAME.test(project) ? fmt(_('the folder name "{name}" cannot be used as a project name'), { name: project }) : checkProjectFolder(path, this.host.root());
        if (problem) { this.host.toast(fmt(_('Project folder rejected: {problem}'), { problem })); return null; }
        this.host.settings.projects = { ...this.host.settings.projects, [project]: path };
        return { name: project, path };
    }

    answer(run: Run): void {
        if (!run.ask) return;
        void after(this.dialogs.answer(run.ask, run.agent), reply => {
            if (!reply) return;   // Later: the harness keeps waiting
            const error = this.orchestrator.answer(run, reply);
            if (error) this.host.toast(fmt(_('The answer was not sent: {error}'), { error }));
        });
    }

    private steer(run: Run): void {
        void after(this.dialogs.text({ title: fmt(_('Steering for {agent}'), { agent: run.agent }), label: fmt(_('{agent} receives it before its next step, without stopping the work.'), { agent: run.agent }) }), text => {
            if (!text) return;
            const error = this.orchestrator.steer(run, text);
            this.host.toast(error ? fmt(_('The steering was not sent: {error}'), { error }) : fmt(_('Steering sent to {agent}'), { agent: run.agent }));
        });
    }

    private reply(run: Run): void {
        void after(this.dialogs.text({ title: fmt(_('Reply to {agent}'), { agent: run.agent }), label: fmt(_('The {agent} session continues with this reply; the card goes back to being worked on.'), { agent: run.agent }), context: run.result?.summary || undefined }), text => {
            if (!text) return;
            const error = this.orchestrator.resume(run, text);
            if (error) this.host.toast(fmt(_('Cannot reply to {agent}: {error}'), { agent: run.agent, error }));
        });
    }

    showLog(run: Run): LogViewer {
        const open = this.logs.get(run.id);
        if (open?.window.get_realized()) { open.show(); return open; }
        const viewer = new LogViewer(this.host.win, run.trace, fmt(_('{agent} Log — {title}'), { agent: run.agent, title: run.title }));
        this.logs.set(run.id, viewer);
        viewer.show();
        return viewer;
    }

    // From Home: an agent that is waiting for an answer is asked right away; one that is working shows its log; a queued one opens its board.
    open(id: number): void {
        const run = this.orchestrator.queue.runs.find(r => r.id === id);
        if (!run) return;
        if (run.status === 'waiting') this.answer(run);
        else if (run.status === 'working') this.showLog(run);
        else this.host.openInTab(run.board);
    }

    dispose(): void {
        this.orchestrator.dispose();
    }
}
