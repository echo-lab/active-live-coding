import { io } from "socket.io-client";
import { SOCKET_MESSAGE_TYPE, getMainFile } from "../../../shared-constants.js";
import { timedPost } from "./rest-client.js";

// Mirrors POST /lecture-session's find-or-create-by-name semantics (main.js:109-146).
// Callers should pass a unique sessionName (e.g. `LOAD_TEST_${Date.now()}`) to guarantee a
// fresh, disposable lecture rather than reusing an existing one.
export async function createFreshLecture({ serverUrl, sessionName, userId = "load-test-instructor" }) {
  const result = await timedPost(`${serverUrl}/lecture-session`, { sessionName, userId });
  if (!result.ok) {
    throw new Error(`Failed to create lecture "${sessionName}": ${result.json?.error ?? result.error}`);
  }
  return {
    sessionNumber: result.json.sessionNumber,
    fileId: getMainFile(result.json.files)?.id,
    // name -> id, for every file the lecture has (just main.py, for a fresh one).
    fileIds: new Map((result.json.files ?? []).map((f) => [f.name, f.id])),
    uuid: result.json.uuid,
    sessionName,
    userId,
    restLatencyMs: result.latencyMs,
  };
}

// Creates (through the real POST /file endpoint, as the instructor) every fixture file the
// lecture doesn't have yet, and adds them to `lecture.fileIds`.
export async function createFixtureFiles({ serverUrl, lecture, fileNames }) {
  for (const path of fileNames) {
    if (lecture.fileIds.has(path)) continue;
    const result = await timedPost(`${serverUrl}/file`, { lectureId: lecture.sessionNumber, userId: lecture.userId, path });
    if (!result.ok) throw new Error(`Failed to create file "${path}": ${result.json?.error ?? result.error}`);
    lecture.fileIds.set(path, result.json.file.id);
  }
  return lecture.fileIds;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function delayForPace(pace, deltaMs) {
  if (pace === "max") return 0;
  if (pace === "realtime") return deltaMs;
  if (typeof pace === "number" && pace > 0) return deltaMs / pace; // speed multiplier, e.g. 5 = 5x realtime
  throw new Error(`Unknown pace: ${pace} (expected "max", "realtime", or a positive number)`);
}

// Connects one socket.io-client as "the instructor" and emits INSTRUCTOR_EDIT for each fixture
// edit in order (edits to different files interleaved, as recorded), over the real socket +
// server-side doc store path (not a raw DB insert). Each edit goes to `fileIds.get(edit.fileName)`
// (see createFixtureFiles), falling back to `fileId` (the main file) for edits without a fileName;
// its id is its per-file doc version, which matches a fresh file's docVersion starting at 0
// (fixture-io.js enforces contiguity at load time).
// `userId` must be the lecture's instructor_id (lecture.userId) -- the server drops instructor
// messages from any other socket (asInstructor in main.js).
export async function replayInstructorEdits({ serverUrl, sessionNumber, userId, fileId, fileIds = new Map(), edits, pace = "max", onEditSent }) {
  const socket = io(serverUrl, { forceNew: true, auth: { userId } });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  socket.emit(SOCKET_MESSAGE_TYPE.JOIN_SESSION, sessionNumber);

  const t0 = performance.now();
  let prevTs = edits[0]?.ts ?? 0;

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    if (i > 0) {
      // Always yield (even for a 0ms "max"-pace delay) -- Engine.io flushes its write buffer
      // asynchronously, not synchronously inside emit(), so a tight loop with zero event-loop
      // yields can queue every edit without ever actually writing them to the transport.
      const delay = delayForPace(pace, Math.max(0, edit.ts - prevTs));
      await sleep(delay);
    }
    prevTs = edit.ts;

    const editFileId = (edit.fileName != null ? fileIds.get(edit.fileName) : null) ?? fileId;
    if (editFileId == null) throw new Error(`No file id for "${edit.fileName}" -- create the fixture's files first`);
    const sentAt = performance.now();
    socket.emit(SOCKET_MESSAGE_TYPE.INSTRUCTOR_EDIT, {
      sessionId: sessionNumber,
      fileId: editFileId,
      id: edit.id ?? i,
      changes: edit.changes,
      ts: Date.now(),
    });
    onEditSent?.(edit, i, sentAt, editFileId);
  }

  const elapsedMs = performance.now() - t0;
  // Grace period so the last few emits actually land server-side before we disconnect --
  // excluded from elapsedMs so it doesn't skew the realtime-pacing tolerance check.
  await sleep(300);
  socket.close();
  return { elapsedMs, editCount: edits.length };
}
