import { SOCKET_MESSAGE_TYPE } from "../shared-constants.js";
import { POST_JSON_REQUEST, shouldSimulateResponses } from "./utils.js";

// MARK: Instrutor
export class InstructorActivitiesManager extends EventTarget {
  constructor({ sessionNumber, userId, socket, exercises }) {
    super();
    this.sessionNumber = sessionNumber;
    this.userId = userId;
    this.socket = socket;
    this.exercises = exercises.map((ex) => ({
      ...ex,
      ExerciseResponses: [
        ...(ex.ExerciseResponses ?? []),
        ...(ex.SimulatedExerciseResponses ?? []).map((r) => ({
          id: r.id,
          student_id: r.student_name,
          student_identifier: r.student_name,
          StudentSession: null,
          answer: r.answer,
          isSimulated: true,
        })),
      ],
    }));

    socket.on(SOCKET_MESSAGE_TYPE.STUDENT_SUBMITTED, (msg) => {
      this.#handleStudentSubmitted(msg);
    });
  }

  getActiveExercises() {
    if (!this.exercises) return [];
    return this.exercises.filter((e) => e.end_ts === null);
  }

  getExercise(id) {
    return this.exercises.find((e) => e.id === id);
  }

  getExerciseForVersionBlock(versionBlockId) {
    return this.exercises.find((e) => e.VersionBlockId === versionBlockId) ?? null;
  }

  getExercises() {
    return this.exercises;
  }

  async createPollExercise({ instructions, instructor_code, full_instructor_code }) {
    const res = await fetch("/exercise", {
      body: JSON.stringify({
        lectureId: this.sessionNumber,
        type: "POLL",
        instructions,
        ...(instructor_code ? { instructor_code } : {}),
      }),
      ...POST_JSON_REQUEST,
    }).then((r) => r.json());
    if (res.error) { alert(res.error); return; }

    this.#maybeSimulateResponses(res.exerciseId, full_instructor_code);

    const newEx = {
      id: res.exerciseId,
      type: "POLL",
      instructions,
      instructor_code: instructor_code ?? null,
      start_ts: Date.now(),
      end_ts: null,
      ExerciseResponses: [],
    };
    this.exercises.push(newEx);
    this.socket.emit(SOCKET_MESSAGE_TYPE.EXERCISE_CREATED, {
      sessionNumber: this.sessionNumber,
      exercise: {
        id: newEx.id,
        instructions: newEx.instructions,
        start_ts: newEx.start_ts,
        type: newEx.type,
      },
    });
    this.dispatchEvent(new CustomEvent("exerciseCreated", { detail: { exercise: newEx } }));
  }

  async createPollMcqExercise({ instructions, instructor_code, full_instructor_code, choices }) {
    const default_answer = JSON.stringify(choices);
    const res = await fetch("/exercise", {
      body: JSON.stringify({
        lectureId: this.sessionNumber,
        type: "POLL_MCQ",
        instructions,
        default_answer,
        ...(instructor_code ? { instructor_code } : {}),
      }),
      ...POST_JSON_REQUEST,
    }).then((r) => r.json());
    if (res.error) { alert(res.error); return; }

    this.#maybeSimulateResponses(res.exerciseId, full_instructor_code);

    const newEx = {
      id: res.exerciseId,
      type: "POLL_MCQ",
      instructions,
      instructor_code: instructor_code ?? null,
      default_answer,
      start_ts: Date.now(),
      end_ts: null,
      ExerciseResponses: [],
    };
    this.exercises.push(newEx);
    this.socket.emit(SOCKET_MESSAGE_TYPE.EXERCISE_CREATED, {
      sessionNumber: this.sessionNumber,
      exercise: {
        id: newEx.id,
        instructions: newEx.instructions,
        start_ts: newEx.start_ts,
        type: newEx.type,
      },
    });
    this.dispatchEvent(new CustomEvent("exerciseCreated", { detail: { exercise: newEx } }));
  }

