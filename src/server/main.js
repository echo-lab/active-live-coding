import "dotenv/config";
import express from "express";
import ViteExpress from "vite-express";
import * as http from "http";
import { randomUUID } from "node:crypto";
import { Server } from "socket.io";
import { Sequelize } from "sequelize";
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
  Document,
  DEFAULT_FILE_NAME,
} from "./models.js";
import { createSimulatedResponses } from "./simulate-responses.js";
import { suggestMcqChoices } from "./suggest-mcq-choices.js";
import { createGroupSummary } from "./group-responses.js";
import { SOCKET_MESSAGE_TYPE, validateFilePath, isPathUnder } from "../shared-constants.js";
import { eventsDb } from "./events-database.js";
import { EventBuffer } from "./event-buffer.js";
import {
  initDocStore,
  lectureRoom,
  applyChange,
  applyVariantChange,
  createDocument,
  getDocSnapshot,
  getAnchors,
  setContent,
  flushDoc,
  flushAll,
  flushLecture,
  evictLecture,
  evictDoc,
  registerVersionBlockAnchor,
  registerPollAnchor,
  unregisterVersionBlockAnchor,
  resolveVariantDoc,
} from "./doc-store.js";
import { registerAdminRoutes } from "./admin-routes.js";

const app = express();

// MARK: Cross-origin isolation
// Required so the client can use SharedArrayBuffer + Atomics.wait/notify to implement blocking
// Python input() inside the Pyodide web worker. require-corp (not the newer credentialless mode)
// is used because jsdelivr -- the only cross-origin resource this app loads (Pyodide's runtime,
// wasm, and packages) -- already sends Cross-Origin-Resource-Policy: cross-origin, and
// credentialless has no Safari support at all while require-corp works from Safari 15.2+.
app.use((req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  next();
});

// MARK: Dev-only admin gate
// Blocks the dev-only lecture-list/replay pages and their API, for offline analysis of past
// lectures, from ever being reachable in production -- registered first (before body-parsing,
// before any route) so it always runs regardless of where the routes themselves are defined.
// Uses the same NODE_ENV check vite-express itself uses to decide dev vs. prod serving, so this
// gate can never disagree with which mode is actually serving pages.
const ADMIN_PATH_PREFIXES = ["/pages/admin", "/api/admin"];
app.use(ADMIN_PATH_PREFIXES, (req, res, next) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(403).json({ error: "Not available in production" });
  }
  next();
});

app.use(express.json({ limit: "50mb" }));

let eventBuffer = new EventBuffer(30000);
let flushEvents = async () => {
  try {
    await eventBuffer.flush();
    return true;
  } catch (error) {
    console.error("Error flushing events:", error);
    return false;
  }
};

registerAdminRoutes(app, { flushLecture, flushEvents });

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

  try {
    let response = await db.transaction(async (t) => {
      let sesh = await LectureSession.current(sessionName, t);
      if (!sesh) {
        sesh = await LectureSession.create(
          { name: sessionName, instructor_id: userId, uuid: randomUUID() },
          { transaction: t },
        );
        // Every lecture starts with one file. (Multiple files are supported by the data model;
        // the front end doesn't create any others yet.)
        await createDocument({ lectureId: sesh.id, kind: "file", name: DEFAULT_FILE_NAME }, t);
      }
      if (sesh.instructor_id !== userId) {
        return {
          error: "Lecture name not available.",
        };
      }
      return sesh;
    });
    if (response.error) return res.json(response);

    // Reads go through the doc store (in memory), outside the write transaction above -- the new
    // file row must be committed before the doc store can hydrate it.
    const sesh = response;
    response = await db.transaction({ type: Sequelize.Transaction.TYPES.DEFERRED }, async (t) => {
      let files = await sesh.getFilesWithContent(t);
      let exercises = await sesh.getExercisesForInstructor(t);
      let versionBlocks = await sesh.getVersionBlocksWithPositions(t);
      return {
        files,
        sessionNumber: sesh.id,
        uuid: sesh.uuid,
        exercises,
        versionBlocks,
        instructorView: instructorViews.get(sesh.id) ?? null,
      };
    });
    res.json(response);
  } catch (error) {
    console.error("Error getting or creating new lecture:", error);
    res.json({ error: error.message });
  }
});

