// Extracts a recorded lecture's main-file change log into a reusable JSON fixture for the
// load-test scripts. Reads db.sqlite directly -- the dev server does not need to be running.
//
// Usage:
//   node src/scripts/load-test/capture-lecture-fixture.js --lecture-name "CS101 real lecture" --out fixtures/realistic-10min.json
//   node src/scripts/load-test/capture-lecture-fixture.js --lecture-id 42 --out fixtures/realistic-10min.json
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LectureSession, loadChangeLog, DEFAULT_FILE_NAME } from "../../server/models.js";
import { parseArgs } from "./lib/cli-args.js";
import { saveFixture } from "./lib/fixture-io.js";
import { replayToText } from "./lib/cm-replay.js";

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if ((!args["lecture-name"] && !args["lecture-id"]) || !args.out) {
    usage();
    process.exit(1);
  }

  const lecture = await findLecture({ lectureName: args["lecture-name"], lectureId: args["lecture-id"] });
  console.log(`Found lecture #${lecture.id} "${lecture.name}" (isFinished=${lecture.isFinished})`);

  const [file] = await lecture.getDocuments({ where: { kind: "file", name: DEFAULT_FILE_NAME } });
  if (!file) throw new Error(`Lecture #${lecture.id} has no ${DEFAULT_FILE_NAME} -- nothing to capture`);
  const changes = await loadChangeLog(file.id);
  if (changes.length === 0) {
    throw new Error(`Lecture #${lecture.id} has no recorded changes -- nothing to capture`);
  }

  const edits = changes.map((c, i) => {
    if (c.id !== i) throw new Error(`Gap in change sequence: expected ${i}, got ${c.id}`);
    return { id: i, changes: c.changes, ts: c.ts };
  });

  // Locally sanity-replays the captured changes, to catch a corrupt/out-of-order capture
  // immediately rather than deep into a later stress-test run.
  const finalDocText = replayToText(edits);

  const fixture = {
    capturedAt: new Date().toISOString(),
    sourceLectureId: lecture.id,
    sourceSessionName: lecture.name,
    editCount: edits.length,
    durationMs: edits[edits.length - 1].ts - edits[0].ts,
    finalDocLength: finalDocText.length,
    edits,
  };

  const outPath = path.isAbsolute(args.out) ? args.out : path.join(LOAD_TEST_DIR, args.out);
  saveFixture(outPath, fixture);

  console.log(`Captured ${edits.length} edits spanning ${(fixture.durationMs / 1000 / 60).toFixed(1)} min`);
  console.log(`Final doc length: ${finalDocText.length} chars`);
  console.log(`Wrote fixture to ${outPath}`);
  process.exit(0);
}

main().catch((error) => {
  console.error("Failed to capture fixture:", error.message);
  process.exit(1);
});
