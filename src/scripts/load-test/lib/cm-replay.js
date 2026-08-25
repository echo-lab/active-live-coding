import { ChangeSet, Text } from "@codemirror/state";

// Replays a fixture's edits (or any {changes}[] sequence) into a final doc string, exactly the
// way the server's reconstructCMDoc (src/server/models.js:22-32) does. Used both to sanity-check
// a freshly captured fixture and, downstream, as the expected-convergence target that every
// simulated student's locally-tracked doc should match after a full replay.
export function replayToText(edits) {
  let doc = Text.empty;
  for (const { changes } of edits) {
    doc = ChangeSet.fromJSON(changes).apply(doc);
  }
  return doc.toString();
}
