// Read-only CLI that reports what happened during a single lecture: its actual
// duration (estimated from activity, not createdAt/isFinished -- instructors often
// create a lecture well before class and may never explicitly end it), every
// poll/coding exercise with student responses (grouped the same way the app's own
// summary does, when a summary already exists), and engagement numbers.
//
// Usage:
//   node src/scripts/lecture-report.js <lectureId>
// Find a lectureId with:
//   node src/scripts/list-lectures.js
import zlib from "node:zlib";
import {
  LectureSession,
  ClassExercise,
  ExerciseResponse,
  SimulatedExerciseResponse,
  StudentSession,
  InstructorChange,
  VersionBlock,
} from "../server/models.js";
import { Event } from "../server/events-database.js";
import { EVENT_TYPES } from "../shared-constants.js";

// MARK: Tunables for the duration heuristic
//
// Instructor edits alone under-count a lecture: mid-class lulls (e.g. while
// students work a coding exercise) can run several minutes with no instructor
// typing. So "activity" here is the union of instructor edits, exercise
// start/finish, student submissions, and (if available) every client-logged
// event -- bucketed into fine-grained epochs, which are then merged into
// "sessions" across smaller gaps (a real mid-class lull) while still splitting on
// larger gaps (a genuinely separate test/prep session hours apart). See the plan
// doc for the real lecture that motivated this two-tier approach.
const EPOCH_GAP_MS = 5 * 60 * 1000;
const SESSION_MERGE_GAP_MS = 20 * 60 * 1000;
const MIN_SESSION_DURATION_MS = 60 * 1000;

// MARK: Formatting helpers
function fmtTime(ts) {
  return new Date(ts).toLocaleString();
}

