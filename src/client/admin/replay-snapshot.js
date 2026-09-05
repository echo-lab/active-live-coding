import { ChangeSet, Text } from "@codemirror/state";
import { EVENT_TYPES } from "../../shared-constants.js";

// Pure, DOM-free reconstruction of "what did this lecture look like at wall-clock time T",
// computed entirely from the one-shot payload fetched from /api/admin/lecture/:id/replay. Mirrors
// the server's reconstructUpTo (src/server/models.js's reconstructCMDoc) and the bounded-replay
// anchor techniques in src/server/lecture-doc-cache.js, just bounded by a timestamp instead of
// "now" -- keep this in sync with those if the underlying schema/algorithm ever changes.

// Folds an ordered prefix of {change} entries into a doc -- same fold as the server's
// reconstructCMDoc (src/server/models.js:23-33), bounded to `count` entries instead of all of them.
export function reconstructDocUpTo(changes, count) {
  let doc = Text.empty;
  for (let i = 0; i < count; i++) {
    doc = ChangeSet.fromJSON(changes[i].change).apply(doc);
  }
  return doc;
}

// Counts how many leading `changes` (each carrying a `.ts`) have ts <= T. A forward linear scan,
// not a binary search: `ts` is the instructor's client-side Date.now() at edit time and isn't
// guaranteed strictly monotonic (clock adjustments, two edits in the same ms), but changes must
// always fold in their given (change_number) order regardless -- this scan only decides where to
// stop, it never reorders.
function countUpTo(changes, T) {
  let n = 0;
  while (n < changes.length && changes[n].ts <= T) n++;
  return n;
}

// Maps a position forward through changes[fromIndex, toIndex).
function mapPosThrough(changes, fromIndex, toIndex, pos, assoc = 0) {
  let p = pos;
  for (let i = fromIndex; i < toIndex; i++) {
    p = ChangeSet.fromJSON(changes[i].change).mapPos(p, assoc);
  }
  return p;
}

// A Version Block's carving edit IS the change at anchor_change_number (captured as the doc
// version right before that edit lands), and its flatten-on-dissolve edit IS the change at
// deleted_change_number (captured the same way) -- so it's only actually present in the doc once
// MORE than anchor_change_number changes have been applied, and only until AT MOST
// deleted_change_number have been applied.
function isVersionBlockVisible(block, changeCountAtT) {
  const created = changeCountAtT > block.anchor_change_number;
  const notYetDissolved = block.deleted_change_number == null || changeCountAtT <= block.deleted_change_number;
  return created && notYetDissolved;
}

// Merges a response's `history` (prior {timestamp, answer} pairs stashed on resubmission) with
// its current {submitted_ts, answer}, and returns whichever answer was current as of T -- or null
// if even the earliest entry postdates T (the response hadn't been submitted yet).
function answerAsOfTime(response, T) {
  const entries = [...(response.history ?? []), { timestamp: response.submitted_ts, answer: response.answer }];
  entries.sort((a, b) => a.timestamp - b.timestamp);
  let result = null;
  for (const entry of entries) {
    if (entry.timestamp > T) break;
    result = entry.answer;
  }
  return result;
}

