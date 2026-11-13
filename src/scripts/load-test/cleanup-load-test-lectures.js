// Deletes LOAD_TEST_* lectures and all their child rows. No cascade deletes are configured
// anywhere in models.js, so every child table has to be cleared explicitly, in FK-dependency
// order, before the LectureSession row itself.
//
// Usage:
//   node src/scripts/load-test/cleanup-load-test-lectures.js --dry-run
//   node src/scripts/load-test/cleanup-load-test-lectures.js
import { Op } from "sequelize";
import {
  LectureSession,
  Document,
  DocumentChangeBatch,
  ClassExercise,
  ExerciseResponse,
  SimulatedExerciseResponse,
  StudentSession,
  VersionBlock,
  Variant,
} from "../../server/models.js";
import { parseArgs } from "./lib/cli-args.js";

function usage() {
  console.log(`Usage:
  node src/scripts/load-test/cleanup-load-test-lectures.js [--dry-run] [--prefix LOAD_TEST_]`);
}

async function deleteLecture(lecture) {
  const exercises = await ClassExercise.findAll({ where: { LectureSessionId: lecture.id } });
  for (const ex of exercises) {
    await ExerciseResponse.destroy({ where: { ClassExerciseId: ex.id } });
    await SimulatedExerciseResponse.destroy({ where: { ClassExerciseId: ex.id } });
  }
  await ClassExercise.destroy({ where: { LectureSessionId: lecture.id } });

  // Every Document (files AND variants) carries LectureSessionId, so this covers all change logs.
  const docs = await Document.findAll({ where: { LectureSessionId: lecture.id }, attributes: ["id"] });
  const docIds = docs.map((d) => d.id);
  await DocumentChangeBatch.destroy({ where: { DocumentId: docIds } });
  await Document.destroy({ where: { id: docIds } });

  const versionBlocks = await VersionBlock.findAll({ where: { LectureSessionId: lecture.id } });
  for (const vb of versionBlocks) {
    // force: Variant is paranoid -- actually delete, don't just soft-delete.
    await Variant.destroy({ where: { VersionBlockId: vb.id }, force: true });
  }
  await VersionBlock.destroy({ where: { LectureSessionId: lecture.id } });

  await StudentSession.destroy({ where: { LectureSessionId: lecture.id } });
  await lecture.destroy();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }
  const dryRun = Boolean(args["dry-run"]);
  const prefix = args.prefix ?? "LOAD_TEST_";

  const lectures = await LectureSession.findAll({ where: { name: { [Op.like]: `${prefix}%` } } });

  if (lectures.length === 0) {
    console.log(`No lectures found with name starting with "${prefix}"`);
    process.exit(0);
  }

  console.log(`Found ${lectures.length} lecture(s) matching "${prefix}*":`);
  lectures.forEach((l) => console.log(`  #${l.id} "${l.name}"`));

  if (dryRun) {
    console.log("\n--dry-run: not deleting anything.");
    process.exit(0);
  }

  for (const lecture of lectures) {
    await deleteLecture(lecture);
    console.log(`Deleted lecture #${lecture.id} "${lecture.name}"`);
  }
  console.log(`\nDone -- deleted ${lectures.length} lecture(s).`);
  process.exit(0);
}

main().catch((error) => {
  console.error("cleanup-load-test-lectures failed:", error.message);
  process.exit(1);
});