  async suggestMcqChoices({ instructions, instructor_code, full_instructor_code }) {
    const res = await fetch("/suggest-mcq-choices", {
      body: JSON.stringify({ instructorId: this.userId, instructions, instructor_code, full_instructor_code }),
      ...POST_JSON_REQUEST,
    }).then((r) => r.json());
    if (res.error) { alert(res.error); return []; }
    return res.choices ?? [];
  }

  async createCodeVariantExercise({ default_answer, instructor_code, versionBlockId }) {
    if (this.exercises.some((e) => e.VersionBlockId === versionBlockId)) {
      alert("This version block already has an exercise.");
      return null;
    }
    const res = await fetch("/exercise", {
      body: JSON.stringify({
        lectureId: this.sessionNumber,
        type: "CODE_VARIANT",
        default_answer,
        instructor_code,
        version_block_id: versionBlockId,
      }),
      ...POST_JSON_REQUEST,
    }).then((r) => r.json());
    if (res.error) { alert(res.error); return null; }

    this.#maybeSimulateResponses(res.exerciseId);

    const newEx = {
      id: res.exerciseId,
      type: "CODE_VARIANT",
      default_answer,
      VersionBlockId: versionBlockId,
      start_ts: Date.now(),
      end_ts: null,
      ExerciseResponses: [],
    };
    this.exercises.push(newEx);
    this.socket.emit(SOCKET_MESSAGE_TYPE.EXERCISE_CREATED, {
      sessionNumber: this.sessionNumber,
      exercise: {
        id: newEx.id,
        type: newEx.type,
        default_answer: newEx.default_answer,
        version_block_id: versionBlockId,
        start_ts: newEx.start_ts,
      },
    });
    this.dispatchEvent(new CustomEvent("exerciseCreated", { detail: { exercise: newEx } }));
    return newEx;
  }

  async #maybeSimulateResponses(exerciseId, additionalContext) {
    if (!shouldSimulateResponses()) return;
    const body = { instructorId: this.userId, exerciseId };
    if (additionalContext != null) body.additional_context = additionalContext;
    const { simulatedResponses } = await fetch("/simulate-responses", {
      body: JSON.stringify(body),
      ...POST_JSON_REQUEST,
    }).then((r) => r.json());
    const ex = this.exercises.find((e) => e.id === exerciseId);
    if (ex && simulatedResponses) {
      simulatedResponses.forEach((r) => {
        ex.ExerciseResponses.push({
          id: r.id,
          student_id: r.student_name,
          student_identifier: r.student_name,
          StudentSession: null,
          answer: r.answer,
          isSimulated: true,
        });
      });
    }
  }

  showSummaryForExercise(id) {
    const ex = this.exercises.find((e) => e.id === id);
    if (!ex) return;
    this.dispatchEvent(new CustomEvent("showSummary", { detail: { exercise: ex } }));
  }

  async finishPollExercise() {
    for (let ex of this.getActiveExercises()) {
      if (ex.type === "POLL" || ex.type === "POLL_MCQ") {
        this.finishExercise(ex.id);
        break;
      }
    }
  }

  async finishExercise(id) {
    console.log("finishing exercise: ", id);
    const ex = this.exercises.find((e) => e.id === id);
    if (!ex) return;
    const res = await fetch("/exercise/finish", {
      body: JSON.stringify({ exerciseId: ex.id }),
      ...POST_JSON_REQUEST,
    }).then((r) => r.json());
    if (res.error) { alert(res.error); return; }

    ex.end_ts = Date.now();
    this.socket.emit(SOCKET_MESSAGE_TYPE.EXERCISE_FINISHED, {
      sessionNumber: this.sessionNumber,
      exerciseId: ex.id,
    });
    this.dispatchEvent(new CustomEvent("exerciseFinished", { detail: { exercise: ex } }));

    if (ex.type === "POLL_MCQ") return;

    fetch("/exercise/summary", {
      body: JSON.stringify({ instructorId: this.userId, exerciseId: ex.id }),
      ...POST_JSON_REQUEST,
    })
      .then((r) => r.json())
      .then(({ summary }) => {
        if (summary) ex.summary = JSON.stringify(summary);
        this.dispatchEvent(new CustomEvent("summaryReady", {
          detail: { exerciseId: ex.id, groups: summary ?? null },
        }));
      });
  }

  #handleStudentSubmitted(msg) {
    if (msg.sessionNumber !== this.sessionNumber) return;
    const ex = this.exercises.find((e) => e.id === msg.exerciseId);
    if (!ex) {
      console.error("Received exercise response for an exercise we don't know about");
      return;
    }

    const idx = ex.ExerciseResponses.findIndex((r) => r.student_id === msg.student_id);
    if (idx >= 0) {
      ex.ExerciseResponses[idx].answer = msg.answer;
      if (msg.responseId != null) ex.ExerciseResponses[idx].id = msg.responseId;
    } else {
      ex.ExerciseResponses.push({
        id: msg.responseId,
        student_id: msg.student_id,
        student_identifier: msg.student_identifier,
        answer: msg.answer,
      });
    }
    const count = ex ? ex.ExerciseResponses.filter((r) => !r.isSimulated).length : 0;
    this.dispatchEvent(new CustomEvent("responseReceived", {
      detail: { exercise: ex, responseCount: count },
    }));
  }
}

