import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RESULTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "results");

export function writeResults(testName, data) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(RESULTS_DIR, `${timestamp}-${testName}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`\nFull results written to ${path.relative(process.cwd(), filePath)}`);
  return filePath;
}

export function writeNamedResult(fileName, data) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const filePath = path.join(RESULTS_DIR, fileName);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

export function readNamedResult(fileName) {
  const filePath = path.join(RESULTS_DIR, fileName);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}
