// Fires N concurrent (or staggered) student joins against an already-seeded lecture, and
// measures whether /current-session-student holds up. This targets the uncached O(n)
// getDoc()-replay + SQLite IMMEDIATE-transaction serialization risk directly (see plan Context).
//
// Usage:
//   node src/scripts/load-test/join-reload-stress.js --students 50 --pattern all-at-once
//   node src/scripts/load-test/join-reload-stress.js --students 50 --pattern staggered --stagger-ms 100
//   node src/scripts/load-test/join-reload-stress.js --students 50 --rounds 3
import { parseArgs, DEFAULT_SERVER_URL } from "./lib/cli-args.js";
import { SimulatedStudent } from "./lib/simulated-student.js";
import { summarize, printSummary, printVerdict } from "./lib/stats.js";
import { writeResults, readNamedResult } from "./lib/results.js";

const THRESHOLDS = {
  restLatencyP95Ms: 2000,
  restLatencyMaxMs: 5000, // headroom under SQLite's own 5000ms busy_timeout
  socketConnectP95Ms: 500,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usage() {
  console.log(`Usage:
  node src/scripts/load-test/join-reload-stress.js [--students 50] [--pattern all-at-once|staggered]
    [--stagger-ms 100] [--rounds 1] [--session-name <name>] [--server <url>]`);
}

async function runRound({ serverUrl, sessionName, studentIds, pattern, staggerMs }) {
  const students = studentIds.map((id) => new SimulatedStudent({ serverUrl, sessionName, studentId: id }));

  const t0 = performance.now();
  const pending = [];
  for (const student of students) {
    pending.push(student.join());
    if (pattern === "staggered") await sleep(staggerMs);
  }
  const settled = await Promise.allSettled(pending);
  const roundElapsedMs = performance.now() - t0;

  const results = settled.map((r, i) =>
    r.status === "fulfilled" ? { studentId: studentIds[i], ...r.value } : { studentId: studentIds[i], ok: false, error: r.reason?.message },
  );

  students.forEach((s) => s.close());
  return { results, roundElapsedMs };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const serverUrl = args.server ?? DEFAULT_SERVER_URL;
  const studentCount = Number(args.students ?? 50);
  const pattern = args.pattern ?? "all-at-once";
  const staggerMs = Number(args["stagger-ms"] ?? 100);
  const rounds = Number(args.rounds ?? 1);

  let sessionName = args["session-name"];
  let expectedDocVersion = null;
  if (!sessionName) {
    const seeded = readNamedResult("last-seeded-session.json");
    if (!seeded) {
      usage();
      throw new Error("No --session-name given and no results/last-seeded-session.json found -- run seed-fresh-lecture.js first.");
    }
    sessionName = seeded.sessionName;
    expectedDocVersion = seeded.docVersion;
    console.log(`Using most recently seeded session: "${sessionName}" (#${seeded.sessionNumber}, docVersion=${expectedDocVersion})`);
  }

  const studentIds = Array.from({ length: studentCount }, () => crypto.randomUUID());
  const roundData = [];
  let anyErrors = false;
  let anyVersionMismatch = false;

  for (let round = 1; round <= rounds; round++) {
    console.log(`\n--- Round ${round}/${rounds} (${pattern}${pattern === "staggered" ? `, ${staggerMs}ms stagger` : ""}) ---`);
    const { results, roundElapsedMs } = await runRound({ serverUrl, sessionName, studentIds, pattern, staggerMs });

    const errors = results.filter((r) => !r.ok);
    if (expectedDocVersion == null) {
      const firstOk = results.find((r) => r.ok);
      expectedDocVersion = firstOk?.docVersion ?? null;
    }
    const versionMismatches = results.filter((r) => r.ok && r.docVersion !== expectedDocVersion);

    const restSummary = summarize(results.map((r) => r.restLatencyMs).filter((n) => n != null));
    const socketSummary = summarize(results.filter((r) => r.ok).map((r) => r.socketConnectLatencyMs));

    console.log(`Round wall-clock: ${roundElapsedMs.toFixed(0)}ms`);
    printSummary("REST join latency", restSummary);
    printSummary("Socket connect latency", socketSummary);
    console.log(`Errors: ${errors.length}/${studentCount}`);
    if (errors.length > 0) console.log("  " + errors.slice(0, 5).map((e) => `${e.studentId.slice(0, 8)}: ${e.error}`).join("\n  "));
    console.log(`DocVersion mismatches: ${versionMismatches.length}/${studentCount} (expected ${expectedDocVersion})`);

    if (errors.length > 0) anyErrors = true;
    if (versionMismatches.length > 0) anyVersionMismatch = true;

    roundData.push({ round, roundElapsedMs, expectedDocVersion, restSummary, socketSummary, errorCount: errors.length, versionMismatchCount: versionMismatches.length, results });
  }

  const allRest = roundData.flatMap((r) => r.results.map((x) => x.restLatencyMs)).filter((n) => n != null);
  const overallRestSummary = summarize(allRest);

  console.log("\n=== Overall ===");
  printSummary("REST join latency (all rounds)", overallRestSummary);

  const passRestP95 = overallRestSummary.p95 == null || overallRestSummary.p95 < THRESHOLDS.restLatencyP95Ms;
  const passRestMax = overallRestSummary.max == null || overallRestSummary.max < THRESHOLDS.restLatencyMaxMs;
  const passNoErrors = !anyErrors;
  const passNoVersionMismatch = !anyVersionMismatch;
  const passed = passRestP95 && passRestMax && passNoErrors && passNoVersionMismatch;

  printVerdict(passRestP95, `p95 REST latency < ${THRESHOLDS.restLatencyP95Ms}ms (got ${overallRestSummary.p95?.toFixed(0)}ms)`);
  printVerdict(passRestMax, `max REST latency < ${THRESHOLDS.restLatencyMaxMs}ms (got ${overallRestSummary.max?.toFixed(0)}ms)`);
  printVerdict(passNoErrors, "zero join errors across all rounds");
  printVerdict(passNoVersionMismatch, "every student's docVersion matches expected");

  writeResults("join-reload-stress", { serverUrl, sessionName, studentCount, pattern, staggerMs, rounds, thresholds: THRESHOLDS, roundData, overallRestSummary, passed });

  process.exit(passed ? 0 : 1);
}

main().catch((error) => {
  console.error("join-reload-stress failed:", error.message);
  process.exit(1);
});