// MARK: Student
export class StudentActivitiesManager extends EventTarget {
  constructor({ sessionNumber, userId, studentIdentifier, socket, exercises }) {
    super();
    this.sessionNumber = sessionNumber;
    this.userId = userId;
    this.studentIdentifier = studentIdentifier;
    this.socket = socket;
    this.exercises = exercises.map((ex) => ({ ...ex }));

    socket.on(SOCKET_MESSAGE_TYPE.EXERCISE_CREATED, (msg) => this.#handleExerciseCreated(msg));
    socket.on(SOCKET_MESSAGE_TYPE.EXERCISE_FINISHED, (msg) => this.#handleExerciseFinished(msg));
  }

  getExercise(id) {
    return this.exercises.find((e) => e.id === id);
  }

  getExerciseForVersionBlock(versionBlockId) {
    return this.exercises.find((e) => e.VersionBlockId === versionBlockId) ?? null;
  }

  getActiveExercises() {
    return this.exercises.filter((e) => e.end_ts === null);
  }

  async submitResponse({ exerciseId, answer }) {
    const res = await fetch("/exercise/response", {
      body: JSON.stringify({ exerciseId, student_id: this.userId, answer }),
      ...POST_JSON_REQUEST,
    }).then((r) => r.json());
    if (res.error) throw new Error(res.error);
    this.socket.emit(SOCKET_MESSAGE_TYPE.STUDENT_SUBMITTED, {
      sessionNumber: this.sessionNumber,
      exerciseId,
      student_id: this.userId,
      student_identifier: this.studentIdentifier,
      answer,
      responseId: res.responseId,
    });
  }

  #handleExerciseCreated(msg) {
    if (msg.sessionNumber !== this.sessionNumber) return;
    const ex = msg.exercise;
    if (ex.type !== "CODE_VARIANT") return;
    const exercise = {
      id: ex.id,
      type: ex.type,
      default_answer: ex.default_answer,
      VersionBlockId: ex.version_block_id,
      start_ts: ex.start_ts,
      end_ts: null,
    };
    this.exercises.push(exercise);
    this.dispatchEvent(new CustomEvent("exerciseCreated", { detail: { exercise } }));
  }

  #handleExerciseFinished(msg) {
    if (msg.sessionNumber !== this.sessionNumber) return;
    const ex = this.exercises.find((e) => e.id === msg.exerciseId);
    if (!ex) return;
    ex.end_ts = Date.now();
    this.dispatchEvent(new CustomEvent("exerciseFinished", { detail: { exercise: ex } }));
  }
}
