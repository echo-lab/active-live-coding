// Checks that students who lose their connection mid-lecture keep (or regain) the live feed.
// Students are split into three groups:
//
//   - control:   never disconnects.
//   - drop:      loses its network for ~--offline-ms (transport closed, not an intentional
//                disconnect). While they're offline the instructor sends edits AND an exercise.
//                Socket.IO's connection state recovery (main.js) should restore their session and
//                replay everything they missed, in order.
//   - fresh:     an intentional disconnect + reconnect, which Socket.IO never recovers -- standing
//                in for a gap too long to recover, or a server restart. These students can't get
//                the missed broadcasts back (the real client shows a "reload" banner); what's
//                checked is that rejoin-on-connect (joinLectureRoom in src/client/utils.js) puts
//                them back in the lecture room so they get everything sent AFTER they're back.
//
// Usage:
//   node src/scripts/load-test/reconnect-resilience.js --students 50 --disconnect-fraction 0.3
//   node src/scripts/load-test/reconnect-resilience.js --students 50 --offline-ms 3000
import { io } from "socket.io-client";
import { ChangeSet } from "@codemirror/state";
import { SOCKET_MESSAGE_TYPE } from "../../shared-constants.js";
import { parseArgs, DEFAULT_SERVER_URL } from "./lib/cli-args.js";
import { SimulatedStudent } from "./lib/simulated-student.js";
import { createFreshLecture } from "./lib/replay-engine.js";
import { writeResults } from "./lib/results.js";
import { printVerdict } from "./lib/stats.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Only delivery matters here, not content realism -- builds `count` sequential single-character
// inserts starting at doc length `startLength`, with absolute ids starting at `startId`.
function makeSyntheticEdits(count, startId, startLength) {
  const edits = [];
  let length = startLength;
  for (let i = 0; i < count; i++) {
    const changes = ChangeSet.of({ from: length, to: length, insert: "x" }, length).toJSON();
    edits.push({ id: startId + i, changes });
    length += 1;
  }
  return edits;
}

function sendEdits(socket, { sessionNumber, fileId }, edits) {
  for (const edit of edits) {
    socket.emit(SOCKET_MESSAGE_TYPE.INSTRUCTOR_EDIT, { sessionId: sessionNumber, fileId, id: edit.id, changes: edit.changes, ts: Date.now() });
  }
}

const range = (from, to) => Array.from({ length: to - from }, (_, i) => from + i);

function editIds(student) {
  return student.receivedEvents.filter((e) => e.type === SOCKET_MESSAGE_TYPE.INSTRUCTOR_EDIT).map((e) => e.payload.id);
}

function gotAll(student, ids) {
  const received = new Set(editIds(student));
  return ids.every((id) => received.has(id));
}

function gotExercise(student, exerciseId) {
  return student.receivedEvents.some((e) => e.type === SOCKET_MESSAGE_TYPE.EXERCISE_CREATED && e.payload.exerciseId === exerciseId);
}

// Edits must arrive in order (the student editor depends on it); recovery replays them in order.
function inOrder(student) {
  const ids = editIds(student);
  return ids.every((id, i) => i === 0 || id > ids[i - 1]);
}

