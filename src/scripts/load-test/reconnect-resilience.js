// Empirically checks the suspected "reconnect doesn't rejoin the lecture room" bug: JOIN_SESSION
// is emitted exactly once on initial page load (student-page.js:108, instructor.js:140) with no
// socket.on("connect", ...) handler to re-emit it on reconnect. A reconnected socket gets a new
// server-side id that's never rejoined to lecture-<id>, so it should silently stop receiving
// broadcasts. --simulate-fix lets the harness validate the proposed one-line fix before it's
// applied to the real client code.
//
// Usage:
//   node src/scripts/load-test/reconnect-resilience.js --students 50 --disconnect-fraction 0.3
//   node src/scripts/load-test/reconnect-resilience.js --students 50 --disconnect-fraction 0.3 --simulate-fix
import { io } from "socket.io-client";
import { ChangeSet } from "@codemirror/state";
import { SOCKET_MESSAGE_TYPE } from "../../shared-constants.js";
import { parseArgs, DEFAULT_SERVER_URL } from "./lib/cli-args.js";
import { SimulatedStudent } from "./lib/simulated-student.js";
import { createFreshLecture } from "./lib/replay-engine.js";
import { writeResults } from "./lib/results.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usage() {
  console.log(`Usage:
  node src/scripts/load-test/reconnect-resilience.js [--students 50] [--disconnect-fraction 0.3]
    [--simulate-fix] [--session-name <name>] [--server <url>]`);
}

// Only delivery matters here, not content realism -- builds `count` sequential single-character
// inserts starting at doc length `startLength`, with absolute ids starting at `startId`.
function makeSyntheticEdits(count, startId, startLength) {
  const edits = [];
  let length = startLength;
  for (let i = 0; i < count; i++) {
    const changes = ChangeSet.of({ from: length, to: length, insert: "x" }, length).toJSON();
    edits.push({ id: startId + i, changes, ts: Date.now() + i * 10 });
    length += 1;
  }
  return edits;
}

function sendEdits(socket, sessionNumber, edits) {
  for (const edit of edits) {
    socket.emit(SOCKET_MESSAGE_TYPE.INSTRUCTOR_EDIT, { sessionId: sessionNumber, id: edit.id, changes: edit.changes, ts: Date.now() });
  }
}

