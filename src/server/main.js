import "dotenv/config";
import express from "express";
import ViteExpress from "vite-express";
import * as http from "http";
import { randomUUID } from "node:crypto";
import { Server } from "socket.io";
import { db } from "./database.js";
import {
  LectureSession,
  ClassExercise,
  ExerciseResponse,
  SimulatedExerciseResponse,
  StudentSession,
  StudentConsent,
  SurveyResponse,
  VersionBlock,
  Variant,
  VariantChange,
  InstructorChange,
  reconstructCMDoc,
} from "./models.js";
import { ChangeSet } from "@codemirror/state";
import { createSimulatedResponses } from "./simulate-responses.js";
import { suggestMcqChoices } from "./suggest-mcq-choices.js";
import { createGroupSummary } from "./group-responses.js";
import { SOCKET_MESSAGE_TYPE } from "../shared-constants.js";
import { ChangeBuffer } from "./change-buffer.js";
import { eventsDb } from "./events-database.js";
import { EventBuffer } from "./event-buffer.js";

const app = express();
app.use(express.json({ limit: "50mb" }));

let instructorChangeBuffer = new ChangeBuffer(5000, db);
let eventBuffer = new EventBuffer(30000);
let flushInstructorChanges = async () => {
  try {
    await db.transaction(async (t) => {
      await instructorChangeBuffer.flush(t);
    });
    return true;
  } catch (error) {
    console.error("Error flushing changes:", error);
    return false;
  }
};

// MARK: list lectures
// Return a list of all the lectures.
app.get("/lecture-sessions", async (req, res) => {
  try {
    let response = await db.transaction(async (t) => {
      let sessions = await LectureSession.findAll(
        {
          order: [["createdAt", "DESC"]],
        },
        { transaction: t },
      );
      sessions = sessions.map((sesh) => ({
        id: sesh.id,
        name: sesh.name,
        startTime: sesh.createdAt,
        status: sesh.isFinished ? "CLOSED" : "OPEN",
      }));
      return { sessions };
    });
    res.json(response);
  } catch (error) {
    console.error("Error fetching all sessions:", error);
    res.json({ error: error.message });
  }
});

// Returns all the student sessions associated w/ a lecture.
app.get("/session-details", async (req, res) => {
  res.json({ error: "Not implemented" });
});

// MARK: List my lectures
// Return lectures created by the given user, most recent first, for lecture-list.html.
app.get("/my-lectures", async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.json({ error: "userId is required" });
  try {
    let response = await db.transaction(async (t) => {
      let sessions = await LectureSession.findAll({
        where: { instructor_id: userId },
        order: [["createdAt", "DESC"]],
        transaction: t,
      });
      let lectures = sessions
        .filter((sesh) => sesh.uuid) // older lectures predate the uuid column and have no review link
        .map((sesh) => ({
          uuid: sesh.uuid,
          name: sesh.name,
          createdAt: sesh.createdAt,
        }));
      return { lectures };
    });
    res.json(response);
  } catch (error) {
    console.error("Error fetching lectures for user:", error);
    res.json({ error: error.message });
  }
});

// MARK: Get/create lecture
// Get or create a lecture session
app.post("/lecture-session", async (req, res) => {
  let { sessionName, userId } = req.body;
  if (!userId) return res.json({ error: "userId is required" });

  await flushInstructorChanges();

  try {
    let response = await db.transaction(async (t) => {
      let sesh =
        (await LectureSession.current(sessionName, t)) ??
        (await LectureSession.create(
          { name: sessionName, instructor_id: userId, uuid: randomUUID() },
          { transaction: t },
        ));
      if (sesh.instructor_id !== userId) {
        return {
          error: "Lecture name not available.",
        };
      }

      let { doc, docVersion } = await sesh.getDoc(t);
      let exercises = await sesh.getExercisesForInstructor(t);
      let versionBlocks = await sesh.getVersionBlocksWithPositions(t);
      return {
        doc: doc.toJSON(),
        docVersion,
        sessionNumber: sesh.id,
        uuid: sesh.uuid,
        exercises,
        versionBlocks,
      };
    });
    res.json(response);
  } catch (error) {
    console.error("Error getting or creating new lecture:", error);
    res.json({ error: error.message });
  }
});

