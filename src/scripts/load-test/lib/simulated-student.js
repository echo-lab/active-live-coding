import { EventEmitter } from "node:events";
import { io } from "socket.io-client";
import { Text, ChangeSet } from "@codemirror/state";
import { SOCKET_MESSAGE_TYPE } from "../../../shared-constants.js";
import { timedPost } from "./rest-client.js";

const TRACKED_EVENTS = [
  SOCKET_MESSAGE_TYPE.EXERCISE_CREATED,
  SOCKET_MESSAGE_TYPE.EXERCISE_FINISHED,
  SOCKET_MESSAGE_TYPE.STUDENT_SUBMITTED,
  SOCKET_MESSAGE_TYPE.VERSION_BLOCK_CREATED,
  SOCKET_MESSAGE_TYPE.VARIANT_ADDED,
  SOCKET_MESSAGE_TYPE.INSTRUCTOR_OUT_OF_SYNC,
];

// A single simulated "browser tab": joins a lecture the same way student-page.js does
// (REST POST /current-session-student, then socket connect + JOIN_SESSION), and mirrors
// StudentCodeEditor's exact INSTRUCTOR_EDIT / catch-up logic (code-editors.js:235-301) against
// a local CodeMirror Text instead of a real EditorView, so document convergence can be checked
// without a browser.
export class SimulatedStudent extends EventEmitter {
  constructor({ serverUrl, sessionName, studentId = crypto.randomUUID(), studentIdentifier = null }) {
    super();
    this.serverUrl = serverUrl;
    this.sessionName = sessionName;
    this.studentId = studentId;
    this.studentIdentifier = studentIdentifier;

    this.doc = Text.empty;
    this.docVersion = 0;
    this.pendingQueue = [];
    this.catchupPending = false;
    this.active = true;
    this.desynced = null; // set if catch-up ever fails to reach the target version

    this.receivedEvents = [];
    this.outOfSyncCount = 0;

    this.socket = null;
    this.sessionNumber = null;
    this.studentSessionId = null;
  }

