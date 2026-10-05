// Tes otomatis Nyerat. Dibundel Vite menjadi dist/run-tests.js.
//
//   npm test                                         build, lalu semua tes termasuk mouse di Xvfb
//   npm run test:ui                                 build, lalu semua tes termasuk mouse di desktop
//   gjs -m dist/run-tests.js --no-gui                hanya tes konversi Markdown → HTML
//   gjs -m dist/run-tests.js --mouse                 tambah klik mouse sungguhan (pointer akan bergerak)
//   gjs -m dist/run-tests.js --screenshot=a.png      simpan tangkapan layar jendela editor
//   gjs -m dist/run-tests.js --shot-proposal=/tmp/p  simpan tangkapan jendela tinjau usulan agent (/tmp/p-<n>-tinjau.png dan -utama.png)
//   gjs -m dist/run-tests.js --shot-harness=/tmp/h   simpan tangkapan papan dengan kartu pi bekerja/antre dan log pi (/tmp/h-papan.png, -log.png)
//
// Tes GUI membuka jendela sungguhan, jadi perlu sesi desktop (X11/Wayland).


import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import System from 'system';

import { DIM, GREEN, RED, RESET, errorMessage, opt, optVal, recordFailure, setRoot, summary } from './framework.js';
import { WELCOME } from '../src/welcome.js';
import { createContext } from './gui/context.js';
import { widgetPixbuf } from './widgets.js';
import { incrementalTests } from './unit/incremental.js';
import { inlineTests } from './unit/inline.js';
import { settingsTests } from './unit/settings.js';
import { tableTests } from './unit/table.js';
import { kanbanModelTests } from './unit/kanban.js';
import { codeLanguageTests } from './unit/codelang.js';
import { htmlTests } from './unit/html.js';
import { dbmlTests } from './unit/dbml.js';
import { gitLogTests } from './unit/gitlog.js';
import { fileOpsTests } from './unit/fileops.js';
import { agentTests, apiKeyTests, toolTests } from './unit/agent.js';
import { transcriptTests } from './unit/transcript.js';
import { agenticTests } from './unit/agentic.js';
import { agentActionTests } from './unit/agentactions.js';
import { workTests } from './unit/work.js';
import { traceTests } from './unit/trace.js';
import { changeTests } from './unit/changes.js';
import { deepseekTests } from './unit/deepseek.js';
import { harnessTests as harnessModelTests } from './unit/harness.js';
import { harnessTests } from './gui/harness.js';
import { chatTests } from './gui/chat.js';
import { syntaxHidingTests } from './gui/syntax.js';
import { listTests } from './gui/lists.js';
import { formatTests } from './gui/format.js';
import { fileTests } from './gui/file.js';
import { imageTests } from './gui/image.js';
import { imageZoomTests } from './gui/imagezoom.js';
import { codeColorTests } from './gui/codecolor.js';
import { mermaidTests } from './gui/mermaid.js';
import { tableGridTests } from './gui/table.js';
import { kanbanBoardTests } from './gui/kanban.js';
import { kanbanMouseTests } from './gui/kanban-mouse.js';
import { folderTests } from './gui/folder.js';
import { folderMouseTests } from './gui/folder-mouse.js';
import { sampleTests } from './gui/sample.js';
import { windowSizeTests } from './gui/window.js';
import { robustnessTests } from './gui/robust.js';
import { historyTests } from './gui/history.js';
import { tabTests } from './gui/tabs.js';

setRoot(import.meta.url);

function runUnitTests(): void {
    inlineTests();
    incrementalTests();
    settingsTests();
    tableTests();
    kanbanModelTests();
    codeLanguageTests();
    htmlTests();
    dbmlTests();
    gitLogTests();
    fileOpsTests();
    agentTests();
    apiKeyTests();
    toolTests();
    transcriptTests();
    workTests();
    traceTests();
    agenticTests();
    agentActionTests();
    changeTests();
    deepseekTests();
    harnessModelTests();
}

function runGuiTests(app: Gtk.Application): void {
    const c = createContext(app);
    if (opt('only-chat')) {
        chatTests(c);
        c.buf.set_modified(false);
        c.w.win.destroy();
        return;
    }
    const { w, ed, buf, pump, setText, cursorTo } = c;
    pump();

    syntaxHidingTests(c);
    listTests(c);
    formatTests(c);
    fileTests(c);
    imageTests(c);
    imageZoomTests(c);
    codeColorTests(c);
    tableGridTests(c);
    mermaidTests(c);
    kanbanBoardTests(c);
    harnessTests(c);
    // Tes folder membuat jendela lain dan mengganti aksi aplikasi. Periksa undo/redo
    // mouse selagi aksi masih terhubung ke jendela konteks ini.
    if (opt('with-kanban-mouse')) kanbanMouseTests(c);
    folderTests(c);
    if (opt('with-kanban-mouse')) folderMouseTests(c);
    sampleTests(c);
    windowSizeTests(c);
    tabTests(c);
    historyTests(c);
    chatTests(c);
    robustnessTests(c);

    const shot = optVal('screenshot');
    if (shot) {
        setText(WELCOME);
        cursorTo(0);
        ed.view.scroll_to_iter(buf.get_start_iter(), 0, false, 0, 0);
        for (let i = 0; i < 20; i++) { pump(); GLib.usleep(20000); }
        widgetPixbuf(w.win)?.savev(shot, 'png', [], []);
        print(`\n${DIM}Tangkapan layar: ${shot}${RESET}`);
    }

    buf.set_modified(false);
    w.win.destroy();
}

// ───────────────────────── Jalankan ─────────────────────────

runUnitTests();

if (opt('with-kanban-mouse') && opt('no-gui')) {
    recordFailure();
    print(`${RED}Opsi tes mouse tidak bisa digabung dengan --no-gui.${RESET}`);
}

if (!opt('no-gui')) {
    if (!Gdk.Display.get_default() && !GLib.getenv('DISPLAY') && !GLib.getenv('WAYLAND_DISPLAY')) {
        if (opt('with-kanban-mouse')) recordFailure();
        print(`\n${DIM}Tes GUI dilewati: tidak ada display.${RESET}`);
    } else {
        const app = new Gtk.Application({ application_id: 'id.eka.Nyerat.Test', flags: Gio.ApplicationFlags.NON_UNIQUE });
        app.connect('activate', () => {
            app.hold();
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                try {
                    runGuiTests(app);
                } catch (e) {
                    recordFailure();
                    print(`${RED}Tes GUI berhenti: ${errorMessage(e)}${RESET}\n${e instanceof Error ? e.stack : ''}`);
                }
                app.release();
                app.quit();
                return GLib.SOURCE_REMOVE;
            });
        });
        app.run([System.programInvocationName]);
    }
}

const { passed, failed } = summary();
print(`\n${failed ? RED : GREEN}${passed} lulus, ${failed} gagal${RESET}`);
System.exit(failed ? 1 : 0);
