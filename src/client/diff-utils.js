export function stripTrailingWhitespace(code) {
  return code.split("\n").map((l) => l.replace(/\s+$/, "")).join("\n");
}

// LCS-based line diff. Returns a flat list of {type, line} entries covering
// both original and new lines (type: "added" | "removed" | "unchanged").
export function computeLineDiff(origLines, newLines) {
  const m = origLines.length, n = newLines.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (origLines[i] === newLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }
  const result = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && origLines[i] === newLines[j]) {
      result.push({ type: "unchanged", line: newLines[j] });
      i++; j++;
    } else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) {
      result.push({ type: "added", line: newLines[j] });
      j++;
    } else {
      result.push({ type: "removed", line: origLines[i] });
      i++;
    }
  }

  // Post-process: reduce change-block fragmentation by shifting "unchanged"
  // entries past adjacent equal-content "added"/"removed" entries when the
  // preceding entry is already a change (i.e. the swap extends an existing
  // block rather than creating a new one). Repeated until stable.
  // Example: [added, unchanged(""), added("")] → [added, added(""), unchanged("")]
  let changed = true;
  while (changed) {
    changed = false;
    for (let k = 1; k < result.length - 1; k++) {
      if (
        result[k].type === "unchanged" &&
        result[k - 1].type !== "unchanged" &&
        (result[k + 1].type === "added" || result[k + 1].type === "removed") &&
        result[k].line === result[k + 1].line
      ) {
        [result[k], result[k + 1]] = [result[k + 1], result[k]];
        changed = true;
      }
    }
  }

  return result;
}

// Converts computeLineDiff output to per-current-line status + deletion markers,
// suitable for CodeMirror gutter annotations. "added" lines immediately following
// a removal are reclassified as "modified".
export function toGutterState(diff) {
  const status = [];
  const deletionsBefore = new Set();
  let pendingDeletion = false;
  let currentIdx = 0;
  for (const entry of diff) {
    if (entry.type === "removed") {
      pendingDeletion = true;
    } else if (entry.type === "added") {
      status.push(pendingDeletion ? "modified" : "added");
      pendingDeletion = false;
      currentIdx++;
    } else {
      if (pendingDeletion) { deletionsBefore.add(currentIdx); pendingDeletion = false; }
      status.push("same");
      currentIdx++;
    }
  }
  if (pendingDeletion) deletionsBefore.add(currentIdx);
  return { status, deletionsBefore };
}
