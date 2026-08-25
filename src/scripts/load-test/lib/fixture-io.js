import fs from "node:fs";
import path from "node:path";

export function validateFixture(fixture) {
  if (!fixture || !Array.isArray(fixture.edits) || fixture.edits.length === 0) {
    throw new Error("Fixture must have a non-empty 'edits' array");
  }
  fixture.edits.forEach((edit, i) => {
    if (edit.id !== i) {
      throw new Error(`Fixture edits must have contiguous 0-based ids -- edit at index ${i} has id ${edit.id}`);
    }
    if (edit.changes == null) {
      throw new Error(`Fixture edit ${i} is missing 'changes'`);
    }
  });
  return fixture;
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
