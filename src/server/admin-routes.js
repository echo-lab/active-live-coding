import { db } from "./database.js";
import { Event, decompressEventBatch } from "./events-database.js";
import {
  LectureSession,
  ClassExercise,
  ExerciseResponse,
  SimulatedExerciseResponse,
  StudentSession,
  VersionBlock,
  Variant,
  VariantChange,
} from "./models.js";

// Dev-only routes for offline analysis: listing every lecture, and dumping everything needed to
// replay one lecture's whole history client-side (raw ordered rows, not pre-reconstructed state --
// the client does all the "what did it look like at time T" work itself, once, in memory). Gated
// out of production entirely by the ADMIN_PATH_PREFIXES middleware in main.js.
export function registerAdminRoutes(app, { flushInstructorChanges, flushEvents }) {
  // MARK: List lectures
  app.get("/api/admin/lectures", async (req, res) => {
    try {
      const sessions = await LectureSession.findAll({ order: [["id", "DESC"]] });
      res.json({
        lectures: sessions.map((s) => ({
          id: s.id,
          name: s.name,
          instructor_id: s.instructor_id,
          createdAt: s.createdAt.getTime(),
          isFinished: s.isFinished,
        })),
      });
    } catch (error) {
      console.error("Error fetching lectures for admin list:", error);
      res.json({ error: error.message });
    }
  });

  // MARK: Lecture replay data
  // Returns every raw row needed to reconstruct this lecture's entire history client-side: the
  // full InstructorChange log, every VersionBlock (including dissolved ones) with all Variants and
  // their own change logs, every ClassExercise with every response, and the offline events log's
  // instructor-side events (for timeline annotations). Sent once, in full -- the replay page never
  // queries the backend again after this.
  app.get("/api/admin/lecture/:id/replay", async (req, res) => {
    const lectureId = Number(req.params.id);
    if (!Number.isInteger(lectureId)) return res.json({ error: "Invalid lecture id" });

    await Promise.all([flushInstructorChanges(), flushEvents()]);

    try {
      const mainDbWork = db.transaction(async (t) => {
        const lecture = await LectureSession.findByPk(lectureId, { transaction: t });
        if (!lecture) return { error: "Lecture not found" };

        const instructorChanges = await lecture.getInstructorChanges({
          attributes: ["change_number", "change", "change_ts"],
          order: ["change_number"],
          transaction: t,
        });

        const versionBlocks = await lecture.getVersionBlocks({
          // No deleted:false filter -- dissolved blocks are needed too, so the replay can show
          // them present, then gone, exactly as they were.
          include: [{ model: Variant, include: [VariantChange] }],
          order: [["createdAt", "ASC"]],
          transaction: t,
        });

        const exercises = await lecture.getClassExercises({
          include: [
            {
              model: ExerciseResponse,
              include: [{ model: StudentSession, attributes: ["student_id", "student_identifier"], required: false }],
            },
            { model: SimulatedExerciseResponse, required: false },
            { model: VersionBlock, required: false },
          ],
          order: [["start_ts", "ASC"]],
          transaction: t,
        });

        return {
          id: lecture.id,
          name: lecture.name,
          instructor_id: lecture.instructor_id,
          isFinished: lecture.isFinished,
          createdAt: lecture.createdAt.getTime(),
          instructorChanges: instructorChanges.map((c) => ({
            changeNumber: c.change_number,
            change: JSON.parse(c.change),
            ts: c.change_ts,
          })),
          versionBlocks: versionBlocks.map((b) => ({
            id: b.id,
            anchor_pos: b.anchor_pos,
            anchor_change_number: b.anchor_change_number,
            deleted: b.deleted,
            deleted_change_number: b.deleted_change_number,
            createdAt: b.createdAt.getTime(),
            variants: [...b.Variants]
              .sort((a, c) => new Date(a.createdAt) - new Date(c.createdAt))
              .map((v) => ({
                id: v.id,
                name: v.name,
                createdAt: v.createdAt.getTime(),
                changes: [...v.VariantChanges]
                  .sort((a, c) => a.change_number - c.change_number)
                  .map((c) => ({ changeNumber: c.change_number, change: JSON.parse(c.change), ts: c.change_ts })),
              })),
          })),
          exercises: exercises.map((ex) => ({
            id: ex.id,
            type: ex.type,
            start_ts: ex.start_ts,
            end_ts: ex.end_ts,
            instructions: ex.instructions,
            instructor_code: ex.instructor_code,
            default_answer: ex.default_answer,
            code_anchor_from: ex.code_anchor_from,
            code_anchor_to: ex.code_anchor_to,
            code_anchor_doc_version: ex.code_anchor_doc_version,
            VersionBlockId: ex.VersionBlockId,
            VersionBlock: ex.VersionBlock
              ? { deleted: ex.VersionBlock.deleted, deleted_change_number: ex.VersionBlock.deleted_change_number }
              : null,
            responses: ex.ExerciseResponses.map((r) => ({
              id: r.id,
              student_id: r.student_id,
              student_identifier: r.StudentSession?.student_identifier ?? null,
              answer: r.answer,
              submitted_ts: r.submitted_ts,
              history: r.history ? JSON.parse(r.history) : [],
            })),
            simulatedResponses: (ex.SimulatedExerciseResponses ?? []).map((r) => ({
              id: r.id,
              student_name: r.student_name,
              answer: r.answer,
            })),
          })),
        };
      });

      // events.sqlite is a separate Sequelize instance from the main db -- can't share the
      // transaction above, so this runs independently. No userId filter: an instructor can have
      // multiple ids across page reloads, and isStudent:false alone scopes it correctly.
      const eventsWork = Event.findAll({ where: { lectureId, isStudent: false } }).then((rows) => {
        const events = [];
        for (const row of rows) {
          events.push(...decompressEventBatch(row.payload));
        }
        events.sort((a, b) => a.timestamp - b.timestamp);
        return events;
      });

      const [main, instructorEvents] = await Promise.all([mainDbWork, eventsWork]);
      if (main.error) return res.json(main);
      res.json({ ...main, instructorEvents });
    } catch (error) {
      console.error("Error building admin lecture replay payload:", error);
      res.json({ error: error.message });
    }
  });
}
