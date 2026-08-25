// Nearest-rank percentile helper -- no dependency needed for our sample sizes (≤ a few thousand).
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export function summarize(numbers) {
  const clean = numbers.filter((n) => typeof n === "number" && !Number.isNaN(n));
  if (clean.length === 0) {
    return { count: 0, min: null, mean: null, p50: null, p90: null, p95: null, p99: null, max: null };
  }
  const sorted = [...clean].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    mean: sum / sorted.length,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
  };
}

function fmt(n) {
  if (n == null) return "-";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function printSummary(label, summary, unit = "ms") {
  console.log(
    `${label}: count=${summary.count} min=${fmt(summary.min)}${unit} mean=${fmt(summary.mean)}${unit} ` +
      `p50=${fmt(summary.p50)}${unit} p90=${fmt(summary.p90)}${unit} p95=${fmt(summary.p95)}${unit} ` +
      `p99=${fmt(summary.p99)}${unit} max=${fmt(summary.max)}${unit}`,
  );
}

export function printVerdict(passed, label) {
  console.log(`${passed ? "PASS" : "FAIL"} — ${label}`);
}
