// Creates a disposable LOAD_TEST_* lecture and replays a captured fixture into it over the real
// socket + server-side doc store path, so downstream stress tests (join-reload-stress,
// broadcast-latency) have a realistic edit history to work against.
//
// Usage:
//   node src/scripts/load-test/seed-fresh-lecture.js --fixture fixtures/realistic-10min.json
//   node src/scripts/load-test/seed-fresh-lecture.js --fixture fixtures/realistic-10min.json --pace realtime
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, DEFAULT_SERVER_URL } from "./lib/cli-args.js";
import { loadFixture } from "./lib/fixture-io.js";
import { createFreshLecture, createFixtureFiles, replayInstructorEdits } from "./lib/replay-engine.js";
import { timedPost } from "./lib/rest-client.js";
import { getMainFile } from "../../shared-constants.js";
import { writeNamedResult } from "./lib/results.js";
import { replayFixtureFiles } from "./lib/cm-replay.js";

const LOAD_TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  console.log(`Usage:
  node src/scripts/load-test/seed-fresh-lecture.js --fixture <path> [--pace max|realtime|<number>] [--session-name <name>]`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.fixture) {
    usage();
    process.exit(1);
  }

  const serverUrl = args.server ?? DEFAULT_SERVER_URL;
  const pace = args.pace ? (isNaN(Number(args.pace)) ? args.pace : Number(args.pace)) : "max";
  const sessionName = args["session-name"] ?? `LOAD_TEST_seed_${Date.now()}`;

  const fixturePath = path.isAbsolute(args.fixture) ? args.fixture : path.join(LOAD_TEST_DIR, args.fixture);
  const fixture = loadFixture(fixturePath);
  console.log(`Loaded fixture: ${fixture.edits.length} edits across ${fixture.files.length} file(s), ${(fixture.durationMs / 1000 / 60).toFixed(1)} min recorded`);

  const lecture = await createFreshLecture({ serverUrl, sessionName });
  console.log(`Created lecture #${lecture.sessionNumber} "${sessionName}"`);
  // Every file exists up front (rather than appearing mid-replay when it was first created).
  await createFixtureFiles({ serverUrl, lecture, fileNames: fixture.files.map((f) => f.name) });

  const t0 = performance.now();
  await replayInstructorEdits({
    serverUrl,
    sessionNumber: lecture.sessionNumber,
    fileId: lecture.fileId,
    fileIds: lecture.fileIds,
    edits: fixture.edits,
    pace,
  });
  const replayElapsedMs = performance.now() - t0;

  // Read back every file for verification. POST /lecture-session serves them from the server's
  // in-memory doc store, so this includes edits that haven't been flushed to the DB yet.
  const verify = await timedPost(`${serverUrl}/lecture-session`, { sessionName, userId: lecture.userId });
  if (!verify.ok) throw new Error(`Post-seed verification failed: ${verify.json?.error ?? verify.error}`);
  const mainFile = getMainFile(verify.json.files);

  console.log(`Replay (pace=${pace}) took ${(replayElapsedMs / 1000).toFixed(1)}s`);
  let allMatch = true;
  const fileVersions = {};
  for (const [name, expected] of replayFixtureFiles(fixture)) {
    const actual = verify.json.files.find((f) => f.name === name);
    const versionMatches = actual?.docVersion === expected.docVersion;
    const docMatches = (actual?.doc ?? []).join("\n") === expected.text;
    allMatch &&= versionMatches && docMatches;
    fileVersions[name] = actual?.docVersion;
    console.log(
      `${name}: docVersion ${actual?.docVersion} (expected ${expected.docVersion}) -- ${versionMatches ? "OK" : "MISMATCH"}; ` +
        `text ${docMatches ? "OK" : "MISMATCH"}`,
    );
  }

  const seeded = {
    sessionName,
    sessionNumber: lecture.sessionNumber,
    userId: lecture.userId,
    editCount: fixture.edits.length,
    // The main file's version -- what join-reload-stress checks each student against.
    docVersion: mainFile?.docVersion,
    fileVersions,
    seededAt: new Date().toISOString(),
  };
  writeNamedResult("last-seeded-session.json", seeded);
  console.log(`\nWrote results/last-seeded-session.json -- downstream scripts default to this session.`);

  if (!allMatch) {
    console.error("\nSeeding verification FAILED.");
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error("Failed to seed lecture:", error.message);
  process.exit(1);
});
