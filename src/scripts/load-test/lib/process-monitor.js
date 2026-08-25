import { execFile } from "node:child_process";
import { summarize } from "./stats.js";

// OS-level CPU/memory sampling of a running process via `ps` -- deliberately avoids
// touching server code (see plan's "Tier 1 vs Tier 2" resource-monitoring tradeoff).
export class OsProcessMonitor {
  constructor(pid, intervalMs = 1000) {
    this.pid = pid;
    this.intervalMs = intervalMs;
    this.samples = [];
  }

  start() {
    this.timer = setInterval(() => this.#sample(), this.intervalMs);
    this.#sample();
  }

  #sample() {
    execFile("ps", ["-o", "pcpu=,pmem=,rss=", "-p", String(this.pid)], (error, stdout) => {
      if (error) return; // process may have exited; just skip this sample
      const [cpuPct, memPct, rssKb] = stdout.trim().split(/\s+/).map(Number);
      if (!Number.isNaN(cpuPct)) {
        this.samples.push({ t: Date.now(), cpuPct, memPct, rssKb });
      }
    });
  }

  stop() {
    clearInterval(this.timer);
  }

  getSummary() {
    return {
      sampleCount: this.samples.length,
      cpuPct: summarize(this.samples.map((s) => s.cpuPct)),
      memPct: summarize(this.samples.map((s) => s.memPct)),
      rssKb: summarize(this.samples.map((s) => s.rssKb)),
    };
  }
}
