// Creates a disposable LOAD_TEST_* lecture and replays a captured fixture into it over the real
// socket + server-side ChangeBuffer path, so downstream stress tests (join-reload-stress,
// broadcast-latency) have a realistic, uncached-replay-cost edit history to work against.
//
// Usage:
//   node src/scripts/load-test/seed-fresh-lecture.js --fixture fixtures/realistic-10min.json
//   node src/scripts/load-test/seed-fresh-lecture.js --fixture fixtures/realistic-10min.json --pace realtime
//   node src/scripts/load-test/seed-fresh-lecture.js --fixture fixtures/realistic-10min.json --mode=direct-db
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, DEFAULT_SERVER_URL } from "./lib/cli-args.js";
import { loadFixture } from "./lib/fixture-io.js";
import { createFreshLecture, replayInstructorEdits } from "./lib/replay-engine.js";
import { timedPost } from "./lib/rest-client.js";
import { writeNamedResult } from "./lib/results.js";
import { replayToText } from "./lib/cm-replay.js";

const LOAD_TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  console.log(`Usage:
  node src/scripts/load-test/seed-fresh-lecture.js --fixture <path> [--pace max|realtime|<number>] [--mode socket|direct-db] [--session-name <name>]`);
}

// Fast-iteration escape hatch: bulk-inserts InstructorChange rows directly, skipping the socket
// + ChangeBuffer path entirely. Non-default because it under-exercises the exact code under
// test (see plan's "design alternatives considered and rejected" #3) -- only useful when
// iterating on the stress-test *assertions* themselves, not on seeding fidelity.
async function seedDirectDb({ sessionNumber, edits }) {
  const { LectureSession, InstructorChange } = await import("../../server/models.js");
  const lecture = await LectureSession.findByPk(sessionNumber);
  await InstructorChange.bulkCreate(
    edits.map((e) => ({
      LectureSessionId: lecture.id,
      change_number: e.id,
      change: JSON.stringify(e.changes),
      change_ts: e.ts,
    })),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.fixture) {
    usage();
    process.exit(1);
  }

  const serverUrl = args.server ?? DEFAULT_SERVER_URL;
  const pace = args.pace ? (isNaN(Number(args.pace)) ? args.pace : Number(args.pace)) : "max";
  const mode = args.mode ?? "socket";
  const sessionName = args["session-name"] ?? `LOAD_TEST_seed_${Date.now()}`;

  const fixturePath = path.isAbsolute(args.fixture) ? args.fixture : path.join(LOAD_TEST_DIR, args.fixture);
  const fixture = loadFixture(fixturePath);
  console.log(`Loaded fixture: ${fixture.editCount} edits, ${(fixture.durationMs / 1000 / 60).toFixed(1)} min recorded`);

  const lecture = await createFreshLecture({ serverUrl, sessionName });
  console.log(`Created lecture #${lecture.sessionNumber} "${sessionName}"`);

  const t0 = performance.now();
  if (mode === "direct-db") {
    await seedDirectDb({ sessionNumber: lecture.sessionNumber, edits: fixture.edits });
  } else {
    await replayInstructorEdits({ serverUrl, sessionNumber: lecture.sessionNumber, edits: fixture.edits, pace });
  }
  const replayElapsedMs = performance.now() - t0;

  // Force a flush of the ChangeBuffer (rather than waiting on its 5s timer) and read back the
  // resulting docVersion for verification -- POST /lecture-session calls flushInstructorChanges()
  // before returning (main.js:113).
  const verify = await timedPost(`${serverUrl}/lecture-session`, { sessionName, userId: lecture.userId });
  if (!verify.ok) throw new Error(`Post-seed verification failed: ${verify.json?.error ?? verify.error}`);

  const expectedText = replayToText(fixture.edits);
  const actualText = Array.isArray(verify.json.doc) ? verify.json.doc.join("\n") : String(verify.json.doc ?? "");
  const docMatches = actualText === expectedText;
  const versionMatches = verify.json.docVersion === fixture.editCount;

  console.log(`Replay (${mode}, pace=${pace}) took ${(replayElapsedMs / 1000).toFixed(1)}s`);
  console.log(`docVersion: ${verify.json.docVersion} (expected ${fixture.editCount}) -- ${versionMatches ? "OK" : "MISMATCH"}`);
  console.log(`Final doc text matches fixture replay: ${docMatches ? "OK" : "MISMATCH"}`);

  const seeded = {
    sessionName,
    sessionNumber: lecture.sessionNumber,
    userId: lecture.userId,
    editCount: fixture.editCount,
    docVersion: verify.json.docVersion,
    seededAt: new Date().toISOString(),
  };
  writeNamedResult("last-seeded-session.json", seeded);
  console.log(`\nWrote results/last-seeded-session.json -- downstream scripts default to this session.`);

  if (!versionMatches || !docMatches) {
    console.error("\nSeeding verification FAILED.");
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error("Failed to seed lecture:", error.message);
  process.exit(1);
});