// MARK: Get latest doc
// Catch-up for clients that fell behind (missed a socket message): just the latest content, plus
// (for files) the current version-block positions. Served from memory -- see doc-store.js.
app.get("/doc/:docId", async (req, res) => {
  const docId = parseInt(req.params.docId);
  if (isNaN(docId)) return res.json({ error: `invalid doc id: ${req.params.docId}` });
  try {
    const { text, version, persistedVersion } = await getDocSnapshot(docId);
    const { versionBlocks } = await getAnchors(docId);
    res.json({
      docId,
      doc: text.toJSON(),
      docVersion: version,
      persistedVersion,
      versionBlocks: [...versionBlocks].map(([id, pos]) => ({ id, from: pos, to: pos })),
    });
  } catch (error) {
    console.error("Error retrieving doc: ", error);
    res.json({ error: error.message });
  }
});

// MARK: Create version block
app.post("/version-block", async (req, res) => {
  const { lectureId, fileId, anchor_pos, docVersion, variantCode } = req.body;
  if (lectureId == null || fileId == null || anchor_pos == null || docVersion == null || variantCode == null) {
    return res.json({ error: "lectureId, fileId, anchor_pos, docVersion, and variantCode are required" });
  }

  try {
    let response = await db.transaction(async (t) => {
      const file = await Document.findOne({ where: { id: fileId, LectureSessionId: lectureId, kind: "file" }, transaction: t });
      if (!file) return { error: `File #${fileId} not found in session #${lectureId}` };
      const block = await VersionBlock.create(
        { LectureSessionId: lectureId, DocumentId: fileId, anchor_pos, anchor_change_number: docVersion },
        { transaction: t },
      );
      const variant = await Variant.create({ VersionBlockId: block.id, name: "v0" }, { transaction: t });
      await createDocument({ lectureId, kind: "variant", variantId: variant.id, initialContent: variantCode }, t);
      return { versionBlockId: block.id, variantId: variant.id };
    });
    if (!response.error) {
      // Start tracking its live position, and persist that right away so the block can never
      // exist in the DB without a tracked anchor in its file's snapshot.
      await registerVersionBlockAnchor(fileId, response.versionBlockId, anchor_pos, docVersion);
      await flushDoc(fileId);
    }
    res.json(response);
  } catch (error) {
    console.error("Failed to create version block:", error);
    res.json({ error: error.message });
  }
});

// MARK: VersionBlock delete

// Body (all captured by the instructor client right before dissolving, i.e. before its
// flatten-insert edit): {doc, pos, docVersion} -- the file's text, the widget's position in it,
// and the file's version. Stored so the "historical view" can show the block exactly as it looked
// right before deletion without replaying any history.
app.delete("/version-block/:id", async (req, res) => {
  const { doc, pos, docVersion } = req.body ?? {};

  try {
    const result = await db.transaction(async (t) => {
      const block = await VersionBlock.findByPk(req.params.id, { transaction: t });
      if (!block) return { error: "Not found" };

      const deleted_change_number = docVersion ?? (await getDocSnapshot(block.DocumentId)).version;
      await block.update(
        { deleted: true, deleted_change_number, deleted_doc: doc ?? null, deleted_pos: pos ?? null },
        { transaction: t },
      );

      // Dissolving a still-active exercise should behave like finishing it (minus the
      // summary step) so it doesn't linger as "Active" in the activities panel.
      const exercise = await block.getClassExercise({ transaction: t });
      let finishedExerciseId = null;
      if (exercise && exercise.end_ts === null) {
        await exercise.finish(t);
        finishedExerciseId = exercise.id;
      }

      return { ok: true, finishedExerciseId, fileId: block.DocumentId, blockId: block.id };
    });
    if (result.ok) await unregisterVersionBlockAnchor(result.fileId, result.blockId);
    res.json(result);
  } catch (err) {
    console.error("Failed to soft-delete version block:", err);
    res.status(500).json({ error: err.message });
  }
});

