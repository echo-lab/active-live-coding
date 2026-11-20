// pyodide-webworker.js

importScripts("https://cdn.jsdelivr.net/pyodide/v0.26.1/full/pyodide.js");
// importScripts("https://cdn.jsdelivr.net/pyodide/v314.0.8/full/pyodide.js");

// Text accumulated since the last flush, per stream -- may or may not end in a newline yet.
let stdoutText = "";
let stderrText = "";
// Decoders are stateful (they hold onto a trailing incomplete multi-byte UTF-8 sequence between
// calls via {stream: true}), so each needs to be its own instance per stream.
let stdoutDecoder = new TextDecoder();
let stderrDecoder = new TextDecoder();

let pendingStdout = [];
let pendingStderr = [];
let flushTimer = null;
let currentRunId = null;
let control = null; // Int32Array(sab, 0, 2) view, or null if SharedArrayBuffer is unavailable.
let textBytes = null; // Uint8Array(sab, 8, 4088) view, or null.

const FLUSH_INTERVAL_MS = 75;

// Splits accumulated stream text on newlines. Complete (newline-terminated) lines are always
// returned for flushing; an incomplete trailing fragment is only returned (instead of held back
// for the next call) when forcePartial is true.
function consumeLines(text, forcePartial) {
  let idx = text.lastIndexOf("\n");
  let lines = idx === -1 ? [] : text.slice(0, idx).split("\n");
  let remainder = idx === -1 ? text : text.slice(idx + 1);
  if (forcePartial && remainder.length > 0) {
    lines.push(remainder);
    remainder = "";
  }
  return { lines, remainder };
}

// Regular (non-forcing) flushes only ever emit complete lines -- an in-progress, not-yet-newline-
// terminated line is held back so it doesn't get split across two separate <pre> rows in the UI.
// forcePartial (used right before blocking on input() and at run end) also emits whatever's left,
// since at those points nothing more is coming to complete the line.
function flushOutput(forcePartial = false) {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  let out = consumeLines(stdoutText, forcePartial);
  stdoutText = out.remainder;
  pendingStdout.push(...out.lines);

  let err = consumeLines(stderrText, forcePartial);
  stderrText = err.remainder;
  pendingStderr.push(...err.lines);

  if (pendingStdout.length === 0 && pendingStderr.length === 0) return;
  self.postMessage({ type: "output", runId: currentRunId, stdout: pendingStdout, stderr: pendingStderr });
  pendingStdout = [];
  pendingStderr = [];
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushOutput();
  }, FLUSH_INTERVAL_MS);
}

// Blocks the worker thread (via Atomics.wait) until the main thread writes an answer into the
// shared buffer and calls Atomics.notify -- this is what lets Python's input() genuinely pause
// mid-execution for a real human to answer, rather than erroring immediately. If no shared buffer
// was provided (e.g. the page isn't cross-origin isolated), input() can't block at all, so we
// return undefined (EOF) and let Python raise its normal EOFError.
function blockingStdin() {
  // Force-flush: input()'s prompt has no trailing newline, and Pyodide's own flush-on-read
  // doesn't reliably surface unterminated text (see setStdout's "raw" mode below), so without
  // this the prompt would only appear later, folded into whatever gets printed after the answer.
  flushOutput(/* forcePartial */ true);
  if (!control) return undefined;

  self.postMessage({ type: "awaiting-input", runId: currentRunId });
  Atomics.wait(control, 0, 0);

  const length = control[1];
  const bytes = textBytes.slice(0, length);
  Atomics.store(control, 0, 0); // reset so the next input() call actually blocks instead of
  // immediately seeing this call's already-consumed "ready" flag
  return new TextDecoder().decode(bytes);
}

async function loadPyodideAndPackages() {
  self.pyodide = await loadPyodide();
  // "raw" (per-byte) mode, not "batched" (per-line): Pyodide's batched handler is documented to
  // also fire on an explicit flush of an unterminated line, but doesn't reliably do so in
  // practice (a long-standing upstream bug) -- and input()'s prompt is exactly that case, an
  // unterminated write immediately followed by a flush. Decoding raw bytes ourselves and doing
  // our own newline splitting (above) sidesteps that bug entirely.
  self.pyodide.setStderr({ raw: (byte) => { stderrText += stderrDecoder.decode(new Uint8Array([byte]), { stream: true }); scheduleFlush(); } });
  self.pyodide.setStdout({ raw: (byte) => { stdoutText += stdoutDecoder.decode(new Uint8Array([byte]), { stream: true }); scheduleFlush(); } });
  self.pyodide.setStdin({ stdin: blockingStdin });
  // Remember the pristine import path once, so each run can reset it (see prepareProjectFiles).
  self.pyodide.runPython("import sys\n_ORIGINAL_SYS_PATH = list(sys.path)");
  self.postMessage({ type: "ready" });
}

