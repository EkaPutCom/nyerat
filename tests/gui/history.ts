// GUI tests: the git History tab.

import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import { HistoryViewer } from '../../src/ui/historyviewer.js';
import type { Commit } from '../../src/gitlog.js';
import { section, test, eq, ok, tmp } from '../framework.js';
import type { GuiContext } from './context.js';
import { iterAtLine } from '../../src/gtkutil.js';
import { childrenOf } from '../../src/gtkutil.js';
import { listRows } from '../widgets.js';

export function historyTests(c: GuiContext): void {
    const { w, pump, setText } = c;

    section('Git history');
    const repo = GLib.build_filenamev([tmp, 'repo-history']);
    const plain = GLib.build_filenamev([tmp, 'no-git']);
    GLib.mkdir_with_parents(repo, 0o755);
    GLib.mkdir_with_parents(plain, 0o755);
    const env = [...GLib.get_environ(), 'GIT_CONFIG_GLOBAL=/dev/null', 'GIT_CONFIG_SYSTEM=/dev/null'];
    const git = (...args: string[]) => {
        const [, , err, status] = GLib.spawn_sync(repo, ['git', '-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', ...args], env, GLib.SpawnFlags.SEARCH_PATH, null);
        if (status !== 0) throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(err ?? undefined)}`);
    };
    const write = (path: string, text: string) => GLib.file_set_contents(path, text);
    const waitFor = (cond: () => boolean) => {
        for (let i = 0; i < 500 && !cond(); i++) { pump(); GLib.usleep(10000); }
        return cond();
    };
    const rows = () => w.history.store.n_items;

    const a = GLib.build_filenamev([repo, 'a.md']);
    const untracked = GLib.build_filenamev([repo, 'new.md']);
    const outside = GLib.build_filenamev([plain, 'x.md']);
    const V1 = '# Title\n\none\n', V2 = '# Title\n\none\ntwo\n';
    git('init', '-q');
    write(a, V1);
    git('add', 'a.md');
    git('commit', '-q', '-m', 'Create note');
    write(a, V2);
    git('commit', '-q', '-a', '-m', 'Add line two');
    write(untracked, '# Not in git yet\n');
    write(outside, '# Outside the repo\n');

    w.sidebar.setVisible(true);
    w.sidebar.setPage('history');

    test('the history tab does not make the sidebar expand (the sidebar stays at the left edge, 240 wide)', () => {
        ok(!w.sidebar.panel.compute_expand(Gtk.Orientation.HORIZONTAL), 'the sidebar demands spare space');
        ok(!w.history.widget.compute_expand(Gtk.Orientation.HORIZONTAL), 'the history tab demands spare space');
        w.win.set_default_size(1600, 700);
        for (let i = 0; i < 40; i++) { pump(); GLib.usleep(15000); }
        const a = w.sidebar.panel.get_allocation();
        ok(a.width <= 260, `sidebar width  ${a.width}`);
        // Relative to the window contents: on a desktop, the window manager's decorations/shadow shift the toplevel allocation.
        const x = w.sidebar.panel.translate_coordinates(w.win.get_child()!, 0, 0)[1];
        // Restore the size: a window wider than the Xvfb screen puts buttons outside
        // the monitor, and a popover from such a button triggers Gdk-CRITICAL in GTK 4 (X11).
        w.win.set_default_size(1100, 700);
        for (let i = 0; i < 20; i++) { pump(); GLib.usleep(15000); }
        ok(x < 20, `the sidebar shifted to x=${x}`);
    });
    test('the uncommitted list with a message field does not make the sidebar expand', () => {
        ok(!w.history.commitBar.compute_expand(Gtk.Orientation.HORIZONTAL), 'the commit field demands spare space');
        ok(!w.history.changedBox.compute_expand(Gtk.Orientation.HORIZONTAL), 'the change list demands spare space');
    });
    test('the uncommitted list with a message field does not make the sidebar expand', () => {
        ok(!w.history.commitBar.compute_expand(Gtk.Orientation.HORIZONTAL), 'the commit field demands spare space');
        ok(!w.history.changedBox.compute_expand(Gtk.Orientation.HORIZONTAL), 'the change list demands spare space');
    });
    test('the file history is shown newest first', () => {
        w.load(a);
        ok(waitFor(() => rows() === 2), 'number of history rows');
        const label = (i: number) => (w.history.store.get_item(i) as unknown as { commit: { subject: string } }).commit.subject;
        eq([label(0), label(1)], ['Add line two', 'Create note']);
    });
    test('a file that is not committed yet shows the empty message', () => {
        w.load(untracked);
        ok(waitFor(() => rows() === 0 && w.history.note.label.includes('There are no commits')), `message: ${w.history.note.label}`);
        // The list is emptied first (clear()); the message replaces the list and must be shown.
        ok(w.history.note.get_mapped(), 'the message is not shown');
    });
    test('a file outside a git repository shows a message', () => {
        w.load(outside);
        ok(waitFor(() => w.history.note.label.includes('is not in a git repository')), `message: ${w.history.note.label}`);
    });
    test('a document without a file shows a hint to save', () => {
        w.history.setFile(null);
        ok(w.history.note.label.includes('Save the document'), `message: ${w.history.note.label}`);
        ok(w.history.note.get_mapped(), 'the message is not shown');
    });
    test('the history is not loaded while another tab is open', () => {
        w.sidebar.setPage('outline');
        w.load(a);
        pump();
        eq(rows(), 0, 'history rows');
        w.sidebar.setPage('history');
        ok(waitFor(() => rows() === 2), 'the history is loaded when the tab is opened');
    });
    test('reloading picks up the new commit', () => {
        write(a, V2 + 'three\n');
        git('commit', '-q', '-a', '-m', 'Add line three');
        w.history.refresh();
        ok(waitFor(() => rows() === 3), 'the new commit did not appear');
    });

    let commits: Commit[] = [];
    test('clicking a commit opens the viewer with the diff and the contents of that version', () => {
        w.history.onOpen = commit => { commits.push(commit); };
        w.history.list.emit('activate', 1);
        eq(commits.length, 1, 'the commit was opened');
        eq(commits[0].subject, 'Add line two');
        const viewer = new HistoryViewer(w.win, a, commits[0], false);
        try {
            const diff = () => viewer.diffView.buffer.get_text(viewer.diffView.buffer.get_start_iter(), viewer.diffView.buffer.get_end_iter(), false);
            ok(waitFor(() => diff().includes('+two')), `diff: ${diff()}`);
            ok(!diff().includes('diff --git'), 'the diff header was not removed');
            const table = viewer.diffView.buffer.get_tag_table();
            const lineTags = (n: number) => iterAtLine(viewer.diffView.buffer, n).get_tags().map(t => t.name);
            eq(lineTags(0), ['hunk'], 'hunk line tag');
            const added = diff().split('\n').findIndex(l => l === '+two');
            eq(lineTags(added), ['add'], 'added line tag');
            ok(table.lookup('del') !== null, 'the delete tag exists');
            const content = () => viewer.contentView.buffer.get_text(viewer.contentView.buffer.get_start_iter(), viewer.contentView.buffer.get_end_iter(), false);
            ok(waitFor(() => content() === V2), `contents of that version: ${JSON.stringify(content())}`);
            ok(!viewer.contentView.editable, 'the contents are editable');
            eq(viewer.diffView.wrap_mode, Gtk.WrapMode.WORD_CHAR, 'the diff is not wrapped');
            eq(viewer.contentView.wrap_mode, Gtk.WrapMode.WORD_CHAR, 'the contents are not wrapped');
        } finally {
            viewer.window.destroy();
        }
    });
    test('the viewer shows the contents of the first version for the initial commit', () => {
        const first = commits[0];
        w.history.onOpen = commit => { commits.push(commit); };
        w.history.list.emit('activate', 2);
        const root = commits[commits.length - 1];
        ok(root !== first, 'the initial commit was not opened');
        const viewer = new HistoryViewer(w.win, a, root, true);
        try {
            const content = () => viewer.contentView.buffer.get_text(viewer.contentView.buffer.get_start_iter(), viewer.contentView.buffer.get_end_iter(), false);
            ok(waitFor(() => content() === V1), `contents of the initial version: ${JSON.stringify(content())}`);
            const diff = () => viewer.diffView.buffer.get_text(viewer.diffView.buffer.get_start_iter(), viewer.diffView.buffer.get_end_iter(), false);
            ok(waitFor(() => diff().includes('+# Title')), `diff of the initial commit:  ${diff()}`);
        } finally {
            viewer.window.destroy();
        }
    });

    test('uncommitted changes appear as a button and a diff against HEAD', () => {
        w.load(a);
        ok(waitFor(() => rows() === 3), 'the history was loaded');
        ok(waitFor(() => !w.history.changes.get_visible()), 'the changes button is shown although the file is clean');
        write(a, V2 + 'three\nfour\n');
        w.history.refresh();
        ok(waitFor(() => w.history.changes.get_visible()), 'the changes button is not shown');
        ok(w.history.changes.label!.includes('Uncommitted changes'), String(w.history.changes.label));
        const viewer = new HistoryViewer(w.win, a, null, false);
        try {
            const diff = () => viewer.diffView.buffer.get_text(viewer.diffView.buffer.get_start_iter(), viewer.diffView.buffer.get_end_iter(), false);
            ok(waitFor(() => diff().includes('+four')), `diff: ${diff()}`);
            ok(!diff().includes('+three'), 'a committed line was shown as an addition');
            ok(viewer.stack.get_child_by_name('content') === null, 'the version contents tab appeared too');
        } finally {
            viewer.window.destroy();
        }
        git('commit', '-q', '-a', '-m', 'Add line four');
        w.history.refresh();
        ok(waitFor(() => !w.history.changes.get_visible()), 'the button did not vanish after the commit');
    });
    test('the diff of an untracked new file is its entire contents', () => {
        w.load(untracked);
        ok(waitFor(() => w.history.changes.get_visible()), 'the button is not shown');
        ok(w.history.changes.label!.includes('New file'), String(w.history.changes.label));
        const viewer = new HistoryViewer(w.win, untracked, null, false);
        try {
            const diff = () => viewer.diffView.buffer.get_text(viewer.diffView.buffer.get_start_iter(), viewer.diffView.buffer.get_end_iter(), false);
            ok(waitFor(() => diff().includes('+# Not in git yet')), `diff: ${diff()}`);
        } finally {
            viewer.window.destroy();
        }
    });

    test('committing from the changes window takes only that file', () => {
        write(a, V2 + 'three\nfour\nfive\n');
        write(untracked, '# Not in git yet\nchange\n');
        git('add', 'new.md');
        w.load(a);
        ok(waitFor(() => w.history.changes.get_visible()), 'changes button');
        const viewer = new HistoryViewer(w.win, a, null, false);
        let done = 0;
        viewer.onCommitted = () => { done++; };
        try {
            viewer.commitButton.emit('clicked');
            ok(viewer.status.get_text().includes('message'), 'an empty message was not rejected');
            eq(done, 0, 'commit without a message');
            viewer.messageEntry.set_text('Add line five');
            viewer.commitButton.emit('clicked');
            ok(waitFor(() => done === 1), `commit failed: ${viewer.closed ? '' : viewer.status.get_text()}`);
        } finally {
            if (!viewer.closed) viewer.window.destroy();   // a successful commit closes its own window
        }
        w.history.refresh();
        ok(waitFor(() => rows() === 5 && !w.history.changes.get_visible()), 'the history did not load the new commit');
        w.load(untracked);
        ok(waitFor(() => w.history.changes.get_visible()), 'the other file was committed too');
    });
    test('commit an untracked new file', () => {
        const viewer = new HistoryViewer(w.win, untracked, null, false);
        let done = 0;
        viewer.onCommitted = () => { done++; };
        try {
            viewer.messageEntry.set_text('Add a new note');
            viewer.commitButton.emit('clicked');
            ok(waitFor(() => done === 1), `commit failed: ${viewer.closed ? '' : viewer.status.get_text()}`);
        } finally {
            if (!viewer.closed) viewer.window.destroy();   // a successful commit closes its own window
        }
        w.history.refresh();
        ok(waitFor(() => rows() === 1 && !w.history.changes.get_visible()), 'history of the new file');
    });

    test('the list of all uncommitted files is shown and opens the diff of the clicked file', () => {
        const b = GLib.build_filenamev([repo, 'b.md']);
        write(b, '# B\n');
        git('add', 'b.md');
        git('commit', '-q', '-m', 'Add b');
        write(b, '# B\nchange\n');
        write(GLib.build_filenamev([repo, 'c.md']), '# C\n');
        w.load(a);
        w.history.refresh();
        const names = () => listRows(w.history.changedList).map(r => (childrenOf(r.get_child()!)[2] as Gtk.Label).label);
        ok(waitFor(() => names().length === 2), `list: ${names()}`);
        eq(names().sort(), ['b.md', 'c.md']);
        ok(w.history.changedBox.get_visible() && (w.history.changedBox.label ?? '').includes('(2)'), `label: ${w.history.changedBox.label}`);
        const opened: string[] = [];
        w.history.onOpenChanges = f => { opened.push(f); };
        const idx = names().indexOf('b.md');
        w.history.changedList.emit('row-activated', w.history.changedList.get_row_at_index(idx)!);
        eq(opened, [b], 'the opened file');
        const viewer = new HistoryViewer(w.win, b, null, false);
        try {
            const diff = () => viewer.diffView.buffer.get_text(viewer.diffView.buffer.get_start_iter(), viewer.diffView.buffer.get_end_iter(), false);
            ok(waitFor(() => diff().includes('+change')), `diff: ${diff()}`);
        } finally {
            viewer.window.destroy();
        }
        git('add', '-A');
        git('commit', '-q', '-m', 'Clean up');
        w.history.refresh();
        ok(waitFor(() => !w.history.changedBox.get_visible()), 'the list did not vanish after everything was committed');
        w.history.onOpenChanges = () => {};
    });

    test('several files are checked and then committed at once', () => {
        const b = GLib.build_filenamev([repo, 'b.md']);
        const c2 = GLib.build_filenamev([repo, 'c.md']);
        const e = GLib.build_filenamev([repo, 'e.md']);
        write(b, '# B\nagain\n');
        write(c2, '# C\nagain\n');
        write(e, '# E\n');
        git('add', 'c.md');
        w.load(a);
        w.history.refresh();
        const names = () => listRows(w.history.changedList).map(r => (childrenOf(r.get_child()!)[2] as Gtk.Label).label);
        ok(waitFor(() => names().length >= 3 && w.history.commitButton.label === 'Commit 3 files'), `list: ${names()} / ${w.history.commitButton.label}`);
        const check = (name: string) => (w.history.changedList.get_row_at_index(names().indexOf(name))!.get_child()!.get_first_child() as Gtk.CheckButton);
        check('e.md').active = false;
        eq(w.history.commitButton.label, 'Commit 2 files');
        w.history.commitButton.emit('clicked');
        ok(w.history.commitStatus.get_text().includes('message'), 'an empty message was not rejected');
        let done = 0;
        w.history.onCommitted = () => { done++; };
        w.history.messageEntry.set_text('Commit b and c');
        w.history.commitButton.emit('clicked');
        ok(waitFor(() => done === 1), `commit failed: ${w.history.commitStatus.get_text()}`);
        w.history.refresh();
        ok(waitFor(() => names().join() === 'e.md'), `rest of the list: ${names()}`);
        ok(!check('e.md').active, 'the e.md check vanished after reloading');
        eq(w.history.messageEntry.get_text(), '', 'the message was not cleared');
        git('add', '-A');
        git('commit', '-q', '-m', 'Clean up e');
        w.history.onCommitted = () => {};
        w.history.refresh();
        ok(waitFor(() => !w.history.changedBox.get_visible()), 'the list did not vanish');
    });

    test('without a file, the opened folder still shows the uncommitted files', () => {
        write(GLib.build_filenamev([repo, 'd.md']), '# D\n');
        w.file = null; setText('');
        w.history.setFile(null, true, repo);
        ok(waitFor(() => listRows(w.history.changedList).length === 1), 'the list is empty although the folder has a new file');
        ok(w.history.note.label.includes('Save the document'), 'the save hint vanished');
        w.history.setFile(null, true, null);
        ok(waitFor(() => listRows(w.history.changedList).length === 0), 'the list was not emptied without a folder');
    });

    // Restore the state for the next tests.
    w.history.onOpen = () => {};
    w.sidebar.setPage('outline');
    w.file = null; setText('');
}
