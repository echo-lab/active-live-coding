// Creates a poll or code exercise, confirms all N students receive the creation broadcast
// promptly, then fires N concurrent submissions and checks the DB (not just REST responses) for
// silent drops -- the test targeting the user's question "are exercises being pushed out okay
// and are students all able to submit solutions."
//
// Usage:
//   node src/scripts/load-test/exercise-fanout-stress.js --students 50 --exercise-type poll
//   node src/scripts/load-test/exercise-fanout-stress.js --students 50 --exercise-type code
//   node src/scripts/load-test/exercise-fanout-stress.js --students 50 --exercise-type poll --call-finish-and-summary
import { io } from "socket.io-client";
import { SOCKET_MESSAGE_TYPE } from "../../shared-constants.js";
import { parseArgs, DEFAULT_SERVER_URL } from "./lib/cli-args.js";
import { SimulatedStudent } from "./lib/simulated-student.js";
import { createFreshLecture } from "./lib/replay-engine.js";
import { timedPost } from "./lib/rest-client.js";
import { summarize, printSummary, printVerdict } from "./lib/stats.js";
import { writeResults } from "./lib/results.js";

const THRESHOLDS = {
  creationBroadcastP95Ms: 200,
  submissionP95Ms: 1000,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usage() {
  console.log(`Usage:
  node src/scripts/load-test/exercise-fanout-stress.js [--students 50] [--exercise-type poll|code]
    [--call-finish-and-summary] [--session-name <name>] [--server <url>]`);
}

async function createPollExercise({ serverUrl, sessionNumber }) {
  const result = await timedPost(`${serverUrl}/exercise`, {
    lectureId: sessionNumber,
    type: "POLL",
    instructions: "Load-test poll: what does this function return?",
  });
  if (!result.ok) throw new Error(`Failed to create poll exercise: ${result.json?.error ?? result.error}`);
  return { exerciseId: result.json.exerciseId, exercise: result.json.exercise };
}

// Mirrors the two-step flow in code-editors.js (createNewVersionBlock) + activities-manager.js
// (createCodeVariantExercise): POST /version-block, emit VERSION_BLOCK_CREATED, then
// POST /exercise with type: CODE_VARIANT, emit EXERCISE_CREATED.
async function createCodeExercise({ serverUrl, sessionNumber, instructorSocket }) {
  const seedCode = "def solve(x):\n    pass  # TODO";
  const vb = await timedPost(`${serverUrl}/version-block`, {
    lectureId: sessionNumber,
    anchor_pos: 0,
    docVersion: 0,
    variantCode: seedCode,
  });
  if (!vb.ok) throw new Error(`Failed to create version block: ${vb.json?.error ?? vb.error}`);
  const { versionBlockId, variantId } = vb.json;

  instructorSocket.emit(SOCKET_MESSAGE_TYPE.VERSION_BLOCK_CREATED, {
    sessionId: sessionNumber,
    versionBlockId,
    from: 0,
    to: 0,
    variants: [{ id: variantId, name: "v0", code: seedCode, docVersion: 0 }],
  });

  const result = await timedPost(`${serverUrl}/exercise`, {
    lectureId: sessionNumber,
    type: "CODE_VARIANT",
    instructor_code: seedCode,
    default_answer: seedCode,
    version_block_id: versionBlockId,
  });
  if (!result.ok) throw new Error(`Failed to create code exercise: ${result.json?.error ?? result.error}`);
  return { exerciseId: result.json.exerciseId, exercise: result.json.exercise, versionBlockId };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const serverUrl = args.server ?? DEFAULT_SERVER_URL;
  const studentCount = Number(args.students ?? 50);
  const exerciseType = args["exercise-type"] ?? "poll";
  const callFinishAndSummary = Boolean(args["call-finish-and-summary"]);
  const sessionName = args["session-name"] ?? `LOAD_TEST_exercise_${Date.now()}`;

  if (!["poll", "code"].includes(exerciseType)) {
    usage();
    throw new Error(`Unknown --exercise-type "${exerciseType}" (expected "poll" or "code")`);
  }

  const lecture = await createFreshLecture({ serverUrl, sessionName });
  console.log(`Created fresh lecture #${lecture.sessionNumber} "${sessionName}"`);

  const studentIds = Array.from({ length: studentCount }, () => crypto.randomUUID());
  const students = studentIds.map((id) => new SimulatedStudent({ serverUrl, sessionName, studentId: id }));

  console.log(`Joining ${studentCount} students...`);
  const joinResults = await Promise.allSettled(students.map((s) => s.join()));
  const joinErrors = joinResults.filter((r) => r.status === "rejected" || !r.value.ok);
  if (joinErrors.length > 0) {
    throw new Error(`${joinErrors.length}/${studentCount} students failed to join -- aborting exercise-fanout-stress`);
  }

  const instructorSocket = io(serverUrl, { forceNew: true });
  await new Promise((resolve, reject) => {
    instructorSocket.once("connect", resolve);
    instructorSocket.once("connect_error", reject);
  });
  instructorSocket.emit(SOCKET_MESSAGE_TYPE.JOIN_SESSION, lecture.sessionNumber);
  await sleep(300); // let JOIN_SESSION land on every socket before we start emitting

  console.log(`Creating ${exerciseType} exercise...`);
  const { exerciseId, exercise, versionBlockId } =
    exerciseType === "poll"
      ? await createPollExercise({ serverUrl, sessionNumber: lecture.sessionNumber })
      : await createCodeExercise({ serverUrl, sessionNumber: lecture.sessionNumber, instructorSocket });

  const creationSentAt = performance.now();
  instructorSocket.emit(SOCKET_MESSAGE_TYPE.EXERCISE_CREATED, { sessionNumber: lecture.sessionNumber, exercise });

  const creationReceipts = await Promise.allSettled(
    students.map((s) => s.waitForEvent(SOCKET_MESSAGE_TYPE.EXERCISE_CREATED, { timeoutMs: 5000 })),
  );
  const creationLatencies = creationReceipts
    .filter((r) => r.status === "fulfilled")
    .map((r) => r.value.receivedAt - creationSentAt);
  const creationMisses = creationReceipts.filter((r) => r.status === "rejected").length;

  const creationSummary = summarize(creationLatencies);
  printSummary("Exercise-creation broadcast latency", creationSummary);
  console.log(`Students that never received EXERCISE_CREATED: ${creationMisses}/${studentCount}`);

  console.log(`Submitting ${studentCount} responses concurrently...`);
  const submitResults = await Promise.allSettled(
    students.map((s, i) =>
      s.submitResponse({ exerciseId, answer: exerciseType === "poll" ? `Load-test response #${i}` : `def solve(x):\n    return x + ${i}` }),
    ),
  );
  const submitErrors = submitResults.filter((r) => r.status === "rejected" || !r.value.ok);
  const submitLatencies = submitResults
    .filter((r) => r.status === "fulfilled" && r.value.ok)
    .map((r) => r.value.restLatencyMs);
  const submitSummary = summarize(submitLatencies);
  printSummary("Exercise-response submission latency", submitSummary);
  console.log(`Submission errors: ${submitErrors.length}/${studentCount}`);

  // Settle window for STUDENT_SUBMITTED fan-out to finish landing on every socket.
  await sleep(1000);
  const receivedCounts = students.map((s) => s.countReceived(SOCKET_MESSAGE_TYPE.STUDENT_SUBMITTED, (m) => m.exerciseId === exerciseId));
  const studentsWithFullFanIn = receivedCounts.filter((n) => n === studentCount).length;
  console.log(`Students who received all ${studentCount} STUDENT_SUBMITTED broadcasts: ${studentsWithFullFanIn}/${studentCount}`);

  // DB ground truth -- catches silent drops that wouldn't show up in the REST responses alone.
  const { ExerciseResponse } = await import("../../server/models.js");
  const dbRowCount = await ExerciseResponse.count({ where: { ClassExerciseId: exerciseId } });
  console.log(`ExerciseResponse rows in DB for exercise #${exerciseId}: ${dbRowCount} (expected ${studentCount})`);

  let summaryResult = null;
  if (callFinishAndSummary) {
    console.warn("\n--call-finish-and-summary: this will make ONE real OpenAI API call (POST /exercise/summary).");
    const finish = await timedPost(`${serverUrl}/exercise/finish`, { exerciseId });
    if (!finish.ok) throw new Error(`Failed to finish exercise: ${finish.json?.error ?? finish.error}`);
    instructorSocket.emit(SOCKET_MESSAGE_TYPE.EXERCISE_FINISHED, { sessionNumber: lecture.sessionNumber, exerciseId });

    const summary = await timedPost(`${serverUrl}/exercise/summary`, { instructorId: lecture.userId, exerciseId });
    summaryResult = { ok: summary.ok, latencyMs: summary.latencyMs, error: summary.json?.error, groupCount: summary.json?.summary?.length };
    console.log(`Exercise summary: ${summary.ok ? `${summaryResult.groupCount} groups, ${summary.latencyMs.toFixed(0)}ms` : summaryResult.error}`);
  }

  students.forEach((s) => s.close());
  instructorSocket.close();

  const passCreationMisses = creationMisses === 0;
  const passCreationLatency = creationSummary.p95 == null || creationSummary.p95 < THRESHOLDS.creationBroadcastP95Ms;
  const passSubmitErrors = submitErrors.length === 0;
  const passSubmitLatency = submitSummary.p95 == null || submitSummary.p95 < THRESHOLDS.submissionP95Ms;
  const passDbCount = dbRowCount === studentCount;
  const passFanIn = studentsWithFullFanIn === studentCount;

  printVerdict(passCreationMisses, "every student received the exercise-creation broadcast");
  printVerdict(passCreationLatency, `p95 creation-broadcast latency < ${THRESHOLDS.creationBroadcastP95Ms}ms (got ${creationSummary.p95?.toFixed(1)}ms)`);
  printVerdict(passSubmitErrors, "zero submission errors");
  printVerdict(passSubmitLatency, `p95 submission latency < ${THRESHOLDS.submissionP95Ms}ms (got ${submitSummary.p95?.toFixed(1)}ms)`);
  printVerdict(passDbCount, `ExerciseResponse DB row count == student count (${dbRowCount}/${studentCount})`);
  printVerdict(passFanIn, `every student received all ${studentCount} STUDENT_SUBMITTED broadcasts`);

  const passed = passCreationMisses && passCreationLatency && passSubmitErrors && passSubmitLatency && passDbCount && passFanIn;

  writeResults(`exercise-fanout-${exerciseType}`, {
    serverUrl, sessionName, studentCount, exerciseType, exerciseId, versionBlockId,
    creationSummary, creationMisses, submitSummary, submitErrorCount: submitErrors.length,
    studentsWithFullFanIn, dbRowCount, summaryResult, thresholds: THRESHOLDS, passed,
  });

  process.exit(passed ? 0 : 1);
}

main().catch((error) => {
  console.error("exercise-fanout-stress failed:", error.message);
  process.exit(1);
});