// MARK: Lecture files
// Every run gets a fresh copy of all the lecture's files under PROJECT_ROOT, laid out by path, so the
// file being run can `import` the others. Mirrors `cd PROJECT_ROOT && python <entryPath>`: the
// working directory is the project root, and sys.path[0] is the entry file's own directory.
const PROJECT_ROOT = "/home/pyodide/lecture";

function prepareProjectFiles(files, entryPath) {
  const py = self.pyodide;
  // Start from scratch so deleted/renamed files don't linger between runs.
  py.runPython(`import shutil\nshutil.rmtree(${JSON.stringify(PROJECT_ROOT)}, ignore_errors=True)`);
  py.FS.mkdirTree(PROJECT_ROOT);
  for (const { path, content } of files) {
    const fullPath = `${PROJECT_ROOT}/${path}`;
    py.FS.mkdirTree(fullPath.slice(0, fullPath.lastIndexOf("/")));
    py.FS.writeFile(fullPath, content ?? "");
  }
  const entryDir = entryPath.includes("/") ? `${PROJECT_ROOT}/${entryPath.slice(0, entryPath.lastIndexOf("/"))}` : PROJECT_ROOT;
  // Drop modules imported from the project by earlier runs (so edits are picked up), then reset
  // the import path and working directory.
  py.runPython(`
import importlib, os, sys
_root = ${JSON.stringify(PROJECT_ROOT)} + "/"
for _name, _mod in list(sys.modules.items()):
    _locations = [getattr(_mod, "__file__", None) or ""] + list(getattr(_mod, "__path__", None) or [])
    if any(str(_loc).startswith(_root) for _loc in _locations):
        del sys.modules[_name]
sys.path[:] = [${JSON.stringify(entryDir)}] + _ORIGINAL_SYS_PATH
os.chdir(${JSON.stringify(PROJECT_ROOT)})
importlib.invalidate_caches()
`);
  return `${PROJECT_ROOT}/${entryPath}`;
}
let pyodideReadyPromise = loadPyodideAndPackages();

// Makes a Python traceback read like one from `python main.py`: drops the frames from Pyodide's
// own runner (which every traceback starts with), and shows project files by their path in the
// lecture ("helpers.py" rather than "/home/pyodide/lecture/helpers.py").
function cleanTraceback(message) {
  const lines = message.split("\n");
  const kept = [];
  let skipping = false;
  for (const line of lines) {
    if (line.startsWith('  File "')) skipping = line.startsWith('  File "/lib/python');
    else if (!line.startsWith("    ")) skipping = false; // left the frame (e.g. the error line)
    if (!skipping) kept.push(line);
  }
  return kept.join("\n").replaceAll(`"${PROJECT_ROOT}/`, '"');
}

self.onmessage = async (event) => {
  // make sure loading is done
  await pyodideReadyPromise;

  const { runId, python, files, entryPath, sab } = event.data;
  currentRunId = runId;
  if (sab) {
    control = new Int32Array(sab, 0, 2);
    textBytes = new Uint8Array(sab, 8, 4088);
  } else {
    control = null;
    textBytes = null;
  }
  stdoutText = "";
  stderrText = "";
  stdoutDecoder = new TextDecoder();
  stderrDecoder = new TextDecoder();
  pendingStdout = [];
  pendingStderr = [];

  const dict = self.pyodide.globals.get("dict");
  const globals = dict();
  globals.set("__name__", "__main__");
  try {
    let filename;
    if (files && entryPath) {
      filename = prepareProjectFiles(files, entryPath);
      globals.set("__file__", filename);
    }
    self.postMessage({ type: "status", runId, message: "Loading packages…" });
    // Any file might be imported, so look for third-party packages across all of them.
    const allSource = files ? [python, ...files.map((f) => f.content ?? "")].join("\n") : python;
    await self.pyodide.loadPackagesFromImports(allSource);
    let results = await self.pyodide.runPythonAsync(python, {
      globals,
      locals: globals,
      // Real file names in tracebacks (see cleanTraceback).
      ...(filename ? { filename } : {}),
    });
    flushOutput(/* forcePartial */ true);
    self.postMessage({ type: "end", runId, results });
  } catch (error) {
    flushOutput(/* forcePartial */ true);
    self.postMessage({ type: "end", runId, error: cleanTraceback(error.message ?? String(error)) });
  }
  globals.destroy();
  dict.destroy();
};