const rate = (group, pred) => (group.length === 0 ? 1 : group.filter(pred).length / group.length);
const pct = (r) => `${(r * 100).toFixed(0)}%`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const serverUrl = args.server ?? DEFAULT_SERVER_URL;
  const studentCount = Number(args.students ?? 50);
  const disconnectFraction = Number(args["disconnect-fraction"] ?? 0.3);
  const offlineMs = Number(args["offline-ms"] ?? 1500);
  const sessionName = args["session-name"] ?? `LOAD_TEST_reconnect_${Date.now()}`;

  const lecture = await createFreshLecture({ serverUrl, sessionName });
  console.log(`Created fresh lecture #${lecture.sessionNumber} "${sessionName}"`);

  const students = Array.from({ length: studentCount }, () => new SimulatedStudent({ serverUrl, sessionName }));
  console.log(`Joining ${studentCount} students...`);
  const joinResults = await Promise.allSettled(students.map((s) => s.join()));
  const joinErrors = joinResults.filter((r) => r.status === "rejected" || !r.value.ok);
  if (joinErrors.length > 0) {
    throw new Error(`${joinErrors.length}/${studentCount} students failed to join -- aborting reconnect-resilience`);
  }

  const instructorSocket = io(serverUrl, { forceNew: true, auth: { userId: lecture.userId } });
  await new Promise((resolve, reject) => {
    instructorSocket.once("connect", resolve);
    instructorSocket.once("connect_error", reject);
  });
  instructorSocket.emit(SOCKET_MESSAGE_TYPE.JOIN_SESSION, lecture.sessionNumber);
  await sleep(300);

  // Baseline: everyone should receive this -- a harness sanity check.
  console.log("Sending baseline batch (edits 0-4)...");
  sendEdits(instructorSocket, lecture, makeSyntheticEdits(5, 0, 0));
  await sleep(1000);
  const baselineMisses = students.filter((s) => !gotAll(s, range(0, 5))).length;
  console.log(`Baseline receipt: ${studentCount - baselineMisses}/${studentCount}`);

  const groupSize = Math.round((studentCount * disconnectFraction) / 2);
  const dropGroup = students.slice(0, groupSize);
  const freshGroup = students.slice(groupSize, 2 * groupSize);
  const controlGroup = students.slice(2 * groupSize);

  console.log(`Dropping the network for ${dropGroup.length} students (~${offlineMs}ms offline)...`);
  const drops = await Promise.all(dropGroup.map((s) => s.simulateNetworkDrop({ offlineMs })));

  // Sent while the drop group is offline -- only connection state recovery can get these to them.
  const gapExerciseId = 1_000_000 + Math.floor(Math.random() * 1_000_000);
  console.log(`While they're offline: sending edits 5-9 and EXERCISE_CREATED #${gapExerciseId}...`);
  sendEdits(instructorSocket, lecture, makeSyntheticEdits(5, 5, 5));
  instructorSocket.emit(SOCKET_MESSAGE_TYPE.EXERCISE_CREATED, { sessionId: lecture.sessionNumber, exerciseId: gapExerciseId });

  const dropReconnects = await Promise.all(drops.map((d) => d.reconnected));
  console.log(`Drop group back online (${dropReconnects.filter((r) => r.recovered).length}/${dropGroup.length} recovered).`);

  console.log(`Fresh-reconnecting ${freshGroup.length} students (not recoverable)...`);
  const freshReconnects = await Promise.all(freshGroup.map((s) => s.freshReconnect()));

  // JOIN_SESSION has no ack, so "connect" only means the rejoin emit is queued -- give it a moment.
  await sleep(300);

  console.log("Sending after-batch (edits 10-14)...");
  sendEdits(instructorSocket, lecture, makeSyntheticEdits(5, 10, 10));
  await sleep(1500);

  const gapIds = range(5, 10);
  const afterIds = range(10, 15);
  const r = {
    controlAll: rate(controlGroup, (s) => gotAll(s, range(0, 15)) && gotExercise(s, gapExerciseId)),
    dropRecovered: rate(dropReconnects, (x) => x.recovered),
    dropGotGap: rate(dropGroup, (s) => gotAll(s, gapIds) && gotExercise(s, gapExerciseId)),
    dropGotAfter: rate(dropGroup, (s) => gotAll(s, afterIds)),
    dropInOrder: rate(dropGroup, inOrder),
    freshFlaggedForReload: rate(freshReconnects, (x) => !x.recovered),
    freshGotAfter: rate(freshGroup, (s) => gotAll(s, afterIds)),
  };

  console.log(`\nControl group (${controlGroup.length}): received everything: ${pct(r.controlAll)}`);
  console.log(`Drop group (${dropGroup.length}): session recovered ${pct(r.dropRecovered)}, ` +
    `got what was sent while offline ${pct(r.dropGotGap)}, got after-batch ${pct(r.dropGotAfter)}, in order ${pct(r.dropInOrder)}`);
  console.log(`Fresh group (${freshGroup.length}): not recovered (client would show reload banner) ${pct(r.freshFlaggedForReload)}, ` +
    `got after-batch ${pct(r.freshGotAfter)}`);

  const harnessOk = baselineMisses === 0 && r.controlAll === 1;
  const checks = [
    [harnessOk, "baseline + control group received everything (harness sanity)"],
    [r.dropRecovered === 1 && r.dropGotGap === 1, "network-drop students recovered and got every broadcast sent while offline"],
    [r.dropGotAfter === 1 && r.dropInOrder === 1, "network-drop students got the after-batch, all edits in order"],
    [r.freshFlaggedForReload === 1, "unrecoverable reconnects are detected (socket.recovered === false)"],
    [r.freshGotAfter === 1, "unrecoverable reconnects rejoin the room and get the after-batch"],
  ];
  console.log();
  for (const [ok, label] of checks) printVerdict(ok, label);
  const passed = checks.every(([ok]) => ok);

  students.forEach((s) => s.close());
  instructorSocket.close();

  writeResults("reconnect-resilience", {
    serverUrl, sessionName, studentCount, disconnectFraction, offlineMs,
    groupSizes: { control: controlGroup.length, drop: dropGroup.length, fresh: freshGroup.length },
    baselineMissCount: baselineMisses, rates: r, passed,
  });

  process.exit(passed ? 0 : 1);
}

main().catch((error) => {
  console.error("reconnect-resilience failed:", error.message);
  process.exit(1);
});
