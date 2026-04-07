import "dotenv/config";
import express from "express";
import ViteExpress from "vite-express";
import * as http from "http";
import { Server } from "socket.io";
import { db } from "./database.js";
import {
  LectureSession,
  ClassExercise,
  ExerciseResponse,
  StudentSession,
} from "./models.js";
import { CLIENT_TYPE, SOCKET_MESSAGE_TYPE } from "../shared-constants.js";
import { ChangeBuffer } from "./change-buffer.js";

const app = express();
app.use(express.json({ limit: "50mb" }));

let instructorChangeBuffer = new ChangeBuffer(5000, db);
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
  res.json({error: "Not implemented"});
});

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
          { name: sessionName, instructor_id: userId },
          { transaction: t },
        ));
      if (sesh.instructor_id !== userId) {
        return {
          error: "Lecture name not available.",
        };
      }

      let { doc, docVersion } = await sesh.getDoc(t);
      let exercises = await sesh.getExercisesForInstructor(t);
      return {
        doc: doc.toJSON(),
        docVersion,
        sessionNumber: sesh.id,
        exercises,
      };
    });
    res.json(response);
  } catch (error) {
    console.error("Error getting or creating new lecture:", error);
    res.json({ error: error.message });
  }
});

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

// Get or create a StudentSession for student-page.html.
// Returns info about:
//   1) the instructor's code (doc/version)
//   2) the student's playground code (doc/version)
//   3) all exercises for this lecture, with this student's response for each
//   4) the session number and student session id
app.post("/current-session-student", async (req, res) => {
  let { student_id, student_identifier, sessionName } = req.body;
  if (!student_id || !student_identifier) {
    return res.json({
      error: "student_id and student_identifier are required",
    });
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

      return {
        sessionNumber: lecture.id,
        studentSessionId: sesh.id,
        lectureDoc,
        lectureDocVersion,
        exercises,
      };
    });
    res.json(response);
  } catch (error) {
    console.error("Failed to get or create student session:", error);
    res.json({ error: error.message });
  }
});

app.post("/record-playground-changes", async (req, res) => {
  return res.json({error: "no longer supported"});
});

app.post("/record-user-action", async (req, res) => {
  let {
    ts,
    docVersion,
    codeVersion,
    actionType,
    sessionNumber,
    source,
    email,
    details,
    userId,
  } = req.body;
  if (!source) return;

  try {
    let response = await db.transaction(async (t) => {
      let lecture = await LectureSession.findByPk(sessionNumber, {
        transaction: t,
      });
      if (!lecture)
        throw new Error(
          `Can't record user action for non-existing session #${sessionNumber}`,
        );

      const record = {
        action_ts: ts,
        code_version: codeVersion,
        doc_version: docVersion,
        action_type: actionType,
        details,
      };

      if (source === CLIENT_TYPE.INSTRUCTOR) {
        if (lecture.instructor_id !== userId) {
          throw new Error(
            "Unauthorized: user ID does not match session instructor",
          );
        }
        await lecture.createInstructorAction(record, { transaction: t });
      } else {
        throw new Error(`User action with unknown source: ${source}`);
      }
      return { success: true };
    });
    res.json(response);
  } catch (error) {
    console.error("Failed to log user action", error);
    return { error: error.message };
  }
});

// Create a new exercise for a lecture session.
app.post("/exercise", async (req, res) => {
  const { lectureId, type, instructions } = req.body;
  if (!lectureId || !type)
    return res.json({ error: "lectureId and type are required" });

  try {
    let response = await db.transaction(async (t) => {
      let lecture = await LectureSession.findByPk(lectureId, {
        transaction: t,
      });
      if (!lecture) return { error: `Session #${lectureId} not found` };
      let exercise = await ClassExercise.createForLecture(
        lectureId,
        { type, instructions },
        t,
      );
      return { exerciseId: exercise.id };
    });
    res.json(response);
  } catch (error) {
    console.error("Failed to create exercise:", error);
    res.json({ error: error.message });
  }
});

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
      let record = await ExerciseResponse.submitOrUpdate(
        exerciseId,
        { student_id, answer },
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

const server = http.createServer(app).listen(3000, () => {
  console.log("Server is listening!");
});

const io = new Server(server);
instructorChangeBuffer.initSocket(io);

// io.listen(3000);
io.on("connection", async (socket) => {
  console.log("a user connected");

  socket.on(SOCKET_MESSAGE_TYPE.INSTRUCTOR_CURSOR, (msg) => {
    io.emit(SOCKET_MESSAGE_TYPE.INSTRUCTOR_CURSOR, msg);
  });

  socket.on(SOCKET_MESSAGE_TYPE.INSTRUCTOR_EDIT, async (msg) => {
    // Forward proactively!
    io.emit(SOCKET_MESSAGE_TYPE.INSTRUCTOR_EDIT, msg);
    // FIXME: these might not get executed in order!

    instructorChangeBuffer.enqueue(msg);
  });

  // Forward info about code runs.
  socket.on(SOCKET_MESSAGE_TYPE.INSTRUCTOR_CODE_RUN, (msg) => {
    io.emit(SOCKET_MESSAGE_TYPE.INSTRUCTOR_CODE_RUN, msg);
  });

  // Exercises
  socket.on(SOCKET_MESSAGE_TYPE.EXERCISE_CREATED, (msg) => {
    io.emit(SOCKET_MESSAGE_TYPE.EXERCISE_CREATED, msg);
  });

  socket.on(SOCKET_MESSAGE_TYPE.EXERCISE_FINISHED, (msg) => {
    io.emit(SOCKET_MESSAGE_TYPE.EXERCISE_FINISHED, msg);
  });

  socket.on(SOCKET_MESSAGE_TYPE.STUDENT_SUBMITTED, (msg) => {
    io.emit(SOCKET_MESSAGE_TYPE.STUDENT_SUBMITTED, msg);
  });

  // Forward/push this so the students stop writing.
  socket.on(SOCKET_MESSAGE_TYPE.INSTRUCTOR_END_SESSION, async (msg) => {
    // Forward immediately
    io.emit(SOCKET_MESSAGE_TYPE.INSTRUCTOR_END_SESSION, msg);

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