// MARK: Get instructor changes
app.get("/instructor-changes/:sessionId/:docversion", async (req, res) => {
  let sessionId = req.params?.sessionId;
  let docVersion = parseInt(req.params?.docversion);
  if (isNaN(docVersion) || docVersion < 0) {
    res.json({ error: `invalid doc version: ${req.params.docversion}` });
    return;
  }

  await flushInstructorChanges();

  try {
    let response = await db.transaction(async (t) => {
      let sesh = await LectureSession.findByPk(sessionId, { transaction: t });
      if (!sesh) return { error: `Session w/ id=${sessionId} not found` };
      return { changes: await sesh.changesSinceVersion(docVersion, t) };
    });
    res.json(response);
  } catch (error) {
    console.error("Error retrieving changes: ", error);
    res.json({ error: error.message });
  }
});


// MARK: Create version block
app.post("/version-block", async (req, res) => {
  const { lectureId, anchor_pos, docVersion, variantCode } = req.body;
  if (lectureId == null || anchor_pos == null || docVersion == null || variantCode == null) {
    return res.json({ error: "lectureId, anchor_pos, docVersion, and variantCode are required" });
  }

  await flushInstructorChanges();

  try {
    let response = await db.transaction(async (t) => {
      let lecture = await LectureSession.findByPk(lectureId, { transaction: t });
      if (!lecture) return { error: `Session #${lectureId} not found` };
      const { block, variant } = await VersionBlock.createWithVariant(
        lectureId,
        { anchor_pos, anchor_change_number: docVersion, variantCode },
        t,
      );
      return { versionBlockId: block.id, variantId: variant.id };
    });
    res.json(response);
  } catch (error) {
    console.error("Failed to create version block:", error);
    res.json({ error: error.message });
  }
});

// MARK: VersionBlock delete

app.delete("/version-block/:id", async (req, res) => {
  await flushInstructorChanges();

  try {
    const result = await db.transaction(async (t) => {
      const block = await VersionBlock.findByPk(req.params.id, { transaction: t });
      if (!block) return res.status(404).json({ error: "Not found" });

      // Record how many InstructorChanges existed right now, before this dissolve's own
      // flatten-insert edit lands -- lets a later "historical view" reconstruct the doc with
      // this block's widget still present, exactly as it looked right before deletion.
      const deleted_change_number = await InstructorChange.count({
        where: { LectureSessionId: block.LectureSessionId },
        transaction: t,
      });
      await block.update({ deleted: true, deleted_change_number }, { transaction: t });

      // Dissolving a still-active exercise should behave like finishing it (minus the
      // summary step) so it doesn't linger as "Active" in the activities panel.
      const exercise = await block.getClassExercise({ transaction: t });
      let finishedExerciseId = null;
      if (exercise && exercise.end_ts === null) {
        await exercise.finish(t);
        finishedExerciseId = exercise.id;
      }

      return { ok: true, finishedExerciseId };
    });
    res.json(result);
  } catch (err) {
    console.error("Failed to soft-delete version block:", err);
    res.status(500).json({ error: err.message });
  }
});

// MARK: Variant CRUD