// Computes the full {lectureDoc, lectureDocVersion, versionBlocks, exercises} snapshot as of time
// T, in the exact shape StudentCodeEditor/StudentActivitiesManager already consume (see
// src/client/review-lecture.js's initialize()).
export function computeSnapshotAtTime(data, T) {
  const { instructorChanges, versionBlocks, exercises } = data;

  const changeCountAtT = countUpTo(instructorChanges, T);
  const lectureDoc = reconstructDocUpTo(instructorChanges, changeCountAtT);

  const visibleBlocks = versionBlocks.filter((b) => isVersionBlockVisible(b, changeCountAtT));
  const visibleBlockIds = new Set(visibleBlocks.map((b) => b.id));

  const versionBlocksAtT = visibleBlocks.map((block) => {
    const from = mapPosThrough(instructorChanges, block.anchor_change_number, changeCountAtT, block.anchor_pos);
    const variants = block.variants
      .filter((v) => v.createdAt <= T)
      .map((v) => {
        const n = countUpTo(v.changes, T);
        return { id: v.id, name: v.name, code: reconstructDocUpTo(v.changes, n).toString(), docVersion: n };
      });
    return { id: block.id, from, to: from, variants };
  });

  const exercisesAtT = exercises
    .filter((ex) => ex.start_ts <= T)
    .map((ex) => {
      const end_ts = ex.end_ts != null && ex.end_ts <= T ? ex.end_ts : null;

      const responses = ex.responses
        .map((r) => ({ ...r, answer: answerAsOfTime(r, T) }))
        .filter((r) => r.answer != null);

      let code_anchor_from = ex.code_anchor_from;
      let code_anchor_to = ex.code_anchor_to;
      if ((ex.type === "POLL" || ex.type === "POLL_MCQ") && code_anchor_from != null) {
        const from = mapPosThrough(instructorChanges, ex.code_anchor_doc_version, changeCountAtT, code_anchor_from, 1);
        const to = mapPosThrough(instructorChanges, ex.code_anchor_doc_version, changeCountAtT, code_anchor_to, -1);
        code_anchor_from = to > from ? from : null;
        code_anchor_to = to > from ? to : null;
      }

      return {
        id: ex.id,
        type: ex.type,
        instructions: ex.instructions,
        instructor_code: ex.instructor_code,
        default_answer: ex.default_answer,
        code_anchor_from,
        code_anchor_to,
        VersionBlockId: ex.VersionBlockId,
        VersionBlock: ex.VersionBlockId != null ? { deleted: !visibleBlockIds.has(ex.VersionBlockId) } : null,
        start_ts: ex.start_ts,
        end_ts,
        ExerciseResponses: responses.map((r) => ({
          id: r.id,
          student_id: r.student_id,
          student_identifier: r.student_identifier,
          StudentSession: r.student_identifier ? { student_identifier: r.student_identifier } : null,
          answer: r.answer,
        })),
        // SimulatedExerciseResponse rows have no timestamp field at all -- always shown once the
        // exercise itself is visible, regardless of scrub position (documented limitation).
        SimulatedExerciseResponses: ex.simulatedResponses,
      };
    });

  return {
    lectureDoc: lectureDoc.toJSON(),
    lectureDocVersion: changeCountAtT,
    versionBlocks: versionBlocksAtT,
    exercises: exercisesAtT,
  };
}

// Flat, time-sorted list of {ts, kind, exerciseId, label} timeline markers: when each exercise's
// creation was started, when it started (went live), and when it ended.
export function computeTimelineMarkers(data) {
  const { versionBlocks, exercises, instructorEvents } = data;
  const markers = [];

  const pollCreationEvents = instructorEvents
    .filter((e) => e.type === EVENT_TYPES.INSTRUCTOR_START_POLL_CREATION)
    .sort((a, b) => a.timestamp - b.timestamp);
  const claimed = new Set();

  const polls = exercises
    .filter((ex) => ex.type === "POLL" || ex.type === "POLL_MCQ")
    .sort((a, b) => a.start_ts - b.start_ts);

  for (const ex of polls) {
    // Nearest preceding, not-yet-claimed poll-creation-started event -- payloads carry no
    // exerciseId (the poll doesn't exist yet when it fires), so pairing is positional: only one
    // poll draft can be open at a time.
    let candidate = null;
    for (let i = pollCreationEvents.length - 1; i >= 0; i--) {
      if (claimed.has(i)) continue;
      if (pollCreationEvents[i].timestamp <= ex.start_ts) { candidate = i; break; }
    }
    if (candidate != null) {
      claimed.add(candidate);
      markers.push({ ts: pollCreationEvents[candidate].timestamp, kind: "creationStarted", exerciseId: ex.id, label: "Poll drafting started" });
    }
  }

  for (const ex of exercises) {
    if (ex.type === "CODE_VARIANT" && ex.VersionBlockId != null) {
      const block = versionBlocks.find((b) => b.id === ex.VersionBlockId);
      if (block) {
        markers.push({ ts: block.createdAt, kind: "creationStarted", exerciseId: ex.id, label: "Code exercise drafting started (approx.)" });
      }
    }
    markers.push({ ts: ex.start_ts, kind: "started", exerciseId: ex.id, label: "Exercise started" });
    if (ex.end_ts != null) {
      markers.push({ ts: ex.end_ts, kind: "ended", exerciseId: ex.id, label: "Exercise ended" });
    }
  }

  markers.sort((a, b) => a.ts - b.ts);
  return markers;
}

