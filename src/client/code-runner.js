const MAX_RUNTIME = /*seconds=*/ 60 * 1000;
const SAB_SIZE = 4096;
const MAX_INPUT_CHARS = 1000; // worst-case UTF-8 expansion (x4) still fits in the 4088-byte text region

export class PythonCodeRunner {
  constructor() {
    this.currentRunId = null;
    this.currentCallbacks = null;
    this.runtimeTimeoutHandle = null;

    // SharedArrayBuffer requires a cross-origin-isolated page (see server COOP/COEP headers).
    // If it's unavailable, every run still works normally -- only input() itself degrades to an
    // immediate EOFError, handled entirely inside the worker.
    try {
      this.sab = new SharedArrayBuffer(SAB_SIZE);
    } catch {
      this.sab = null;
    }

    this.restartWebWorker();
  }

  restartWebWorker() {
    console.log("Restarting web worker");
    this.worker?.terminate();
    this.worker = new Worker(
      new URL("./pyodide-webworker.js", import.meta.url)
    );
    this.worker.onmessage = (event) => this._handleWorkerMessage(event.data);
  }

  _handleWorkerMessage(data) {
    if (data.type === "ready") {
      this.onWorkerReady?.();
      return;
    }
    if (data.runId !== this.currentRunId || !this.currentCallbacks) return;
    const { onOutput, onStatus, onAwaitingInput, onEnd } = this.currentCallbacks;
    switch (data.type) {
      case "output":
        onOutput({ stdout: data.stdout, stderr: data.stderr });
        break;
      case "status":
        onStatus(data.message);
        break;
      case "awaiting-input":
        this._clearRuntimeTimeout();
        onAwaitingInput();
        break;
      case "end":
        this._clearRuntimeTimeout();
        this.currentRunId = null;
        this.currentCallbacks = null;
        onEnd({ results: data.results, error: data.error });
        break;
    }
  }

  _clearRuntimeTimeout() {
    if (this.runtimeTimeoutHandle) {
      clearTimeout(this.runtimeTimeoutHandle);
      this.runtimeTimeoutHandle = null;
    }
  }

  _startRuntimeTimeout() {
    this._clearRuntimeTimeout();
    this.runtimeTimeoutHandle = setTimeout(() => {
      const onEnd = this.currentCallbacks?.onEnd;
      this.currentRunId = null;
      this.currentCallbacks = null;
      this.runtimeTimeoutHandle = null;
      onEnd?.({ timedOut: true, error: "[CANCELLED DUE TO TIMEOUT]" });
      this.restartWebWorker();
    }, MAX_RUNTIME);
  }

  // Starts a run and returns its runId immediately. Callbacks fire as the worker streams events:
  // onOutput({stdout, stderr}), onStatus(message), onAwaitingInput(), onEnd({results, error}).
  startRun(code, { onOutput, onStatus, onAwaitingInput, onEnd }) {
    const runId = crypto.randomUUID();
    this.currentRunId = runId;
    this.currentCallbacks = { onOutput, onStatus, onAwaitingInput, onEnd };
    this._startRuntimeTimeout();
    this.worker.postMessage({ runId, python: code, sab: this.sab });
    return runId;
  }

  // Wakes a worker blocked in input() with the given text. Restarts the runtime timeout, since
  // the budget should only ever measure Python execution time, never how long a human took to type.
  submitInput(runId, text) {
    if (runId !== this.currentRunId) {
      console.warn("submitInput called for a run that is no longer active:", runId);
      return;
    }
    const control = new Int32Array(this.sab, 0, 2);
    const bytes = new TextEncoder().encode(text.slice(0, MAX_INPUT_CHARS));
    const textBytes = new Uint8Array(this.sab, 8, 4088);
    textBytes.set(bytes);
    Atomics.store(control, 1, bytes.length);
    Atomics.store(control, 0, 1);
    Atomics.notify(control, 0);
    this._startRuntimeTimeout();
  }

  // Cancels the current run (used by the Stop button). Since there's no way to interrupt a
  // running/blocked worker gracefully, this terminates and recreates it -- the same mechanism
  // already used for timeouts.
  cancel() {
    if (!this.currentRunId) return;
    const onEnd = this.currentCallbacks?.onEnd;
    this.currentRunId = null;
    this.currentCallbacks = null;
    this._clearRuntimeTimeout();
    onEnd?.({ cancelled: true, error: "[CANCELLED BY USER]" });
    this.restartWebWorker();
  }
}
