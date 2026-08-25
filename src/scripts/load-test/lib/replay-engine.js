import { io } from "socket.io-client";
import { SOCKET_MESSAGE_TYPE } from "../../../shared-constants.js";
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
    uuid: result.json.uuid,
    sessionName,
    userId,
    restLatencyMs: result.latencyMs,
  };
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
// edit in order, over the real socket + server-side ChangeBuffer path (not a raw DB insert) --
// this exercises the exact code path flagged by change-buffer.js's
// "// FIXME: these might not get executed in order!" comment. Edit ids are renumbered
// sequentially by array index (fixture-io.js already enforces this at load time), matching a
// fresh lecture's docVersion starting at 0.
export async function replayInstructorEdits({ serverUrl, sessionNumber, edits, pace = "max", onEditSent }) {
  const socket = io(serverUrl, { forceNew: true });
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

    const sentAt = performance.now();
    socket.emit(SOCKET_MESSAGE_TYPE.INSTRUCTOR_EDIT, {
      sessionId: sessionNumber,
      id: i,
      changes: edit.changes,
      ts: Date.now(),
    });
    onEditSent?.(edit, i, sentAt);
  }

  const elapsedMs = performance.now() - t0;
  // Grace period so the last few emits actually land server-side before we disconnect --
  // excluded from elapsedMs so it doesn't skew the realtime-pacing tolerance check.
  await sleep(300);
  socket.close();
  return { elapsedMs, editCount: edits.length };
}
