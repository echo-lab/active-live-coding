// With N students already joined to a fresh, empty lecture, replays the captured edit history
// over INSTRUCTOR_EDIT and measures, per edit, the spread of receipt times across all N sockets
// plus final-document convergence -- this is the test targeting the user's original question
// "are the instructor's changes sending to all N students quickly."
//
// Usage:
//   node src/scripts/load-test/broadcast-latency.js --fixture fixtures/realistic-10min.json --students 50
//   node src/scripts/load-test/broadcast-latency.js --fixture fixtures/realistic-10min.json --students 50 --pace max
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOCKET_MESSAGE_TYPE } from "../../shared-constants.js";
import { parseArgs, DEFAULT_SERVER_URL } from "./lib/cli-args.js";
import { loadFixture } from "./lib/fixture-io.js";
import { SimulatedStudent } from "./lib/simulated-student.js";
import { createFreshLecture, createFixtureFiles, replayInstructorEdits } from "./lib/replay-engine.js";
import { replayFixtureFiles } from "./lib/cm-replay.js";
import { summarize, printSummary, printVerdict } from "./lib/stats.js";
import { writeResults } from "./lib/results.js";

const LOAD_TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

const THRESHOLDS = {
  skewP95Ms: 50, // spread across sockets, at --pace realtime only
  dispatchLatencyP95Ms: 20, // receipt - send, at --pace realtime only
  replayTimingTolerancePct: 5, // wall-clock vs fixture.durationMs, at --pace realtime only
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usage() {
  console.log(`Usage:
  node src/scripts/load-test/broadcast-latency.js --fixture <path> [--students 50] [--pace realtime|max|<number>]
    [--settle-ms 300] [--server <url>]`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.fixture) {
    usage();
    process.exit(1);
  }

  const serverUrl = args.server ?? DEFAULT_SERVER_URL;
  const studentCount = Number(args.students ?? 50);
  const pace = args.pace ? (isNaN(Number(args.pace)) ? args.pace : Number(args.pace)) : "realtime";
  const settleMs = Number(args["settle-ms"] ?? 300);
  const sessionName = args["session-name"] ?? `LOAD_TEST_broadcast_${Date.now()}`;

  const fixturePath = path.isAbsolute(args.fixture) ? args.fixture : path.join(LOAD_TEST_DIR, args.fixture);
  const fixture = loadFixture(fixturePath);
  console.log(`Loaded fixture: ${fixture.editCount} edits, ${(fixture.durationMs / 1000 / 60).toFixed(1)} min recorded`);

  const lecture = await createFreshLecture({ serverUrl, sessionName });
  // Before the students join, so each one gets every file in its join payload.
  await createFixtureFiles({ serverUrl, lecture, fileNames: fixture.files.map((f) => f.name) });
  console.log(`Created fresh (empty) lecture #${lecture.sessionNumber} "${sessionName}" with ${fixture.files.length} file(s)`);

  const studentIds = Array.from({ length: studentCount }, () => crypto.randomUUID());
  const students = studentIds.map((id) => new SimulatedStudent({ serverUrl, sessionName, studentId: id }));

  console.log(`Joining ${studentCount} students...`);
  const joinResults = await Promise.allSettled(students.map((s) => s.join()));
  const joinErrors = joinResults.filter((r) => r.status === "rejected" || !r.value.ok);
  if (joinErrors.length > 0) {
    throw new Error(`${joinErrors.length}/${studentCount} students failed to join -- aborting broadcast-latency test`);
  }

  // Deliberate harness-only safety margin: JOIN_SESSION has no ack, so give the server a moment
  // to have processed every student's room-join before the instructor starts sending edits.
  await sleep(settleMs);

  // Edits are keyed by "fileId:id" -- ids are per-file doc versions, so they repeat across files.
  const editKey = (fileId, id) => `${fileId}:${id}`;
  const receiptsByEdit = new Map();
  students.forEach((student) => {
    student.on(SOCKET_MESSAGE_TYPE.INSTRUCTOR_EDIT, (msg, receivedAt) => {
      const key = editKey(msg.fileId, msg.id);
      if (!receiptsByEdit.has(key)) receiptsByEdit.set(key, []);
      receiptsByEdit.get(key).push(receivedAt);
    });
  });

  const sentEdits = []; // [{key, sentAt}] in send order
  console.log(`Replaying ${fixture.editCount} edits at pace="${pace}"...`);
  const { elapsedMs } = await replayInstructorEdits({
    serverUrl,
    sessionNumber: lecture.sessionNumber,
    userId: lecture.userId,
    fileId: lecture.fileId,
    fileIds: lecture.fileIds,
    edits: fixture.edits,
    pace,
    onEditSent: (edit, idx, sentAt, fileId) => {
      sentEdits[idx] = { key: editKey(fileId, edit.id ?? idx), sentAt };
    },
  });
  console.log(`Replay finished in ${(elapsedMs / 1000).toFixed(1)}s`);

  // Settle window for the last few broadcasts to actually land on every socket.
  await sleep(Math.max(settleMs, 500));

  const skews = [];
  const dispatchLatencies = [];
  const missingDeliveries = [];
  for (const { key, sentAt } of sentEdits) {
    const receipts = receiptsByEdit.get(key) ?? [];
    if (receipts.length !== studentCount) {
      missingDeliveries.push({ edit: key, receivedBy: receipts.length, expected: studentCount });
      continue;
    }
    skews.push(Math.max(...receipts) - Math.min(...receipts));
    dispatchLatencies.push(Math.min(...receipts) - sentAt);
  }

  const skewSummary = summarize(skews);
  const dispatchSummary = summarize(dispatchLatencies);
  printSummary("Per-edit receipt skew across sockets", skewSummary);
  printSummary("Per-edit dispatch latency (min receipt - send)", dispatchSummary);
  console.log(`Edits with missing deliveries: ${missingDeliveries.length}/${fixture.editCount}`);

  const totalOutOfSync = students.reduce((sum, s) => sum + s.outOfSyncCount, 0);
  console.log(`Total INSTRUCTOR_OUT_OF_SYNC events: ${totalOutOfSync}`);

  // Every file of every student must match the fixture's replay.
  const expectedFiles = replayFixtureFiles(fixture);
  const convergenceMismatches = students.filter((s) => {
    const texts = s.getFileTexts();
    return [...expectedFiles].some(([name, { text }]) => texts.get(name) !== text);
  });
  console.log(`Convergence mismatches: ${convergenceMismatches.length}/${studentCount}`);

  const replayTimingPct = pace === "realtime" ? (Math.abs(elapsedMs - fixture.durationMs) / fixture.durationMs) * 100 : null;

  students.forEach((s) => s.close());

  const passNoMissing = missingDeliveries.length === 0;
  const passNoOutOfSync = totalOutOfSync === 0;
  const passConvergence = convergenceMismatches.length === 0;
  printVerdict(passNoMissing, "every edit delivered to every socket");
  printVerdict(passNoOutOfSync, "zero INSTRUCTOR_OUT_OF_SYNC events");
  printVerdict(passConvergence, "every student's final doc converges with the source lecture");

  let passed = passNoMissing && passNoOutOfSync && passConvergence;
  if (pace === "realtime") {
    const passSkew = skewSummary.p95 == null || skewSummary.p95 < THRESHOLDS.skewP95Ms;
    const passDispatch = dispatchSummary.p95 == null || dispatchSummary.p95 < THRESHOLDS.dispatchLatencyP95Ms;
    const passTiming = replayTimingPct == null || replayTimingPct < THRESHOLDS.replayTimingTolerancePct;
    printVerdict(passSkew, `p95 skew < ${THRESHOLDS.skewP95Ms}ms (got ${skewSummary.p95?.toFixed(1)}ms)`);
    printVerdict(passDispatch, `p95 dispatch latency < ${THRESHOLDS.dispatchLatencyP95Ms}ms (got ${dispatchSummary.p95?.toFixed(1)}ms)`);
    printVerdict(passTiming, `replay wall-clock within ${THRESHOLDS.replayTimingTolerancePct}% of recorded duration (off by ${replayTimingPct?.toFixed(1)}%)`);
    passed = passed && passSkew && passDispatch && passTiming;
  } else {
    console.log(`(pace="${pace}" -- skew/dispatch/timing thresholds only enforced at --pace realtime; numbers above are reported, not graded)`);
  }

  writeResults("broadcast-latency", {
    serverUrl, sessionName, studentCount, pace, editCount: fixture.editCount,
    skewSummary, dispatchSummary, missingDeliveries, totalOutOfSync,
    convergenceMismatchCount: convergenceMismatches.length, elapsedMs, replayTimingPct, thresholds: THRESHOLDS, passed,
  });

  process.exit(passed ? 0 : 1);
}

main().catch((error) => {
  console.error("broadcast-latency failed:", error.message);
  process.exit(1);
});
