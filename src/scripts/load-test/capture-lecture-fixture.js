// Extracts a recorded lecture's instructor edits -- every file's change log, interleaved by
// timestamp -- into a reusable JSON fixture for the load-test scripts (format: lib/fixture-io.js).
// Reads db.sqlite directly -- the dev server does not need to be running.
//
// Files are captured under their final names. Deleted files are left out: a fixture replays into
// a lecture where every file exists from the start, and a deleted file's name may have been
// reused since.
//
// Usage:
//   node src/scripts/load-test/capture-lecture-fixture.js --lecture-name "CS101 real lecture" --out fixtures/realistic-10min.json
//   node src/scripts/load-test/capture-lecture-fixture.js --lecture-id 42 --out fixtures/realistic-10min.json
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LectureSession, loadChangeLog } from "../../server/models.js";
import { getMainFile } from "../../shared-constants.js";
import { parseArgs } from "./lib/cli-args.js";
import { saveFixture } from "./lib/fixture-io.js";
import { replayFixtureFiles } from "./lib/cm-replay.js";

const LOAD_TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  console.log(`Usage:
  node src/scripts/load-test/capture-lecture-fixture.js --lecture-name "<name>" --out <path>
  node src/scripts/load-test/capture-lecture-fixture.js --lecture-id <id> --out <path>`);
}

async function findLecture({ lectureName, lectureId }) {
  if (lectureId) {
    const lecture = await LectureSession.findByPk(Number(lectureId));
    if (!lecture) throw new Error(`No lecture with id=${lectureId}`);
    return lecture;
  }
  // Deliberately NOT LectureSession.current() -- that filters to isFinished:false, and the
  // recorded lecture will typically have already been ended via "End Session" in the UI. Take
  // the most recent match by id in case the name was reused across multiple past lectures.
  const matches = await LectureSession.findAll({ where: { name: lectureName }, order: [["id", "DESC"]] });
  if (matches.length === 0) throw new Error(`No lecture found with name "${lectureName}"`);
  return matches[0];
}

// Re-threads each file's edits into the slots its edits occupy, in id order, so every file's
// sequence is exactly 0, 1, 2, ... while the interleaving between files is kept.
function ensurePerFileOrder(edits) {
  const slots = new Map();
  edits.forEach((edit, i) => {
    if (!slots.has(edit.fileName)) slots.set(edit.fileName, []);
    slots.get(edit.fileName).push(i);
  });
  for (const indexes of slots.values()) {
    const sorted = indexes.map((i) => edits[i]).sort((a, b) => a.id - b.id);
    indexes.forEach((slot, k) => (edits[slot] = sorted[k]));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if ((!args["lecture-name"] && !args["lecture-id"]) || !args.out) {
    usage();
    process.exit(1);
  }

  const lecture = await findLecture({ lectureName: args["lecture-name"], lectureId: args["lecture-id"] });
  console.log(`Found lecture #${lecture.id} "${lecture.name}" (isFinished=${lecture.isFinished})`);

  const allFiles = await lecture.getDocuments({ where: { kind: "file" }, order: [["id", "ASC"]] });
  const liveFiles = allFiles.filter((f) => f.deleted_at == null);
  const skipped = allFiles.length - liveFiles.length;
  if (skipped > 0) console.log(`Skipping ${skipped} deleted file(s)`);
  // Main file first: it's the one a fresh lecture already has.
  const mainFile = getMainFile(liveFiles);
  const files = [mainFile, ...liveFiles.filter((f) => f !== mainFile)].filter(Boolean);

  const edits = [];
  for (const [fileIndex, file] of files.entries()) {
    const changes = await loadChangeLog(file.id);
    changes.forEach((c, i) => {
      if (c.id !== i) throw new Error(`Gap in ${file.name}'s change sequence: expected ${i}, got ${c.id}`);
      edits.push({ fileName: file.name, id: i, changes: c.changes, ts: c.ts, fileIndex });
    });
  }
  if (edits.length === 0) {
    throw new Error(`Lecture #${lecture.id} has no recorded changes -- nothing to capture`);
  }
  // Interleave by time, then make sure each file's own edits are still in id order (timestamps
  // can go backwards, e.g. after a clock adjustment).
  edits.sort((a, b) => a.ts - b.ts || a.fileIndex - b.fileIndex || a.id - b.id);
  for (const edit of edits) delete edit.fileIndex;
  ensurePerFileOrder(edits);

  const fixture = {
    capturedAt: new Date().toISOString(),
    sourceLectureId: lecture.id,
    sourceSessionName: lecture.name,
    editCount: edits.length,
    durationMs: edits[edits.length - 1].ts - edits[0].ts,
    files: files.map((f) => ({ name: f.name })),
    edits,
  };

  // Locally sanity-replays the captured changes, to catch a corrupt/out-of-order capture
  // immediately rather than deep into a later stress-test run.
  const finalFiles = replayFixtureFiles(fixture);
  for (const f of fixture.files) {
    const { text, docVersion } = finalFiles.get(f.name);
    Object.assign(f, { editCount: docVersion, finalDocLength: text.length });
  }
  fixture.finalDocLength = [...finalFiles.values()].reduce((sum, f) => sum + f.text.length, 0);

  const outPath = path.isAbsolute(args.out) ? args.out : path.join(LOAD_TEST_DIR, args.out);
  saveFixture(outPath, fixture);

  console.log(`Captured ${edits.length} edits across ${files.length} file(s), spanning ${(fixture.durationMs / 1000 / 60).toFixed(1)} min`);
  for (const f of fixture.files) console.log(`  ${f.name}: ${f.editCount} edits, ${f.finalDocLength} chars`);
  console.log(`Wrote fixture to ${outPath}`);
  process.exit(0);
}

main().catch((error) => {
  console.error("Failed to capture fixture:", error.message);
  process.exit(1);
});
