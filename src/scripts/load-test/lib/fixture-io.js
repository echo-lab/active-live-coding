import fs from "node:fs";
import path from "node:path";
import { DEFAULT_FILE_NAME } from "../../../shared-constants.js";

// A fixture is a lecture's instructor edits across all of its files, interleaved in the order they
// happened: {files: [{name, ...}], edits: [{fileName, id, changes, ts}], ...}. Each edit's `id` is
// its file's doc version (contiguous from 0 per file). The first file listed is the lecture's main
// file; the others are created before replaying.
//
// Older single-file fixtures have no `files` and no `fileName` on their edits: they load as if
// every edit were to main.py.
export function normalizeFixture(fixture) {
  if (!fixture || !Array.isArray(fixture.edits) || fixture.edits.length === 0) {
    throw new Error("Fixture must have a non-empty 'edits' array");
  }
  const edits = fixture.edits.map((edit) => ({ ...edit, fileName: edit.fileName ?? DEFAULT_FILE_NAME }));
  const files = fixture.files?.length ? fixture.files : [{ name: DEFAULT_FILE_NAME }];
  return { ...fixture, files, edits };
}

export function validateFixture(fixture) {
  fixture = normalizeFixture(fixture);
  const fileNames = new Set(fixture.files.map((f) => f.name));
  const nextId = new Map();
  fixture.edits.forEach((edit, i) => {
    if (!fileNames.has(edit.fileName)) {
      throw new Error(`Fixture edit ${i} is to "${edit.fileName}", which isn't in the fixture's 'files'`);
    }
    const expected = nextId.get(edit.fileName) ?? 0;
    if (edit.id !== expected) {
      throw new Error(`Fixture edits must have contiguous 0-based ids per file -- edit at index ${i} (${edit.fileName}) has id ${edit.id}, expected ${expected}`);
    }
    nextId.set(edit.fileName, expected + 1);
    if (edit.changes == null) {
      throw new Error(`Fixture edit ${i} is missing 'changes'`);
    }
  });
  return fixture;
}

// fileName -> that file's edits, in order.
export function editsByFile(fixture) {
  const byFile = new Map(fixture.files.map((f) => [f.name, []]));
  for (const edit of fixture.edits) byFile.get(edit.fileName).push(edit);
  return byFile;
}

export function loadFixture(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  return validateFixture(JSON.parse(raw));
}

export function saveFixture(filePath, fixture) {
  validateFixture(fixture);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(fixture, null, 2));
}
