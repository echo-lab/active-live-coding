// OS-level CPU/RSS sampling of the dev-server process, run alongside any other load-test script
// in a separate terminal. Deliberately does NOT touch server code (Tier 1 in the plan) -- CPU
// sustained near 100% on this single-threaded Node server is a reasonable proxy for event-loop
// backup, and is directly cross-checkable against the latency numbers the other scripts already
// collect (if broadcast skew balloons exactly when CPU spikes, that's the signal).
//
// Usage:
//   node src/scripts/load-test/monitor-server-process.js --pid $(lsof -ti:3000)
//   node src/scripts/load-test/monitor-server-process.js --pid 12345 --interval-ms 500 --duration-ms 60000
// Stop with Ctrl+C if --duration-ms is omitted.
import { execSync } from "node:child_process";
import { parseArgs } from "./lib/cli-args.js";
import { OsProcessMonitor } from "./lib/process-monitor.js";
import { printSummary } from "./lib/stats.js";
import { writeResults } from "./lib/results.js";

function usage() {
  console.log(`Usage:
  node src/scripts/load-test/monitor-server-process.js [--pid <pid>] [--interval-ms 1000] [--duration-ms <ms>]
  (defaults to auto-detecting the process listening on port 3000 via lsof)`);
}

function autoDetectPid() {
  let pids;
  try {
    pids = execSync("lsof -ti:3000").toString().trim().split("\n").map(Number).filter(Boolean);
  } catch {
    pids = [];
  }
  if (pids.length === 0) {
    throw new Error("Could not find any process on port 3000 -- pass --pid explicitly (is `npm run dev` running?)");
  }
  // Port 3000 can be held by more than one process (e.g. a browser tab's network helper) --
  // filter lsof's PID list down to the one that's actually a `node` process.
  const nodePids = pids.filter((pid) => {
    try {
      return /node/i.test(execSync(`ps -p ${pid} -o comm=`).toString());
    } catch {
      return false;
    }
  });
  if (nodePids.length === 1) return nodePids[0];
  throw new Error(
    `Found ${pids.length} process(es) on port 3000 (node candidates: ${nodePids.join(", ") || "none"}) -- ` +
      `pass --pid explicitly to disambiguate.`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }

  const pid = args.pid ? Number(args.pid) : autoDetectPid();
  const intervalMs = Number(args["interval-ms"] ?? 1000);
  const durationMs = args["duration-ms"] ? Number(args["duration-ms"]) : null;

  console.log(`Monitoring pid ${pid} every ${intervalMs}ms${durationMs ? ` for ${durationMs}ms` : " (Ctrl+C to stop)"}...`);
  const monitor = new OsProcessMonitor(pid, intervalMs);
  monitor.start();

  const finish = () => {
    monitor.stop();
    const summary = monitor.getSummary();
    console.log(`\nCollected ${summary.sampleCount} samples`);
    printSummary("CPU %", summary.cpuPct, "%");
    printSummary("Memory %", summary.memPct, "%");
    printSummary("RSS", summary.rssKb, "kb");
    if (summary.cpuPct.max != null && summary.cpuPct.max > 90) {
      console.log("\nNote: CPU spiked above 90% during this window -- treat that window's latency numbers as server-saturated, not a clean measurement.");
    }
    writeResults("server-process-monitor", { pid, intervalMs, ...summary });
    process.exit(0);
  };

  if (durationMs) {
    setTimeout(finish, durationMs);
  } else {
    process.on("SIGINT", finish);
  }
}

main().catch((error) => {
  console.error("monitor-server-process failed:", error.message);
  process.exit(1);
});
