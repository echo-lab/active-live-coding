import { EventEmitter } from "node:events";
import { io } from "socket.io-client";
import { Text, ChangeSet } from "@codemirror/state";
import { SOCKET_MESSAGE_TYPE, getMainFile } from "../../../shared-constants.js";
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
// StudentCodeEditor's exact INSTRUCTOR_EDIT / catch-up logic (code-editors.js) against a local
// CodeMirror Text per file instead of a real EditorView, so document convergence can be checked
// without a browser. Like StudentWorkspace, it routes each edit to its file by fileId and picks up
// files the instructor creates mid-lecture (FILE_CREATED).
export class SimulatedStudent extends EventEmitter {
  constructor({ serverUrl, sessionName, studentId = crypto.randomUUID(), studentIdentifier = null }) {
    super();
    this.serverUrl = serverUrl;
    this.sessionName = sessionName;
    this.studentId = studentId;
    this.studentIdentifier = studentIdentifier;

    // fileId -> {name, doc, docVersion, pendingQueue, catchupPending, active}
    this.files = new Map();
    this.fileId = null; // the main file
    this.desynced = null; // set if catch-up ever fails to reach the target version (in any file)

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

    const { sessionNumber, studentSessionId, files } = restResult.json;
    const mainFile = getMainFile(files);
    if (sessionNumber == null) {
      return { ok: false, error: "No active lecture with that sessionName", restLatencyMs: restResult.latencyMs };
    }
    this.sessionNumber = sessionNumber;
    this.studentSessionId = studentSessionId;
    this.fileId = mainFile?.id ?? null;
    for (const file of files ?? []) this.#addFile(file);

    const connectT0 = performance.now();
    this.socket = io(this.serverUrl, { forceNew: true });
    this.#registerListeners();
    await new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("connect_error", reject);
    });
    const socketConnectLatencyMs = performance.now() - connectT0;

    this.socket.emit(SOCKET_MESSAGE_TYPE.JOIN_SESSION, this.sessionNumber);
    // Mirrors joinLectureRoom (src/client/utils.js): re-join the room on every reconnect, and note
    // whether Socket.IO's connection state recovery restored the session (and replayed what was
    // missed) or this is a brand-new session (the real client would show its "reload" banner).
    this.reconnects = [];
    this.socket.on("connect", () => {
      this.socket.emit(SOCKET_MESSAGE_TYPE.JOIN_SESSION, this.sessionNumber);
      this.reconnects.push({ recovered: this.socket.recovered });
    });

    return {
      ok: true,
      restLatencyMs: restResult.latencyMs,
      socketConnectLatencyMs,
      sessionNumber,
      docVersion: this.docVersion,
    };
  }

  #registerListeners() {
    this.socket.on(SOCKET_MESSAGE_TYPE.FILE_CREATED, ({ file }) => this.#addFile(file));
    this.socket.on(SOCKET_MESSAGE_TYPE.FILES_RENAMED, ({ renames }) => {
      for (const { id, name } of renames) if (this.files.has(id)) this.files.get(id).name = name;
    });
    this.socket.on(SOCKET_MESSAGE_TYPE.FILES_DELETED, ({ fileIds }) => {
      for (const id of fileIds) this.files.delete(id);
    });
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

  // Idempotent: FILE_CREATED may arrive for a file the join payload already had.
  #addFile({ id, name, doc, docVersion }) {
    if (this.files.has(id)) return;
    this.files.set(id, {
      name,
      doc: Text.of(doc ?? [""]),
      docVersion: docVersion ?? 0,
      pendingQueue: [],
      catchupPending: false,
      active: true,
    });
  }

  // The main file's version (what the single-file scripts check).
  get docVersion() {
    return this.files.get(this.fileId)?.docVersion ?? 0;
  }

  // Exact port of StudentCodeEditor.handleInstructorEdit (code-editors.js), applying to the
  // file's plain CodeMirror Text rather than dispatching to an EditorView.
  async #handleInstructorEdit({ changes, id, fileId }) {
    const file = this.files.get(fileId);
    if (!file?.active) return;

    if (id !== file.docVersion) {
      file.pendingQueue.push({ changes, id });
      if (file.catchupPending) return;
      file.catchupPending = true;
      await this.#catchUpOnChanges(fileId, file);
      file.catchupPending = false;

      if (id > file.docVersion) {
        file.active = false;
        this.desynced = { fileId, expectedAtLeast: id, stuckAt: file.docVersion };
        return;
      }

      file.pendingQueue.forEach(({ changes, id }) => {
        if (id !== file.docVersion) return;
        file.docVersion++;
        file.doc = ChangeSet.fromJSON(changes).apply(file.doc);
      });
      file.pendingQueue = [];
      return;
    }

    file.doc = ChangeSet.fromJSON(changes).apply(file.doc);
    file.docVersion++;
  }

  // Port of StudentCodeEditor.catchUpOnChanges: re-fetch the file's whole latest doc.
  async #catchUpOnChanges(fileId, file) {
    const res = await fetch(`${this.serverUrl}/doc/${fileId}`);
    const json = await res.json();
    if (json.error || json.docVersion == null || json.docVersion < file.docVersion) return;
    file.doc = Text.of(json.doc);
    file.docVersion = json.docVersion;
  }

  // The given file's text (default: the main file), or null if this student doesn't have it.
  getDocText(fileId = this.fileId) {
    return this.files.get(fileId)?.doc.toString() ?? null;
  }

  // name -> text for every file this student has.
  getFileTexts() {
    return new Map([...this.files.values()].map((f) => [f.name, f.doc.toString()]));
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

  // A real network drop (wifi blip): closes the underlying transport without telling Socket.IO
  // it was intentional, so the server keeps the session around for connection state recovery and
  // the client auto-reconnects after ~offlineMs. Resolves once disconnected, with `reconnected`, a
  // promise that resolves to {recovered} when the socket is back.
  async simulateNetworkDrop({ offlineMs = 1500 } = {}) {
    const manager = this.socket.io;
    const saved = [manager.reconnectionDelay(), manager.reconnectionDelayMax(), manager.randomizationFactor()];
    manager.reconnectionDelay(offlineMs).reconnectionDelayMax(offlineMs).randomizationFactor(0);
    const disconnected = new Promise((resolve) => this.socket.once("disconnect", resolve));
    const reconnected = new Promise((resolve) => {
      this.socket.once("connect", () => {
        manager.reconnectionDelay(saved[0]).reconnectionDelayMax(saved[1]).randomizationFactor(saved[2]);
        resolve({ recovered: this.socket.recovered });
      });
    });
    manager.engine.close();
    await disconnected;
    return { reconnected };
  }

  // An intentional disconnect + reconnect, which Socket.IO never recovers -- stands in for a gap
  // too long to recover (or a server restart): the socket gets a brand-new server-side session and
  // only the rejoin-on-connect handler gets it back into the lecture room.
  freshReconnect() {
    return new Promise((resolve) => {
      this.socket.once("connect", () => resolve({ recovered: this.socket.recovered }));
      this.socket.disconnect();
      this.socket.connect();
    });
  }

  close() {
    this.socket?.close();
  }
}