function fmtDuration(ms) {
  const totalSec = Math.round(Math.max(0, ms) / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtOffset(ms) {
  const sign = ms < 0 ? "-" : "";
  const totalSec = Math.round(Math.abs(ms) / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${sign}${m}:${String(s).padStart(2, "0")}`;
}

function printAnswer(label, answer) {
  const lines = String(answer ?? "").split("\n");
  console.log(`    - ${label}: ${lines[0]}`);
  for (const line of lines.slice(1)) console.log(`      ${line}`);
}

// MARK: Duration heuristic
function computeEpochs(timestamps, gapMs) {
  const sorted = [...timestamps].sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const epochs = [];
  let cur = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - cur[cur.length - 1] > gapMs) {
      epochs.push(cur);
      cur = [];
    }
    cur.push(sorted[i]);
  }
  epochs.push(cur);
  return epochs.map((e) => ({ start: e[0], end: e[e.length - 1] }));
}

function mergeEpochsIntoSessions(epochs, mergeGapMs) {
  if (epochs.length === 0) return [];
  const sessions = [{ start: epochs[0].start, end: epochs[0].end }];
  for (let i = 1; i < epochs.length; i++) {
    const last = sessions[sessions.length - 1];
    if (epochs[i].start - last.end <= mergeGapMs) {
      last.end = epochs[i].end;
    } else {
      sessions.push({ start: epochs[i].start, end: epochs[i].end });
    }
  }
  return sessions;
}

// MARK: Args
const [, , lectureIdArg] = process.argv;
if (!lectureIdArg || !/^\d+$/.test(lectureIdArg)) {
  console.log("Usage: node src/scripts/lecture-report.js <lectureId>");
  console.log("Tip: find an id with `node src/scripts/list-lectures.js`.");
  process.exit(1);
}
const lectureId = Number(lectureIdArg);

const lecture = await LectureSession.findByPk(lectureId);
if (!lecture) {
  console.log(`No lecture with id ${lectureId} found.`);
  process.exit(1);
}

// MARK: Load data
const exercises = await ClassExercise.findAll({
  where: { LectureSessionId: lectureId },
  include: [
    {
      model: ExerciseResponse,
      include: [{ model: StudentSession, attributes: ["student_id", "student_identifier"], required: false }],
      required: false,
    },
    { model: SimulatedExerciseResponse, required: false },
  ],
  order: [["start_ts", "ASC"]],
});

const changeTimestamps = (
  await InstructorChange.findAll({ where: { LectureSessionId: lectureId }, attributes: ["change_ts"], raw: true })
).map((r) => r.change_ts);

const studentSessions = await StudentSession.findAll({ where: { LectureSessionId: lectureId }, raw: true });

const versionBlocks = await VersionBlock.findAll({
  where: { LectureSessionId: lectureId },
  include: ["Variants"],
});

// events.sqlite may not have data for this lecture (introduced 2026-08-24 -- older
// lectures predate it entirely) or may not exist/be initialized at all -- degrade
// gracefully rather than erroring.
let events = [];
let hasEventData = false;
try {
  const rows = await Event.findAll({ where: { lectureId }, raw: true });
  for (const row of rows) {
    // Most rows are gzip (the normal batched flush); rows written by the pagehide/sendBeacon
    // leave-flush are stored uncompressed, since compression there isn't guaranteed to finish
    // before the page unloads -- payload is self-describing via the gzip magic bytes.
    const isGzip = row.payload.length >= 2 && row.payload[0] === 0x1f && row.payload[1] === 0x8b;
    const json = isGzip ? zlib.gunzipSync(row.payload).toString("utf-8") : row.payload.toString("utf-8");
    const batch = JSON.parse(json);
    for (const item of batch) {
      events.push({ type: item.payload.type, timestamp: item.timestamp, data: item.payload, userId: row.userId, isStudent: !!row.isStudent });
    }
  }
  events.sort((a, b) => a.timestamp - b.timestamp);
  hasEventData = events.length > 0;
} catch (err) {
  hasEventData = false;
}

// MARK: Duration
const activityTimestamps = new Set(changeTimestamps);
for (const ex of exercises) {
  activityTimestamps.add(ex.start_ts);
  if (ex.end_ts != null) activityTimestamps.add(ex.end_ts);
  for (const r of ex.ExerciseResponses) activityTimestamps.add(r.submitted_ts);
}
for (const e of events) activityTimestamps.add(e.timestamp);

const epochs = computeEpochs([...activityTimestamps], EPOCH_GAP_MS);
const sessions = mergeEpochsIntoSessions(epochs, SESSION_MERGE_GAP_MS);
const candidateSessions = sessions.filter((s) => s.end - s.start > MIN_SESSION_DURATION_MS);
const lectureWindow = candidateSessions.length > 0 ? candidateSessions[candidateSessions.length - 1] : sessions[sessions.length - 1] ?? null;

// Pair each INSTRUCTOR_START_POLL_CREATION with the next INSTRUCTOR_START_EXERCISE
// for a POLL/POLL_MCQ -- only one poll draft can be open at a time, so consecutive
// instructor events pair up cleanly even with CODE_VARIANT creations interleaved.
const exercisesById = new Map(exercises.map((ex) => [ex.id, ex]));
const pollCreationTimeByExerciseId = new Map();
{
  let pendingPollCreationTs = null;
  for (const e of events) {
    if (e.isStudent) continue;
    if (e.type === EVENT_TYPES.INSTRUCTOR_START_POLL_CREATION) {
      pendingPollCreationTs = e.timestamp;
    } else if (e.type === EVENT_TYPES.INSTRUCTOR_START_EXERCISE) {
      const ex = exercisesById.get(e.data.exerciseId);
      if (pendingPollCreationTs != null && ex && (ex.type === "POLL" || ex.type === "POLL_MCQ")) {
        pollCreationTimeByExerciseId.set(ex.id, e.timestamp - pendingPollCreationTs);
        pendingPollCreationTs = null;
      }
    }
  }
}

function distinctStudentsStarted(exerciseId) {
  const ids = new Set();
  for (const e of events) {
    if (e.type === EVENT_TYPES.STUDENT_START_EXERCISE && e.data.exerciseId === exerciseId) ids.add(e.userId);
  }
  return ids.size;
}

// MARK: Header
console.log(`\n=== LECTURE #${lecture.id}: "${lecture.name}" ===`);
console.log(`Instructor: ${lecture.instructor_id}`);
console.log(`Created: ${fmtTime(lecture.createdAt.getTime())}`);
console.log(`Marked finished by instructor: ${lecture.isFinished ? "yes" : "no"}`);
console.log(
  `Review link: ${lecture.uuid ? `http://localhost:3000/pages/review-lecture.html?id=${lecture.uuid}` : "none (this lecture predates the review-link uuid column)"}`,
);

// MARK: Duration
console.log(`\n=== DURATION ===`);
if (!lectureWindow) {
  console.log("No activity recorded for this lecture -- cannot estimate a duration.");
} else {
  console.log(
    `Detected lecture window: ${fmtTime(lectureWindow.start)} -- ${fmtTime(lectureWindow.end)} (${fmtDuration(lectureWindow.end - lectureWindow.start)})`,
  );
  console.log(
    `(createdAt is ${fmtTime(lecture.createdAt.getTime())} -- instructors can create a lecture well before class and may not explicitly end it, so this window comes from actual activity instead.)`,
  );
  console.log(`\nRaw activity epochs (a gap > 5min starts a new epoch):`);
  epochs.forEach((e, i) => {
    console.log(`  epoch ${i + 1}: ${fmtTime(e.start)} -- ${fmtTime(e.end)} (${fmtDuration(e.end - e.start)})`);
  });
  console.log(`\nMerged sessions (epochs within 20min of each other are merged):`);
  sessions.forEach((s) => {
    const chosen = s === lectureWindow;
    console.log(
      `  ${chosen ? "-> " : "   "}${fmtTime(s.start)} -- ${fmtTime(s.end)} (${fmtDuration(s.end - s.start)})${chosen ? `  <== used as "the lecture"` : ""}`,
    );
  });
}

// MARK: Activity counts
console.log(`\n=== ACTIVITY COUNTS ===`);
const countsByType = {};
for (const ex of exercises) countsByType[ex.type] = (countsByType[ex.type] ?? 0) + 1;
console.log(`Poll (free response): ${countsByType.POLL ?? 0}`);
console.log(`Poll (multiple choice): ${countsByType.POLL_MCQ ?? 0}`);
console.log(`Coding exercise: ${countsByType.CODE_VARIANT ?? 0}`);
if (countsByType.CODE_FITB) console.log(`CODE_FITB (legacy/unexpected type -- not created by the current app): ${countsByType.CODE_FITB}`);

// MARK: Lecture-level engagement
console.log(`\n=== LECTURE-LEVEL ENGAGEMENT ===`);
console.log(`Students logged on: ${studentSessions.length}`);
const studentsWhoResponded = new Set();
for (const ex of exercises) for (const r of ex.ExerciseResponses) studentsWhoResponded.add(r.student_id);
const pct = studentSessions.length > 0 ? Math.round((studentsWhoResponded.size / studentSessions.length) * 100) : 0;
console.log(`Students who submitted at least one response: ${studentsWhoResponded.size} (${pct}%)`);
console.log(
  `Note: "logged on" is a whole-lecture count (StudentSessions has no per-connection timestamps, so per-activity` +
    ` concurrent presence isn't available -- there's no live connect/disconnect tracking in this app).`,
);

// MARK: Per-activity detail
console.log(`\n=== ACTIVITIES ===`);
if (exercises.length === 0) console.log("No activities in this lecture.");

exercises.forEach((ex, i) => {
  const isPoll = ex.type === "POLL" || ex.type === "POLL_MCQ";
  console.log(`\n--- ${i + 1}. [${ex.type}] Exercise #${ex.id} ---`);

  if (ex.type === "CODE_VARIANT") {
    const firstLine = (ex.default_answer ?? "").split("\n").map((l) => l.trim()).find((l) => l.length > 0);
    console.log(`Code preview: ${firstLine ?? "(empty)"}`);
  } else {
    console.log(`Question: ${ex.instructions ?? "(none)"}`);
  }

  if (lectureWindow) {
    const offset = ex.start_ts - lectureWindow.start;
    console.log(`Time into lecture: ${fmtOffset(offset)}${offset < 0 ? " (before detected lecture start)" : ""}`);
  }

  if (isPoll) {
    const creationMs = pollCreationTimeByExerciseId.get(ex.id);
    const creationText = creationMs != null ? fmtDuration(creationMs) : hasEventData ? "unknown (no matching creation event found)" : "unknown (no event data for this lecture)";
    console.log(`Time to create: ${creationText}`);
  }

  console.log(`Open duration: ${ex.end_ts != null ? fmtDuration(ex.end_ts - ex.start_ts) : "still active"}`);

  const realResponses = ex.ExerciseResponses;
  const simResponses = ex.SimulatedExerciseResponses ?? [];
  const startedCount = hasEventData ? distinctStudentsStarted(ex.id) : null;
  console.log(
    `Engagement: ${startedCount != null ? startedCount : "unknown (no event data)"} started, ${realResponses.length} submitted` +
      ` (of ${studentSessions.length} students logged on to the lecture)`,
  );

  if (ex.type === "POLL_MCQ") {
    let choices = [];
    try {
      choices = JSON.parse(ex.default_answer ?? "[]");
    } catch {
      choices = [];
    }
    const counts = new Array(choices.length).fill(0);
    let tallied = 0;
    for (const r of realResponses) {
      const idx = parseInt(r.answer, 10);
      if (!isNaN(idx) && idx >= 0 && idx < choices.length) {
        counts[idx]++;
        tallied++;
      }
    }
    console.log(`Responses: ${realResponses.length} real (${simResponses.length} simulated)`);
    choices.forEach((choice, idx) => {
      const p = tallied > 0 ? Math.round((counts[idx] / tallied) * 100) : 0;
      console.log(`  ${String.fromCharCode(65 + idx)}. ${choice} -- ${counts[idx]} (${p}%)`);
    });
  } else {
    const total = realResponses.length + simResponses.length;
    console.log(`Responses: ${total} total (${realResponses.length} real, ${simResponses.length} simulated)`);
    if (total === 0) return;

    const responseById = new Map();
    for (const r of realResponses) {
      const label = r.StudentSession?.student_identifier || `student ${r.student_id.slice(0, 8)}`;
      responseById.set(`real_${r.id}`, { label, answer: r.answer });
    }
    for (const r of simResponses) {
      responseById.set(`sim_${r.id}`, { label: `${r.student_name ?? "simulated"} (simulated)`, answer: r.answer });
    }

    let groups = null;
    if (ex.summary) {
      try {
        groups = JSON.parse(ex.summary);
      } catch {
        groups = null;
      }
    }

    if (groups) {
      // Percentage denominator matches activities-panel.js's buildResponseGroupEl: the
      // sum of every matched group's member count, not the raw response total -- the
      // LLM's groups aren't guaranteed mutually exclusive, so this can exceed `total`.
      const resolvedGroups = groups
        .map((group) => ({ group, members: group.response_ids.map((id) => responseById.get(id)).filter(Boolean) }))
        .filter(({ members }) => members.length > 0);
      const totalResolved = resolvedGroups.reduce((sum, { members }) => sum + members.length, 0);
      for (const { group, members } of resolvedGroups) {
        const p = Math.round((members.length / totalResolved) * 100);
        console.log(`  Group: "${group.description}" -- ${members.length} (${p}%)`);
        for (const m of members) printAnswer(m.label, m.answer);
      }
    } else {
      console.log(`  (no summary generated yet${total <= 3 ? " -- 3 or fewer responses" : ""})`);
      for (const r of responseById.values()) printAnswer(r.label, r.answer);
    }
  }
});

// MARK: Extra context
console.log(`\n=== EXTRA CONTEXT ===`);
console.log(`Total instructor edits recorded: ${changeTimestamps.length}`);
console.log(`Total code runs: ${hasEventData ? events.filter((e) => e.type === EVENT_TYPES.CODE_RUN).length : "unknown (no event data)"}`);
console.log(`Version blocks (coding-exercise anchors) created: ${versionBlocks.length}`);
const totalVariants = versionBlocks.reduce((sum, b) => sum + b.Variants.length, 0);
const defaultVariants = versionBlocks.reduce((sum, b) => sum + b.Variants.filter((v) => /^v\d+$/.test(v.name)).length, 0);
console.log(`Variants authored: ${totalVariants} total (${defaultVariants} instructor default/added, ${totalVariants - defaultVariants} promoted from a student answer)`);

console.log("");
process.exit(0);
