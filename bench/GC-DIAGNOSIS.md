# Diagnosis of GC callbacks in the extreme benchmark — 4 October 2026

The direct cause of the old failure is a **JavaScript callback dropped by the
GJS GC guard**, not simply a GC that takes a long time. Reproducing the old version
on 500 grids produced a `SourceFunc()` that was refused when GLib was about to
run the idle work. A lost callback can stop highlighting or the completion of the
`idle()` Promise, so the benchmark waits until the timeout.
This check made no change to the runtime code or the baseline.

## Evidence

- Environment: GJS 1.80.2 / SpiderMonkey 115, GLib 2.80.0, GTK 3.24.41,
  X11/Xvfb on the same machine.
- The old logs `/tmp/nyerat-perf-large-no-gc.log` and
  `/tmp/nyerat-perf-large-async-no-gc.log` contain `mark-set` on a
  `GtkSourceBuffer`, `changed` on a `GtkAdjustment`, `size-allocate`, and a blocked
  `SourceFunc()`. That buffer and view were still used by the benchmark.
- A checkout of commit `9f324c7` was extracted to `/tmp/nyerat-gc-old`, built with the
  same dependencies, and then run through GDB with
  `G_DEBUG=fatal-criticals`. On mixed 500 blocks, 1 repetition, the first warning
  appeared after `highlight() again`, before the typing report finished.
- The native stack at the first warning:
  `g_application_run → g_main_context_iteration → GLib source dispatch → libffi → libgjs → g_log`.
  There is no `gtk_widget_destroy`, widget disposal, or GC finalizer frame
  on that main thread stack. This does not match the guess that the `destroy`
  callback of a widget being collected is the direct trigger.
- That reproduction is in `/tmp/nyerat-gc-old-mixed-gdb.log`.
  The old version's run for long 2000 blocks, 3 repetitions, did finish under the
  debugger. The failure depends on the timing/state of the GC; it does not happen on every run.
- A second reproduction on mixed 500 blocks also failed, this time after redo, in the
  `changed` of a `GtkAdjustment`. GDB identified the main loop source as having
  priority **120**, named **`[gtk+] gdk_frame_clock_paint_idle`**:
  GTK was running an ordinary frame/layout, not a `destroy` callback.
  This evidence is in `/tmp/nyerat-gc-old-source-gdb.log`. So the affected path
  is not only the benchmark callbacks, but also GTK's layout signals.

## Runtime explanation and the limits of certainty

In the [GJS 1.80.2 callback guard](https://github.com/GNOME/gjs/blob/1.80.2/gi/function.cpp#L291),
`gjs->sweeping()` makes a callback be refused before the JavaScript function is called.
The [GObject signal](https://github.com/GNOME/gjs/blob/1.80.2/gi/value.cpp#L220) guard
does the same. The message about destroying a widget is generic text from that
guard; the message does not identify the widget that has the problem.

The [GC state management](https://github.com/GNOME/gjs/blob/1.80.2/gjs/context.cpp#L888)
turns on `m_in_gc_sweep` at the preparation of the group and only turns it off when
the whole collection ends. **The strongest guess** is that this flag is still active between the
steps of an incremental GC when the main loop has already gone back to running ordinary callbacks. The native
stack of the reproduction supports that guess, but the internal GC state has not been checked
directly with debug symbols, and GJS has not been tested with another patch/version.
So a bug in the integration of incremental GC is a reasoned guess, not a conclusion
verified upstream.

The source of allocation pressure in the old code is visible in `concealMarkers()`:
`starts.map(() => [])` makes an array for every line on every keystroke/cursor
move, and then the markers of the whole document make new tag tuples. On long there are
about 20,000 arrays per update, plus the merging of the highlighter cache the size of the
document. The old table layer also walked all the tables/tags and asked for the position of
all the grids. The current version has reduced this work through `MarkerConcealer`,
a lighter cache merge, incremental highlighting, and the calculation of the position of the
visible grids. The relation between the drop in allocations and the disappearance of the symptom has not been
isolated by A/B per change; do not assume that the GC problem is guaranteed to be solved.

A minimal test with one active `Gtk.TextBuffer` and 30 allocation rounds of 10 × 100,000
arrays/objects each finished with all 600 cursor signals received.
No widget was destroyed. This shows that allocation pressure alone in that
test was not enough to reproduce the problem, not that GJS is free of
GC problems.

## State of the latest code (`44cbc11`)

| Case | Repetitions | Result |
| --- | ---: | --- |
| long 2000 blocks, about 1.3 MB | 3 | All 14 GUI operations finished, the JSON was saved, no warning/critical |
| mixed 500 grids, about 148 KB | 10 | A 180 second timeout after the Enter report; no warning/critical, the JSON was not saved |
| mixed 500 grids, about 148 KB | 1 | All 14 GUI operations finished, the JSON was saved, no warning/critical |

The mixed run with 10 repetitions still shows progress between stages and high CPU
use. The current evidence fits better with a total duration that exceeds the limit,
not with repeated blocked GC callbacks like the old log. Opening is still
expensive: run 10 recorded a setText total of about 2.7 seconds and a longest pause of about
0.9 seconds. The 1-repetition result is only a diagnostic, not a new performance baseline.
Some debugger experiments ran at the same time as the diagnostic benchmark;
their timing numbers are not used to claim a before/after improvement.

The latest logs and samples:

- `/tmp/nyerat-gc-long2000.log`, `/tmp/nyerat-gc-long2000.json`
- `/tmp/nyerat-gc-mixed500.log` (the run of 10 that timed out, an incomplete result)
- `/tmp/nyerat-gc-mixed500-one.log`, `/tmp/nyerat-gc-mixed500-one.json`
- `/tmp/nyerat-gc-minimal.log`

The next check that would best tell the guesses apart is to capture the internal
GC state at a refused callback, or to test the old reproduction with a
runtime that changes the scope of the sweeping flag. For the performance of 500 tables, the problem of the
initial creation of all the grids needs to be profiled separately from the failure of the GC callbacks.
