// Reads every end-of-lecture SurveyResponse row and writes it to a timestamped
// CSV in this same directory, for offline analysis of the research study.
//
// Usage:
//   node src/scripts/export-survey-responses.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SurveyResponse, LectureSession, StudentConsent } from "../server/models.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// MARK: CSV helpers
function csvEscape(value) {
  const str = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function toCsvRow(values) {
  return values.map(csvEscape).join(",");
}

// MARK: Load data
const responses = await SurveyResponse.findAll({
  include: [{ model: LectureSession, attributes: ["id", "name"], required: false }],
  order: [["submitted_ts", "ASC"]],
});

const consents = await StudentConsent.findAll({ raw: true });
const consentByStudentId = new Map(consents.map((c) => [c.student_id, c.consented]));

function consentLabel(studentId) {
  if (!consentByStudentId.has(studentId)) return "unknown";
  return consentByStudentId.get(studentId) ? "yes" : "no";
}

// MARK: Build CSV
const HEADER = [
  "id",
  "LectureSessionId",
  "lecture_name",
  "student_id",
  "consented",
  "likert1",
  "likert2",
  "likert3",
  "likert4",
  "likert5",
  "open1",
  "open2",
  "submitted_ts",
  "submitted_time",
];

const rows = responses.map((r) =>
  toCsvRow([
    r.id,
    r.LectureSessionId,
    r.LectureSession?.name ?? "",
    r.student_id,
    consentLabel(r.student_id),
    r.likert1,
    r.likert2,
    r.likert3,
    r.likert4,
    r.likert5,
    r.open1,
    r.open2,
    r.submitted_ts,
    new Date(r.submitted_ts).toLocaleString(),
  ]),
);

const csv = [toCsvRow(HEADER), ...rows].join("\n") + "\n";

// MARK: Write file
function timestampForFilename() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `${date}_${time}`;
}

const outputPath = path.join(__dirname, `survey-responses_${timestampForFilename()}.csv`);
fs.writeFileSync(outputPath, csv);

if (responses.length === 0) console.log("No SurveyResponse rows found -- wrote a header-only CSV.");
console.log(`Wrote ${responses.length} survey response(s) to ${outputPath}`);
process.exit(0);