// MARK: File CRUD
// Only the lecture's instructor can create/rename/delete files. Each route broadcasts its result to
// the lecture room itself (rather than the client relaying it), since only the server knows the
// new rows' ids. Paths are stored flat ("dir/name.py"); directories only exist implicitly.

// Lectures in which the latest INSTRUCTOR_VIEW_STATE is remembered: lectureId -> {openFileIds,
// activeFileId}. In memory only -- it just picks which tabs a (re)joining client starts on.
const instructorViews = new Map();

async function getInstructorLecture(lectureId, userId, transaction) {
  const lecture = await LectureSession.findByPk(lectureId, { transaction });
  if (!lecture) return { error: `Session #${lectureId} not found` };
  if (!userId || lecture.instructor_id !== userId) return { error: "Unauthorized" };
  if (lecture.isFinished) return { error: "This lecture has ended" };
  return { lecture };
}

function liveFiles(lectureId, transaction) {
  return Document.findAll({
    where: { LectureSessionId: lectureId, kind: "file", deleted_at: null },
    order: [["id", "ASC"]],
    transaction,
  });
}

// The files a create/rename/delete request refers to: either the one file at `path`, or (for a
// directory) every file under it.
function matchFiles(files, path, isDirectory) {
  return isDirectory ? files.filter((f) => isPathUnder(f.name, path)) : files.filter((f) => f.name === path);
}

app.post("/file", async (req, res) => {
  const { lectureId, userId, path } = req.body;
  const invalid = validateFilePath(path);
  if (invalid) return res.json({ error: invalid });
  try {
    const response = await db.transaction(async (t) => {
      const { error } = await getInstructorLecture(lectureId, userId, t);
      if (error) return { error };
      const files = await liveFiles(lectureId, t);
      if (files.some((f) => f.name === path)) return { error: `${path} already exists` };
      // A file can't share its path with a directory (i.e. be a prefix of another file's path).
      if (files.some((f) => isPathUnder(f.name, path) || isPathUnder(path, f.name))) {
        return { error: `${path} conflicts with an existing file or folder` };
      }
      const doc = await createDocument({ lectureId, kind: "file", name: path }, t);
      return { file: { id: doc.id, name: doc.name, doc: [""], docVersion: 0, persistedVersion: 0 } };
    });
    if (response.file) io.to(lectureRoom(lectureId)).emit(SOCKET_MESSAGE_TYPE.FILE_CREATED, response);
    res.json(response);
  } catch (error) {
    console.error("Failed to create file:", error);
    res.json({ error: error.message });
  }
});

app.post("/files/rename", async (req, res) => {
  const { lectureId, userId, from, to, isDirectory = false } = req.body;
  const invalid = validateFilePath(to, { isDirectory });
  if (invalid) return res.json({ error: invalid });
  if (from === to) return res.json({ renames: [] });
  try {
    const response = await db.transaction(async (t) => {
      const { error } = await getInstructorLecture(lectureId, userId, t);
      if (error) return { error };
      const files = await liveFiles(lectureId, t);
      const moving = matchFiles(files, from, isDirectory);
      if (moving.length === 0) return { error: `${from} not found` };
      if (isDirectory && isPathUnder(to, from)) return { error: "Can't move a folder into itself" };

      const movingIds = new Set(moving.map((f) => f.id));
      const others = files.filter((f) => !movingIds.has(f.id));
      const renames = moving.map((f) => ({ id: f.id, name: isDirectory ? to + f.name.slice(from.length) : to }));
      for (const { name } of renames) {
        if (others.some((o) => isPathUnder(o.name, name) || isPathUnder(name, o.name))) {
          return { error: `${name} conflicts with an existing file or folder` };
        }
      }

      const ts = Date.now();
      for (const f of moving) {
        const name = renames.find((r) => r.id === f.id).name;
        const history = JSON.parse(f.name_history ?? "[]");
        history.push({ name, ts });
        await f.update({ name, name_history: JSON.stringify(history) }, { transaction: t });
      }
      return { renames };
    });
    if (response.renames?.length) io.to(lectureRoom(lectureId)).emit(SOCKET_MESSAGE_TYPE.FILES_RENAMED, response);
    res.json(response);
  } catch (error) {
    console.error("Failed to rename file(s):", error);
    res.json({ error: error.message });
  }
});