function receivedIds(student) {
  return student.receivedEvents.filter((e) => e.type === SOCKET_MESSAGE_TYPE.INSTRUCTOR_EDIT).map((e) => e.payload.id);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const serverUrl = args.server ?? DEFAULT_SERVER_URL;
  const studentCount = Number(args.students ?? 50);
  const disconnectFraction = Number(args["disconnect-fraction"] ?? 0.3);
  const simulateFix = Boolean(args["simulate-fix"]);
  const sessionName = args["session-name"] ?? `LOAD_TEST_reconnect_${Date.now()}`;

  const lecture = await createFreshLecture({ serverUrl, sessionName });
  console.log(`Created fresh lecture #${lecture.sessionNumber} "${sessionName}"`);

  const studentIds = Array.from({ length: studentCount }, () => crypto.randomUUID());
  const students = studentIds.map((id) => new SimulatedStudent({ serverUrl, sessionName, studentId: id }));

  console.log(`Joining ${studentCount} students...`);
  const joinResults = await Promise.allSettled(students.map((s) => s.join()));
  const joinErrors = joinResults.filter((r) => r.status === "rejected" || !r.value.ok);
  if (joinErrors.length > 0) {
    throw new Error(`${joinErrors.length}/${studentCount} students failed to join -- aborting reconnect-resilience`);
  }

  const instructorSocket = io(serverUrl, { forceNew: true });
  await new Promise((resolve, reject) => {
    instructorSocket.once("connect", resolve);
    instructorSocket.once("connect_error", reject);
  });
  instructorSocket.emit(SOCKET_MESSAGE_TYPE.JOIN_SESSION, lecture.sessionNumber);
  await sleep(300);

  // Baseline: everyone should receive this -- a harness sanity check, not the bug under test.
  console.log("Sending baseline batch (5 edits)...");
  sendEdits(instructorSocket, lecture.sessionNumber, makeSyntheticEdits(5, 0, 0));
  await sleep(1000);

  const baselineMisses = students.filter((s) => receivedIds(s).length !== 5);
  console.log(`Baseline receipt: ${studentCount - baselineMisses.length}/${studentCount}`);

  const disconnectCount = Math.round(studentCount * disconnectFraction);
  const disconnectedGroup = students.slice(0, disconnectCount);
  const controlGroup = students.slice(disconnectCount);
  console.log(`Force-disconnecting ${disconnectCount}/${studentCount} students (simulate-fix=${simulateFix})...`);
  await Promise.all(disconnectedGroup.map((s) => s.forceDisconnectReconnect({ rejoinOnReconnect: simulateFix })));

  // JOIN_SESSION has no ack, so a socket's "connect" event firing only means the client has
  // queued the rejoin emit, not that the server has processed it yet. Give it a moment before
  // broadcasting the after-batch, same as the settle window in broadcast-latency.js.
  await sleep(300);

  console.log("Sending after-batch (5 more edits, continuing docVersion)...");
  sendEdits(instructorSocket, lecture.sessionNumber, makeSyntheticEdits(5, 5, 5));
  await sleep(1500);

  const afterIdsExpected = [5, 6, 7, 8, 9];
  const controlReceived = controlGroup.map((s) => afterIdsExpected.every((id) => receivedIds(s).includes(id)));
  const controlReceiptRate = controlReceived.filter(Boolean).length / (controlGroup.length || 1);

  const reconnectedReceived = disconnectedGroup.map((s) => afterIdsExpected.every((id) => receivedIds(s).includes(id)));
  const reconnectedReceiptRate = reconnectedReceived.filter(Boolean).length / (disconnectedGroup.length || 1);

  console.log(`\nControl group (never disconnected) after-batch receipt: ${(controlReceiptRate * 100).toFixed(0)}%`);
  console.log(`Reconnected group after-batch receipt: ${(reconnectedReceiptRate * 100).toFixed(0)}%`);

  let verdict;
  if (controlReceiptRate < 1 || baselineMisses.length > 0) {
    verdict = "HARNESS ISSUE -- baseline or control group didn't get 100% receipt; results below are not meaningful. Check server is running and reachable.";
  } else if (simulateFix) {
    verdict = reconnectedReceiptRate === 1
      ? "Fix validated: rejoin-on-reconnect resolves delivery for the reconnected group."
      : `Fix did NOT fully resolve delivery (${(reconnectedReceiptRate * 100).toFixed(0)}%) -- the bug may be more subtle than the static-analysis theory.`;
  } else if (reconnectedReceiptRate === 0) {
    verdict = "Bug CONFIRMED: reconnected sockets receive none of the post-reconnect broadcasts.";
  } else if (reconnectedReceiptRate === 1) {
    verdict = "Bug REFUTED: reconnected sockets received all post-reconnect broadcasts.";
  } else {
    verdict = `INCONSISTENT (${(reconnectedReceiptRate * 100).toFixed(0)}%) -- partial receipt is a different, more surprising finding than the all-or-nothing bug suspected from static analysis. Investigate further.`;
  }
  console.log(`\n${verdict}`);

  students.forEach((s) => s.close());
  instructorSocket.close();

  writeResults("reconnect-resilience", {
    serverUrl, sessionName, studentCount, disconnectFraction, disconnectCount, simulateFix,
    baselineMissCount: baselineMisses.length, controlReceiptRate, reconnectedReceiptRate, verdict,
  });

  const harnessOk = controlReceiptRate === 1 && baselineMisses.length === 0;
  process.exit(harnessOk ? 0 : 1);
}

main().catch((error) => {
  console.error("reconnect-resilience failed:", error.message);
  process.exit(1);
});