// Overall [min, max] wall-clock bounds to scrub across -- falls back to a degenerate single point
// (the lecture's own createdAt) if there's no recorded activity at all.
export function computeTimeBounds(data) {
  const timestamps = [
    ...data.instructorChanges.map((c) => c.ts),
    ...data.versionBlocks.map((b) => b.createdAt),
    ...data.exercises.flatMap((ex) => [ex.start_ts, ex.end_ts].filter((t) => t != null)),
    ...data.instructorEvents.map((e) => e.timestamp),
  ];
  if (timestamps.length === 0) return { min: data.createdAt, max: data.createdAt };
  return { min: Math.min(...timestamps, data.createdAt), max: Math.max(...timestamps) };
}

const DEFAULT_GAP_THRESHOLD_MS = 5 * 60 * 1000;
const MIN_GAP_UNIT_WIDTH_MS = 30 * 1000;
const GAP_UNIT_FRACTION = 0.02;

// A lecture's LectureSession row can span multiple disjoint real-world sessions (instructor
// planning, then the actual class, possibly hours or days apart), so raw elapsed time is a bad
// axis for the timeline -- a single multi-hour gap would otherwise dwarf everything else on the
// track. This builds a piecewise map from real time to a "compressed" axis where stretches with no
// recorded activity longer than `gapThresholdMs` are squashed to a small fixed width, and
// everything else stays proportional to its real duration.
export function computeActivityTimeline(data, { gapThresholdMs = DEFAULT_GAP_THRESHOLD_MS } = {}) {
  const markers = computeTimelineMarkers(data);
  const bounds = computeTimeBounds(data);

  const points = [...new Set([
    bounds.min,
    bounds.max,
    ...data.instructorChanges.map((c) => c.ts),
    ...data.versionBlocks.flatMap((b) => b.variants.flatMap((v) => v.changes.map((c) => c.ts))),
    ...markers.map((m) => m.ts),
    ...data.instructorEvents.map((e) => e.timestamp),
  ])].sort((a, b) => a - b);

  const intervals = [];
  let totalNormalDurationMs = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const startT = points[i];
    const endT = points[i + 1];
    const isGap = endT - startT > gapThresholdMs;
    if (!isGap) totalNormalDurationMs += endT - startT;
    intervals.push({ startT, endT, kind: isGap ? "gap" : "normal" });
  }

  const gapUnitWidth = Math.max(MIN_GAP_UNIT_WIDTH_MS, totalNormalDurationMs * GAP_UNIT_FRACTION);

  const segments = [];
  let cursor = 0;
  for (const { startT, endT, kind } of intervals) {
    const width = kind === "gap" ? gapUnitWidth : endT - startT;
    segments.push({ startT, endT, kind, compressedStart: cursor, compressedEnd: cursor + width });
    cursor += width;
  }

  // A single-point timeline (no intervals at all) has nothing to compress -- give it one
  // zero-width segment so compressTime/expandCompressed still have something to find.
  if (segments.length === 0) {
    segments.push({ startT: bounds.min, endT: bounds.max, kind: "normal", compressedStart: 0, compressedEnd: 0 });
    cursor = 0;
  }

  return { segments, totalCompressedUnits: cursor };
}

// Real timestamp -> position on the compressed axis (see computeActivityTimeline). Clamps into the
// first/last segment so a `t` right at the boundary (or a hair past it, from floating-point) never
// falls through.
export function compressTime(segments, t) {
  const seg = segments.find((s) => t <= s.endT) ?? segments[segments.length - 1];
  const span = seg.endT - seg.startT;
  const frac = span === 0 ? 0 : (Math.max(seg.startT, Math.min(t, seg.endT)) - seg.startT) / span;
  return seg.compressedStart + frac * (seg.compressedEnd - seg.compressedStart);
}

// Inverse of compressTime: a position on the compressed axis -> the real timestamp it represents.
export function expandCompressed(segments, u) {
  const seg = segments.find((s) => u <= s.compressedEnd) ?? segments[segments.length - 1];
  const span = seg.compressedEnd - seg.compressedStart;
  const frac = span === 0 ? 0 : (Math.max(seg.compressedStart, Math.min(u, seg.compressedEnd)) - seg.compressedStart) / span;
  return seg.startT + frac * (seg.endT - seg.startT);
}