// Soft-deletes the file (or every file under a directory). Any live Version Block in those files
// is dissolved the same way DELETE /version-block does it -- snapshotting the file so its
// historical view still works -- and its still-active exercise is finished. Polls anchored in a
// deleted file just lose their anchor (see LectureSession._resolvePollAnchors).
app.post("/files/delete", async (req, res) => {
  const { lectureId, userId, path, isDirectory = false } = req.body;
  if (!path) return res.json({ error: "path is required" });
  try {
    // Snapshot the doomed files from the doc store (in memory) before the write transaction.
    const auth = await getInstructorLecture(lectureId, userId);
    if (auth.error) return res.json(auth);
    const files = await liveFiles(lectureId);
    const doomed = matchFiles(files, path, isDirectory);
    if (doomed.length === 0) return res.json({ error: `${path} not found` });
    if (doomed.length === files.length) return res.json({ error: "A lecture must keep at least one file" });

    const snapshots = new Map();
    for (const f of doomed) {
      const { text, version } = await getDocSnapshot(f.id);
      const { versionBlocks } = await getAnchors(f.id);
      snapshots.set(f.id, { doc: text.toString(), version, versionBlocks });
    }

    const fileIds = doomed.map((f) => f.id);
    const response = await db.transaction(async (t) => {
      const now = new Date();
      await Document.update({ deleted_at: now }, { where: { id: fileIds }, transaction: t });

      const blocks = await VersionBlock.findAll({ where: { DocumentId: fileIds, deleted: false }, transaction: t });
      const finishedExerciseIds = [];
      for (const block of blocks) {
        const snap = snapshots.get(block.DocumentId);
        await block.update(
          {
            deleted: true,
            deleted_change_number: snap.version,
            deleted_doc: snap.doc,
            deleted_pos: snap.versionBlocks.get(block.id) ?? block.anchor_pos,
          },
          { transaction: t },
        );
        const exercise = await block.getClassExercise({ transaction: t });
        if (exercise && exercise.end_ts === null) {
          await exercise.finish(t);
          finishedExerciseIds.push(exercise.id);
        }
      }
      return { fileIds, versionBlockIds: blocks.map((b) => b.id), finishedExerciseIds };
    });

    // Persist any last edits, then stop holding the files in memory -- they can't be edited any more.
    await Promise.all(fileIds.map((id) => evictDoc(id)));
    io.to(lectureRoom(lectureId)).emit(SOCKET_MESSAGE_TYPE.FILES_DELETED, response);
    res.json(response);
  } catch (error) {
    console.error("Failed to delete file(s):", error);
    res.json({ error: error.message });
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
      const doc = await createDocument(
        { lectureId: block.LectureSessionId, kind: "variant", variantId: variant.id, initialContent: "" },
        t,
      );
      return { variantId: variant.id, docId: doc.id, name, docVersion: doc.version };
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
      // Soft delete (paranoid) -- the Variant row, its Document, and its change log are all kept
      // so the variant's whole lifetime can be replayed later.
      await variant.destroy({ transaction: t });
      return { ok: true };
    });
    if (result.ok) {
      // Persist any last edits, then stop holding it in memory -- it can't be edited any more.
      await evictDoc(await resolveVariantDoc(req.params.id));
    }
    res.json(result);
  } catch (error) {
    res.json({ error: error.message });
  }
});