  // Mirrors student-page.js's initialize(): REST join first, then socket connect + JOIN_SESSION.
  async join() {
    const restResult = await timedPost(`${this.serverUrl}/current-session-student`, {
      student_id: this.studentId,
      student_identifier: this.studentIdentifier,
      sessionName: this.sessionName,
    });
    if (!restResult.ok) {
      return { ok: false, error: restResult.json?.error ?? restResult.error, restLatencyMs: restResult.latencyMs };
    }

    const { sessionNumber, studentSessionId, lectureDoc, lectureDocVersion } = restResult.json;
    if (sessionNumber == null) {
      return { ok: false, error: "No active lecture with that sessionName", restLatencyMs: restResult.latencyMs };
    }
    this.sessionNumber = sessionNumber;
    this.studentSessionId = studentSessionId;
    this.doc = Text.of(lectureDoc);
    this.docVersion = lectureDocVersion ?? 0;

    const connectT0 = performance.now();
    this.socket = io(this.serverUrl, { forceNew: true });
    this.#registerListeners();
    await new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("connect_error", reject);
    });
    const socketConnectLatencyMs = performance.now() - connectT0;

    this.socket.emit(SOCKET_MESSAGE_TYPE.JOIN_SESSION, this.sessionNumber);

    return {
      ok: true,
      restLatencyMs: restResult.latencyMs,
      socketConnectLatencyMs,
      sessionNumber,
      docVersion: this.docVersion,
    };
  }

  #registerListeners() {
    this.socket.on(SOCKET_MESSAGE_TYPE.INSTRUCTOR_EDIT, (msg) => {
      const receivedAt = performance.now();
      this.receivedEvents.push({ type: SOCKET_MESSAGE_TYPE.INSTRUCTOR_EDIT, payload: msg, receivedAt });
      this.emit(SOCKET_MESSAGE_TYPE.INSTRUCTOR_EDIT, msg, receivedAt);
      this.#handleInstructorEdit(msg);
    });

    for (const type of TRACKED_EVENTS) {
      this.socket.on(type, (payload) => {
        const receivedAt = performance.now();
        this.receivedEvents.push({ type, payload, receivedAt });
        if (type === SOCKET_MESSAGE_TYPE.INSTRUCTOR_OUT_OF_SYNC) this.outOfSyncCount++;
        this.emit(type, payload, receivedAt);
      });
    }
  }

  // Exact port of StudentCodeEditor.handleInstructorEdit (code-editors.js:235-277), applying to
  // a plain CodeMirror Text rather than dispatching to an EditorView.
  async #handleInstructorEdit({ changes, id }) {
    if (!this.active) return;

    if (id !== this.docVersion) {
      this.pendingQueue.push({ changes, id });
      if (this.catchupPending) return;
      this.catchupPending = true;
      await this.#catchUpOnChanges();
      this.catchupPending = false;

      if (id > this.docVersion) {
        this.active = false;
        this.desynced = { expectedAtLeast: id, stuckAt: this.docVersion };
        return;
      }

      this.pendingQueue.forEach(({ changes, id }) => {
        if (id !== this.docVersion) return;
        this.docVersion++;
        this.doc = ChangeSet.fromJSON(changes).apply(this.doc);
      });
      this.pendingQueue = [];
      return;
    }

    this.doc = ChangeSet.fromJSON(changes).apply(this.doc);
    this.docVersion++;
  }

  // Exact port of StudentCodeEditor.catchUpOnChanges (code-editors.js:279-301).
  async #catchUpOnChanges() {
    const res = await fetch(`${this.serverUrl}/instructor-changes/${this.sessionNumber}/${this.docVersion}`);
    const json = await res.json();
    if (!json.changes) return;
    for (const { change, changeNumber } of json.changes) {
      if (changeNumber !== this.docVersion) continue;
      this.docVersion++;
      this.doc = ChangeSet.fromJSON(change).apply(this.doc);
    }
  }

  getDocText() {
    return this.doc.toString();
  }

  // Mirrors StudentActivitiesManager.submitResponse (activities-manager.js:371-386).
  async submitResponse({ exerciseId, answer }) {
    const restResult = await timedPost(`${this.serverUrl}/exercise/response`, {
      exerciseId,
      student_id: this.studentId,
      answer,
    });
    if (!restResult.ok) return { ok: false, error: restResult.json?.error ?? restResult.error, restLatencyMs: restResult.latencyMs };

    this.socket.emit(SOCKET_MESSAGE_TYPE.STUDENT_SUBMITTED, {
      sessionNumber: this.sessionNumber,
      exerciseId,
      student_id: this.studentId,
      student_identifier: this.studentIdentifier,
      answer,
      responseId: restResult.json.responseId,
    });
    return { ok: true, restLatencyMs: restResult.latencyMs, responseId: restResult.json.responseId };
  }

  // Resolves with the first (already-received or future) event of `type` matching `predicate`.
  waitForEvent(type, { timeoutMs = 5000, predicate = () => true } = {}) {
    const existing = this.receivedEvents.find((e) => e.type === type && predicate(e.payload));
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(type, handler);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${type}`));
      }, timeoutMs);
      const handler = (payload, receivedAt) => {
        if (!predicate(payload)) return;
        clearTimeout(timer);
        this.off(type, handler);
        resolve({ type, payload, receivedAt });
      };
      this.on(type, handler);
    });
  }

  countReceived(type, predicate = () => true) {
    return this.receivedEvents.filter((e) => e.type === type && predicate(e.payload)).length;
  }

  // Reproduces the suspected reconnect bug's exact mechanism: a fresh transport reconnect gets a
  // new server-side socket id. `rejoinOnReconnect` opts into the proposed fix (re-emit
  // JOIN_SESSION on "connect") so the harness can validate the fix before it ships client-side.
  forceDisconnectReconnect({ rejoinOnReconnect = false } = {}) {
    return new Promise((resolve) => {
      this.socket.once("connect", () => {
        if (rejoinOnReconnect) this.socket.emit(SOCKET_MESSAGE_TYPE.JOIN_SESSION, this.sessionNumber);
        resolve();
      });
      this.socket.disconnect();
      this.socket.connect();
    });
  }

  close() {
    this.socket?.close();
  }
}