app.post("/variant", async (req, res) => {
  const { versionBlockId, name } = req.body;
  if (versionBlockId == null || !name) return res.json({ error: "versionBlockId and name are required" });
  try {
    const result = await db.transaction(async (t) => {
      const block = await VersionBlock.findByPk(versionBlockId, { transaction: t });
      if (!block) return { error: `VersionBlock #${versionBlockId} not found` };
      const variant = await Variant.create({ VersionBlockId: versionBlockId, name }, { transaction: t });
      const insertCs = ChangeSet.of([{ from: 0, insert: "" }], 0);
      await VariantChange.create(
        { VariantId: variant.id, change_number: 0, change: JSON.stringify(insertCs.toJSON()), change_ts: Date.now() },
        { transaction: t },
      );
      return { variantId: variant.id, name, docVersion: 1};
    });
    res.json(result);
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.patch("/variant/:id", async (req, res) => {
  const { name } = req.body;
  if (!name) return res.json({ error: "name is required" });
  try {
    const variant = await Variant.findByPk(req.params.id);
    if (!variant) return res.json({ error: "Variant not found" });
    await variant.update({ name });
    res.json({ ok: true });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.delete("/variant/:id", async (req, res) => {
  try {
    const result = await db.transaction(async (t) => {
      const variant = await Variant.findByPk(req.params.id, { transaction: t });
      if (!variant) return { error: "Variant not found" };
      const siblings = await Variant.count({ where: { VersionBlockId: variant.VersionBlockId }, transaction: t });
      if (siblings <= 1) return { error: "Cannot delete the last variant" };
      await VariantChange.destroy({ where: { VariantId: variant.id }, transaction: t });
      await variant.destroy({ transaction: t });
      return { ok: true };
    });
    res.json(result);
  } catch (error) {
    res.json({ error: error.message });
  }
});

// TODO: this probably shouldn't exist?
app.put("/variant/:id/code", async (req, res) => {
  const { code } = req.body;
  if (code == null) return res.json({ error: "code is required" });
  try {
    await db.transaction(async (t) => {
      const variant = await Variant.findByPk(req.params.id, { transaction: t });
      if (!variant) throw new Error("Variant not found");
      const changes = await VariantChange.findAll({
        where: { VariantId: variant.id },
        order: [["change_number", "ASC"]],
        transaction: t,
      });
      const { doc: currentDoc } = reconstructCMDoc(changes);
      const currentCode = currentDoc.toString();
      const nextNumber = changes.length;
      const cs = ChangeSet.of([{ from: 0, to: currentCode.length, insert: code }], currentCode.length);
      await VariantChange.create(
        { VariantId: variant.id, change_number: nextNumber, change: JSON.stringify(cs.toJSON()), change_ts: Date.now() },
        { transaction: t },
      );
    });
    res.json({ ok: true });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// MARK: Get/make stdt sesh
// Get or create a StudentSession for student-page.html.
// Returns info about:
//   1) the instructor's code (doc/version)
//   2) the student's playground code (doc/version)
//   3) all exercises for this lecture, with this student's response for each
//   4) the session number and student session id
app.post("/current-session-student", async (req, res) => {
  let { student_id, student_identifier, sessionName } = req.body;
  if (!student_id) {
    return res.json({ error: "student_id is required" });
  }

  await flushInstructorChanges();

  try {
    let response = await db.transaction(async (t) => {
      let lecture = await LectureSession.current(sessionName, t);
      if (!lecture) return {};

      let existing = await lecture.getStudentSessions(
        { where: { student_id } },
        { transaction: t },
      );
      let sesh =
        existing.length > 0
          ? existing[0]
          : await lecture.createStudentSession(
              { student_id, student_identifier },
              { transaction: t },
            );

      let { doc: lectureDoc, docVersion: lectureDocVersion } =
        await lecture.getDoc(t);
      let exercises = await lecture.getExercisesForStudent(student_id, t);
      let versionBlocks = await lecture.getVersionBlocksWithPositions(t);

      return {
        sessionNumber: lecture.id,
        studentSessionId: sesh.id,
        lectureDoc,
        lectureDocVersion,
        exercises,
        versionBlocks,
      };
    });
    res.json(response);
  } catch (error) {
    console.error("Failed to get or create student session:", error);
    res.json({ error: error.message });
  }
});

app.post("/record-playground-changes", async (req, res) => {
  return res.json({ error: "no longer supported" });
});

// MARK: Read-only lecture review
// Returns a one-shot snapshot of a lecture's current state for the read-only review page,
// keyed by the lecture's uuid (its access token). Only includes the given student's own
// exercise responses, mirroring getExercisesForStudent's use in /current-session-student --
// no studentId means no responses (never "everyone's responses").
app.get("/review-lecture", async (req, res) => {
  const { id, studentId } = req.query;
  if (!id) return res.json({ error: "id is required" });

  await flushInstructorChanges();

  try {
    const response = await db.transaction(async (t) => {
      const lecture = await LectureSession.findOne({ where: { uuid: id }, transaction: t });
      if (!lecture) return { error: "Lecture not found" };

      const { doc: lectureDoc, docVersion: lectureDocVersion } = await lecture.getDoc(t);
      const exercises = await lecture.getExercisesForStudent(studentId ?? "", t);
      const versionBlocks = await lecture.getVersionBlocksWithPositions(t);

      return {
        name: lecture.name,
        isFinished: lecture.isFinished,
        sessionNumber: lecture.id,
        lectureDoc,
        lectureDocVersion,
        exercises,
        versionBlocks,
      };
    });
    res.json(response);
  } catch (error) {
    console.error("Error fetching lecture for review:", error);
    res.json({ error: error.message });
  }
});

// MARK: record consent
// Records (or updates) whether a student has consented to share study data.
// Keyed by student_id, not by lecture, since consent applies to the whole study.
app.post("/api/consent", async (req, res) => {
  let { student_id, consented } = req.body;
  if (!student_id || typeof consented !== "boolean") {
    return res.json({ error: "student_id and consented are required" });
  }
  try {
    await StudentConsent.upsert({
      student_id,
      consented,
      consented_ts: new Date(),
    });
    res.json({ ok: true });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// MARK: record survey response
// Always creates a new row -- resubmitting the survey never overwrites a
// prior response, so we keep the full history with timestamps.
app.post("/api/survey-response", async (req, res) => {
  let {
    student_id,
    lectureId,
    likert1,
    likert2,
    likert3,
    likert4,
    likert5,
    open1,
    open2,
  } = req.body;
  if (!student_id) {
    return res.json({ error: "student_id is required" });
  }
  try {
    let lecture = lectureId ? await LectureSession.findByPk(lectureId) : null;
    await SurveyResponse.create({
      LectureSessionId: lecture ? lecture.id : null,
      student_id,
      likert1: likert1 ?? null,
      likert2: likert2 ?? null,
      likert3: likert3 ?? null,
      likert4: likert4 ?? null,
      likert5: likert5 ?? null,
      open1: open1 ?? null,
      open2: open2 ?? null,
      submitted_ts: Date.now(),
    });
    res.json({ ok: true });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// MARK: record events
// eventArray is a client-compressed batch of {timestamp, payload} events;
// it's stored as-is (one row per batch, not per event) -- see event-buffer.js.
app.post("/api/events", (req, res) => {
  let { isStudent, userId, lectureId, eventArray } = req.body;
  if (typeof eventArray === "string") {
    eventBuffer.enqueue({
      isStudent,
      userId,
      lectureId,
      timestamp: Date.now(),
      payload: Buffer.from(eventArray, "base64"),
    });
  }
  res.json({ success: true });
});

// MARK: create exercise
// Create a new exercise for a lecture session.
app.post("/exercise", async (req, res) => {
  const {
    lectureId,
    type,
    instructions,
    instructor_code,
    default_answer,
    code_line_context_start,
    code_line_context_end,
    code_anchor_from,
    code_anchor_to,
    code_anchor_doc_version,
    version_block_id,
  } = req.body;
  if (!lectureId || !type)
    return res.json({ error: "lectureId and type are required" });

  try {
    let response = await db.transaction(async (t) => {
      let lecture = await LectureSession.findByPk(lectureId, {
        transaction: t,
      });
      if (!lecture) return { error: `Session #${lectureId} not found` };
      if (version_block_id) {
        const blockExercise = await ClassExercise.findOne({
          where: { VersionBlockId: version_block_id },
          transaction: t,
        });
        if (blockExercise) return { error: "This version block already has an exercise" };
      }
      let exercise = await ClassExercise.createForLecture(
        lectureId,
        {
          type,
          instructions,
          instructor_code,
          default_answer,
          code_line_context_start,
          code_line_context_end,
          code_anchor_from,
          code_anchor_to,
          code_anchor_doc_version,
          version_block_id,
        },
        t,
      );
      return { exerciseId: exercise.id, exercise };
    });

    res.json(response);
  } catch (error) {
    console.error("Failed to create exercise:", error);
    res.json({ error: error.message });
  }
});

// MARK: Simulate responses
// Create simulated student responses for an exercise.
app.post("/simulate-responses", async (req, res) => {
  const { instructorId, exerciseId, additional_context } = req.body;
  if (!instructorId || !exerciseId)
    return res.json({ error: "instructorId and exerciseId are required" });

  try {
    const exercise = await ClassExercise.findByPk(exerciseId, {
      include: [LectureSession],
    });
    if (!exercise) return res.json({ error: `Exercise #${exerciseId} not found` });
    if (exercise.LectureSession.instructor_id !== instructorId)
      return res.json({ error: "Unauthorized" });
    if (exercise.end_ts !== null)
      return res.json({ error: "Exercise is already completed" });

    const records = await createSimulatedResponses(exercise, additional_context);
    res.json({ simulatedResponses: records ?? [] });
  } catch (error) {
    console.error("Failed to simulate responses:", error);
    res.json({ error: error.message });
  }
});

// MARK: Suggest MCQ choices
app.post("/suggest-mcq-choices", async (req, res) => {
  const { instructions, instructor_code, full_instructor_code } = req.body;
  try {
    const choices = await suggestMcqChoices({ instructions, instructor_code, full_instructor_code });
    res.json({ choices });
  } catch (error) {
    console.error("Failed to suggest MCQ choices:", error);
    res.json({ error: error.message });
  }
});

// MARK: Historical context
// Reconstructs the editor + the given exercise's anchor as they looked at the moment that
// exercise's anchor was captured -- used to render a read-only "historical view" once an
// activity's live anchor is gone (poll's code fully deleted, or its Version Block dissolved).
app.get("/exercise/:id/historical-context", async (req, res) => {
  const exerciseId = req.params.id;

  await flushInstructorChanges();

  try {
    const response = await db.transaction(async (t) => {
      const exercise = await ClassExercise.findByPk(exerciseId, { transaction: t });
      if (!exercise) return { error: `Exercise #${exerciseId} not found` };
      const lecture = await LectureSession.findByPk(exercise.LectureSessionId, { transaction: t });
      if (!lecture) return { error: `Session #${exercise.LectureSessionId} not found` };
      return lecture.getHistoricalContextForExercise(exerciseId, t, req.query.student_id ?? null);
    });
    res.json(response);
  } catch (error) {
    console.error("Failed to get historical context:", error);
    res.json({ error: error.message });
  }
});

// MARK: Finish exercise
// Finish an exercise (sets end timestamp).
// TODO: gather student responses and generate an automatic summary.
app.post("/exercise/finish", async (req, res) => {
  const { exerciseId } = req.body;
  if (!exerciseId) return res.json({ error: "exerciseId is required" });

  try {
    let response = await db.transaction(async (t) => {
      let exercise = await ClassExercise.findByPk(exerciseId, {
        transaction: t,
      });
      if (!exercise) return { error: `Exercise #${exerciseId} not found` };
      await exercise.finish(t);
      return { success: true };
    });
    res.json(response);
  } catch (error) {
    console.error("Failed to finish exercise:", error);
    res.json({ error: error.message });
  }
});

// MARK: MCQ results
// Returns aggregate per-choice counts for a completed POLL_MCQ exercise. Used by students, whose
// browsers never receive other students' raw responses -- unlike the instructor, who already has
// every ExerciseResponse locally. Gated on end_ts so results can't be peeked at while still open.
app.post("/exercise/mcq-results", async (req, res) => {
  const { exerciseId } = req.body;
  if (!exerciseId) return res.json({ error: "exerciseId is required" });

  try {
    const exercise = await ClassExercise.findByPk(exerciseId);
    if (!exercise) return res.json({ error: `Exercise #${exerciseId} not found` });
    if (exercise.type !== "POLL_MCQ") return res.json({ error: "Not a multiple-choice poll" });
    if (exercise.end_ts === null) return res.json({ error: "Exercise is not yet completed" });

    const choices = exercise.default_answer ? JSON.parse(exercise.default_answer) : [];
    const responses = await ExerciseResponse.findAll({ where: { ClassExerciseId: exerciseId } });
    const counts = new Array(choices.length).fill(0);
    let total = 0;
    responses.forEach((r) => {
      const idx = parseInt(r.answer, 10);
      if (!isNaN(idx) && idx >= 0 && idx < choices.length) {
        counts[idx]++;
        total++;
      }
    });
    res.json({ counts, total });
  } catch (error) {
    console.error("Failed to compute MCQ results:", error);
    res.json({ error: error.message });
  }
});

// MARK: Exercise summary
// Returns the existing summary for a completed exercise, or generates one via LLM.
app.post("/exercise/summary", async (req, res) => {
  const { instructorId, exerciseId } = req.body;
  if (!instructorId || !exerciseId)
    return res.json({ error: "instructorId and exerciseId are required" });

  try {
    const exercise = await ClassExercise.findByPk(exerciseId, {
      include: [LectureSession],
    });
    if (!exercise) return res.json({ error: `Exercise #${exerciseId} not found` });
    if (exercise.LectureSession.instructor_id !== instructorId)
      return res.json({ error: "Unauthorized" });
    if (exercise.end_ts === null)
      return res.json({ error: "Exercise is not yet completed" });

    if (exercise.summary) {
      return res.json({ summary: JSON.parse(exercise.summary) });
    }

    const [realResponses, simulatedResponses] = await Promise.all([
      ExerciseResponse.findAll({ where: { ClassExerciseId: exerciseId } }),
      SimulatedExerciseResponse.findAll({ where: { ClassExerciseId: exerciseId } }),
    ]);

    const groups = await createGroupSummary(exercise, realResponses, simulatedResponses);
    if (groups != null) {
      await exercise.update({ summary: JSON.stringify(groups) });
    }
    res.json({ summary: groups ?? null });
  } catch (error) {
    console.error("Failed to generate exercise summary:", error);
    res.json({ error: error.message });
  }
});

// MARK: exercise response
// Submit (or update) a student's response to an exercise.
app.post("/exercise/response", async (req, res) => {
  const { exerciseId, student_id, answer } = req.body;
  if (!exerciseId || !student_id || answer == null) {
    return res.json({
      error: "exerciseId, student_id, and answer are required",
    });
  }

  try {
    let response = await db.transaction(async (t) => {
      let exercise = await ClassExercise.findByPk(exerciseId, {
        transaction: t,
      });
      if (!exercise) return { error: `Exercise #${exerciseId} not found` };
      let studentSession = await StudentSession.findOne({
        where: { student_id, LectureSessionId: exercise.LectureSessionId },
        transaction: t,
      });
      let record = await ExerciseResponse.submitOrUpdate(
        exerciseId,
        { student_id, answer, studentSessionId: studentSession?.id },
        t,
      );
      return { responseId: record.id };
    });
    res.json(response);
  } catch (error) {
    console.error("Failed to submit exercise response:", error);
    res.json({ error: error.message });
  }
});

// ViteExpress.listen(app, 3000, () =>
//   console.log("Server is listening on port 3000..."),
// );

// Non-destructive: only creates tables that don't already exist yet (e.g. new
// models), never drops/alters existing ones. See DANGER_sync_db.js for the
// destructive force-sync used when resetting the whole dev DB.
await db.sync();
await eventsDb.sync();

const server = http.createServer(app).listen(3000, () => {
  console.log("Server is listening!");
});


// MARK: Sockets

const io = new Server(server);
instructorChangeBuffer.initSocket(io);

// io.listen(3000);
// All lecture-scoped broadcasts are sent only to sockets that have joined this room,
// so concurrent lectures on the same server don't see each other's traffic.
function lectureRoom(sessionId) {
  return `lecture-${sessionId}`;
}

io.on("connection", async (socket) => {
  console.log("a user connected");

  socket.on(SOCKET_MESSAGE_TYPE.JOIN_SESSION, (sessionId) => {
    socket.join(lectureRoom(sessionId));
  });

  socket.on(SOCKET_MESSAGE_TYPE.INSTRUCTOR_CURSOR, (msg) => {
    io.to(lectureRoom(msg.sessionId ?? msg.sessionNumber)).emit(SOCKET_MESSAGE_TYPE.INSTRUCTOR_CURSOR, msg);
  });

  socket.on(SOCKET_MESSAGE_TYPE.INSTRUCTOR_EDIT, async (msg) => {
    // Forward proactively!
    io.to(lectureRoom(msg.sessionId ?? msg.sessionNumber)).emit(SOCKET_MESSAGE_TYPE.INSTRUCTOR_EDIT, msg);
    // FIXME: these might not get executed in order!

    instructorChangeBuffer.enqueue(msg);
  });

  // Forward info about code runs.
  socket.on(SOCKET_MESSAGE_TYPE.INSTRUCTOR_CODE_RUN, (msg) => {
    io.to(lectureRoom(msg.sessionId ?? msg.sessionNumber)).emit(SOCKET_MESSAGE_TYPE.INSTRUCTOR_CODE_RUN, msg);
  });

  // Exercises
  socket.on(SOCKET_MESSAGE_TYPE.EXERCISE_CREATED, (msg) => {
    io.to(lectureRoom(msg.sessionId ?? msg.sessionNumber)).emit(SOCKET_MESSAGE_TYPE.EXERCISE_CREATED, msg);
  });

  socket.on(SOCKET_MESSAGE_TYPE.EXERCISE_FINISHED, (msg) => {
    io.to(lectureRoom(msg.sessionId ?? msg.sessionNumber)).emit(SOCKET_MESSAGE_TYPE.EXERCISE_FINISHED, msg);
  });

  socket.on(SOCKET_MESSAGE_TYPE.STUDENT_SUBMITTED, (msg) => {
    io.to(lectureRoom(msg.sessionId ?? msg.sessionNumber)).emit(SOCKET_MESSAGE_TYPE.STUDENT_SUBMITTED, msg);
  });

  socket.on(SOCKET_MESSAGE_TYPE.VERSION_BLOCK_CREATED, (msg) => {
    io.to(lectureRoom(msg.sessionId ?? msg.sessionNumber)).emit(SOCKET_MESSAGE_TYPE.VERSION_BLOCK_CREATED, msg);
  });

  socket.on(SOCKET_MESSAGE_TYPE.VARIANT_ADDED, (msg) => {
    io.to(lectureRoom(msg.sessionId ?? msg.sessionNumber)).emit(SOCKET_MESSAGE_TYPE.VARIANT_ADDED, msg);
  });

  socket.on(SOCKET_MESSAGE_TYPE.VARIANT_RENAMED, (msg) => {
    io.to(lectureRoom(msg.sessionId ?? msg.sessionNumber)).emit(SOCKET_MESSAGE_TYPE.VARIANT_RENAMED, msg);
  });

  socket.on(SOCKET_MESSAGE_TYPE.VARIANT_DELETED, (msg) => {
    io.to(lectureRoom(msg.sessionId ?? msg.sessionNumber)).emit(SOCKET_MESSAGE_TYPE.VARIANT_DELETED, msg);
  });

  socket.on(SOCKET_MESSAGE_TYPE.VERSION_BLOCK_DELETED, (msg) => {
    io.to(lectureRoom(msg.sessionId ?? msg.sessionNumber)).emit(SOCKET_MESSAGE_TYPE.VERSION_BLOCK_DELETED, msg);
  });

  socket.on(SOCKET_MESSAGE_TYPE.VARIANT_EDIT, (msg) => {
    io.to(lectureRoom(msg.sessionId ?? msg.sessionNumber)).emit(SOCKET_MESSAGE_TYPE.VARIANT_EDIT, msg);
    instructorChangeBuffer.enqueueVariant(msg);
  });

  socket.on(SOCKET_MESSAGE_TYPE.VARIANT_CURSOR, (msg) => {
    io.to(lectureRoom(msg.sessionId ?? msg.sessionNumber)).emit(SOCKET_MESSAGE_TYPE.VARIANT_CURSOR, msg);
  });

  // Forward/push this so the students stop writing.
  socket.on(SOCKET_MESSAGE_TYPE.INSTRUCTOR_END_SESSION, async (msg) => {
    // Forward immediately
    io.to(lectureRoom(msg.sessionNumber)).emit(SOCKET_MESSAGE_TYPE.INSTRUCTOR_END_SESSION, msg);

    try {
      await db.transaction(async (t) => {
        let lecture = await LectureSession.findByPk(msg.sessionNumber);
        lecture &&
          (await lecture.update({ isFinished: true }, { transaction: t }));
      });
    } catch (error) {
      console.error("failed to close session: ", error);
    }
  });
});

ViteExpress.bind(app, server);
