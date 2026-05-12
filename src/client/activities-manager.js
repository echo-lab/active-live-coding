import { SOCKET_MESSAGE_TYPE } from "../shared-constants.js";
import { POST_JSON_REQUEST, shouldSimulateResponses } from "./utils.js";

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
    return this.exercises.filter((e) => e.id === id);
  }

  getExercises() {
    return this.exercises;
  }

  async createPollExercise({ instructions }) {
    const res = await fetch("/exercise", {
      body: JSON.stringify({
        lectureId: this.sessionNumber,
        type: "POLL",
        instructions,
      }),
      ...POST_JSON_REQUEST,
    }).then((r) => r.json());
    if (res.error) { alert(res.error); return; }

    const newEx = {
      id: res.exerciseId,
      type: "POLL",
      instructions,
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

  // TODO: change this logic to work for vairant code exercises only :)
  async createCodeExercise({ instructor_code, default_answer, code_line_context_start, code_line_context_end }) {
    const res = await fetch("/exercise", {
      body: JSON.stringify({
        lectureId: this.sessionNumber,
        type: "CODE_FITB",
        instructor_code,
        default_answer,
        code_line_context_start,
        code_line_context_end,
      }),
      ...POST_JSON_REQUEST,
    }).then((r) => r.json());
    if (res.error) { alert(res.error); return; }

    if (shouldSimulateResponses()) {
      fetch("/simulate-responses", {
        body: JSON.stringify({ instructorId: this.userId, exerciseId: res.exerciseId }),
        ...POST_JSON_REQUEST,
      })
        .then((r) => r.json())
        .then(({ simulatedResponses }) => {
          const ex = this.exercises.find((e) => e.id === res.exerciseId);
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
        });
    }

    const newEx = {
      id: res.exerciseId,
      type: "CODE_FITB",
      instructor_code,
      default_answer,
      code_line_context_start,
      code_line_context_end,
      start_ts: Date.now(),
      end_ts: null,
      ExerciseResponses: [],
    };
    this.exercises.push(newEx);
    this.socket.emit(SOCKET_MESSAGE_TYPE.EXERCISE_CREATED, {
      sessionNumber: this.sessionNumber,
      exercise: {
        id: newEx.id,
        start_ts: newEx.start_ts,
        type: newEx.type,
        instructor_code: newEx.instructor_code,
        default_answer: newEx.default_answer,
        code_line_context_start: newEx.code_line_context_start,
        code_line_context_end: newEx.code_line_context_end,
      },
    });
    this.dispatchEvent(new CustomEvent("exerciseCreated", { detail: { exercise: newEx } }));
  }

  async finishPollExercise() {
    for (let ex of this.getActiveExercises()) {
      // console.log("active: ", ex);
      if (ex.type === "POLL") {
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
    this.activeExerciseId = null;
    this.socket.emit(SOCKET_MESSAGE_TYPE.EXERCISE_FINISHED, {
      sessionNumber: this.sessionNumber,
      exerciseId: ex.id,
    });
    this.dispatchEvent(new CustomEvent("exerciseFinished", { detail: { exercise: ex } }));

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
    if (msg.exerciseId !== this.activeExerciseId) return;
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