// Server-side full replace of a variant's code (e.g. seeding a new variant with a student's answer).
app.put("/variant/:id/code", async (req, res) => {
  const { code } = req.body;
  if (code == null) return res.json({ error: "code is required" });
  try {
    const variant = await Variant.findByPk(req.params.id);
    if (!variant) return res.json({ error: "Variant not found" });
    const docVersion = await setContent(await resolveVariantDoc(variant.id), code);
    res.json({ ok: true, docVersion });
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

  try {
    // Cheap read-only pre-check, no transaction -- lets the common case (a student reloading,
    // who already has a StudentSession) skip the IMMEDIATE write-lock entirely below. This is
    // purely an optimization hint, not relied on for correctness: the "first join" branch still
    // does its own atomic check-then-create inside a real transaction.
    let lecture = await LectureSession.current(sessionName);
    if (!lecture) return res.json({});

    let existing = await lecture.getStudentSessions({ where: { student_id } });

    let response;
    if (existing.length > 0) {
      // Fast path: this branch is guaranteed to never write, so DEFERRED is safe here -- it can
      // never hit the SHARED->RESERVED lock-upgrade race that IMMEDIATE exists to avoid.
      let sesh = existing[0];
      response = await db.transaction({ type: Sequelize.Transaction.TYPES.DEFERRED }, async (t) => {
        let files = await lecture.getFilesWithContent(t);
        let exercises = await lecture.getExercisesForStudent(student_id, t);
        let versionBlocks = await lecture.getVersionBlocksWithPositions(t);
        return {
          sessionNumber: lecture.id,
          studentSessionId: sesh.id,
          files,
          exercises,
          versionBlocks,
          instructorView: instructorViews.get(lecture.id) ?? null,
        };
      });
    } else {
      // Slow-but-safe path: first-ever join for this student, may need to INSERT a
      // StudentSession. Unchanged from before this fix: default IMMEDIATE, atomic
      // check-then-create, so two genuinely-concurrent first joins for the same student are
      // still safely serialized.
      response = await db.transaction(async (t) => {
        let existingInner = await lecture.getStudentSessions({ where: { student_id }, transaction: t });
        let sesh =
          existingInner.length > 0
            ? existingInner[0]
            : await lecture.createStudentSession({ student_id, student_identifier }, { transaction: t });

        return { sesh };
      });
      // Doc-store reads happen after the write transaction commits (see /lecture-session).
      const sesh = response.sesh;
      response = await db.transaction({ type: Sequelize.Transaction.TYPES.DEFERRED }, async (t) => {
        let files = await lecture.getFilesWithContent(t);
        let exercises = await lecture.getExercisesForStudent(student_id, t);
        let versionBlocks = await lecture.getVersionBlocksWithPositions(t);

        return {
          sessionNumber: lecture.id,
          studentSessionId: sesh.id,
          files,
          exercises,
          versionBlocks,
          instructorView: instructorViews.get(lecture.id) ?? null,
        };
      });
    }
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

  try {
    const response = await db.transaction({ type: Sequelize.Transaction.TYPES.DEFERRED }, async (t) => {
      const lecture = await LectureSession.findOne({ where: { uuid: id }, transaction: t });
      if (!lecture) return { error: "Lecture not found" };

      const files = await lecture.getFilesWithContent(t);
      const exercises = await lecture.getExercisesForStudent(studentId ?? "", t);
      const versionBlocks = await lecture.getVersionBlocksWithPositions(t);

      return {
        name: lecture.name,
        isFinished: lecture.isFinished,
        sessionNumber: lecture.id,
        files,
        exercises,
        versionBlocks,
        // Only known while the lecture is live (cleared when it ends); otherwise the review page
        // opens the main file.
        instructorView: instructorViews.get(lecture.id) ?? null,
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
    if (!lecture) {
      console.warn(
        `Survey response from student ${student_id} has no resolvable lectureId (got: ${lectureId}) -- saving with LectureSessionId: null`
      );
    }
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
    fileId,
    context_doc,
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
          document_id: code_anchor_from != null ? fileId ?? null : null,
          context_doc: code_anchor_from != null ? context_doc ?? null : null,
        },
        t,
      );
      return { exerciseId: exercise.id, exercise };
    });
    const ex = response.exercise;
    if (ex?.DocumentId != null && ex.code_anchor_from != null) {
      await registerPollAnchor(ex.DocumentId, ex.id, ex.code_anchor_from, ex.code_anchor_to, ex.code_anchor_doc_version);
      await flushDoc(ex.DocumentId);
    }

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

const PORT = Number(process.env.PORT ?? 3000);
const server = http.createServer(app).listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}!`);
});


// MARK: Sockets

const io = new Server(server);
initDocStore(io);

// Flush unpersisted edits before exiting. SIGUSR2 is what nodemon sends on every dev restart --
// without this, each restart would lose up to FLUSH_INTERVAL_MS of edits.
// NOTE: deliberately process.on (not .once) until the flush is done: a dependency installs a
// `signal-exit` listener that re-raises the signal (killing us mid-flush) if, when the signal
// arrives, it's the only listener left -- and .once removes ours before calling it.
for (const signal of ["SIGINT", "SIGTERM", "SIGUSR2"]) {
  let shuttingDown = false;
  const onSignal = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal}: flushing documents and events before exit...`);
    try {
      await Promise.all([flushAll(), flushEvents()]);
    } catch (error) {
      console.error("Final flush failed:", error);
    }
    process.removeListener(signal, onSignal);
    process.kill(process.pid, signal);
  };
  process.on(signal, onSignal);
}

