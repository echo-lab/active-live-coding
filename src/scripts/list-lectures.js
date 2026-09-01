// Read-only CLI for browsing lectures so you can pick an id to pass to
// lecture-report.js.
//
// Usage:
//   node src/scripts/list-lectures.js
import { LectureSession, ClassExercise, StudentSession } from "../server/models.js";

const lectures = await LectureSession.findAll({ order: [["id", "DESC"]] });

const rows = [];
for (const lecture of lectures) {
  const [exerciseCount, studentCount] = await Promise.all([
    ClassExercise.count({ where: { LectureSessionId: lecture.id } }),
    StudentSession.count({ where: { LectureSessionId: lecture.id } }),
  ]);
  rows.push({
    id: lecture.id,
    name: lecture.name,
    created: lecture.createdAt.toLocaleString(),
    finished: lecture.isFinished,
    hasReviewLink: lecture.uuid != null,
    exercises: exerciseCount,
    students: studentCount,
  });
}

console.table(rows);
console.log(`\n${rows.length} lecture(s). Pass an id to: node src/scripts/lecture-report.js <id>`);
process.exit(0);
