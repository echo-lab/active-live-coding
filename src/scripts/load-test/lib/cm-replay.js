import { ChangeSet, Text } from "@codemirror/state";
import { editsByFile } from "./fixture-io.js";

// Replays a sequence of edits to ONE file ({changes}[]) into a final doc string, exactly the way
// the server's reconstructCMDoc (src/server/models.js) does. Used both to sanity-check a freshly
// captured fixture and, downstream, as the expected-convergence target that every simulated
// student's locally-tracked doc should match after a full replay.
export function replayToText(edits) {
  let doc = Text.empty;
  for (const { changes } of edits) {
    doc = ChangeSet.fromJSON(changes).apply(doc);
  }
  return doc.toString();
}

// fileName -> {text, docVersion}: every file's final state after replaying a (normalized) fixture.
export function replayFixtureFiles(fixture) {
  const result = new Map();
  for (const [name, edits] of editsByFile(fixture)) {
    result.set(name, { text: replayToText(edits), docVersion: edits.length });
  }
  return result;
}