// All lecture-scoped broadcasts are sent only to sockets that have joined this room (lectureRoom,
// from doc-store.js), so concurrent lectures on the same server don't see each other's traffic.

io.on("connection", async (socket) => {
  console.log("a user connected");

  socket.on(SOCKET_MESSAGE_TYPE.JOIN_SESSION, (sessionId) => {
    socket.join(lectureRoom(sessionId));
  });

  socket.on(SOCKET_MESSAGE_TYPE.INSTRUCTOR_CURSOR, (msg) => {
    io.to(lectureRoom(msg.sessionId ?? msg.sessionNumber)).emit(SOCKET_MESSAGE_TYPE.INSTRUCTOR_CURSOR, msg);
  });

  // msg: {sessionId, fileId, id, changes, ts}
  socket.on(SOCKET_MESSAGE_TYPE.INSTRUCTOR_EDIT, (msg) => {
    // Forward proactively!
    io.to(lectureRoom(msg.sessionId ?? msg.sessionNumber)).emit(SOCKET_MESSAGE_TYPE.INSTRUCTOR_EDIT, msg);
    if (msg.fileId == null) {
      console.warn("INSTRUCTOR_EDIT without a fileId -- dropping:", msg.id);
      return;
    }
    // Synchronous (no await) so edits are applied in exactly the order they arrived.
    applyChange(msg.fileId, msg);
  });

  // msg: {sessionId, openFileIds, activeFileId}
  socket.on(SOCKET_MESSAGE_TYPE.INSTRUCTOR_VIEW_STATE, (msg) => {
    const sessionId = Number(msg.sessionId);
    instructorViews.set(sessionId, { openFileIds: msg.openFileIds ?? [], activeFileId: msg.activeFileId ?? null });
    socket.to(lectureRoom(sessionId)).emit(SOCKET_MESSAGE_TYPE.INSTRUCTOR_VIEW_STATE, msg);
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
    applyVariantChange(msg.variantId, msg);
  });

  socket.on(SOCKET_MESSAGE_TYPE.VARIANT_CURSOR, (msg) => {
    io.to(lectureRoom(msg.sessionId ?? msg.sessionNumber)).emit(SOCKET_MESSAGE_TYPE.VARIANT_CURSOR, msg);
  });

  // Forward/push this so the students stop writing.
  socket.on(SOCKET_MESSAGE_TYPE.INSTRUCTOR_END_SESSION, async (msg) => {
    // Forward immediately
    io.to(lectureRoom(msg.sessionNumber)).emit(SOCKET_MESSAGE_TYPE.INSTRUCTOR_END_SESSION, msg);
    instructorViews.delete(Number(msg.sessionNumber));
    // A finished lecture won't be edited again -- persist everything, then drop it from memory
    // (it'll cheaply re-hydrate from its snapshot if it's ever read again, e.g. the review page).
    await evictLecture(msg.sessionNumber);

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
