import { SOCKET_MESSAGE_TYPE } from "../shared-constants.js";
import { POST_JSON_REQUEST } from "./utils.js";

export class StudentActivitiesPanel {
  constructor({
    sessionNumber,
    exercises,
    student_id,
    socket,
    openActivitiesPanel,
    studentIdentifier,
  }) {
    this.sessionNumber = sessionNumber;
    this.exercises = exercises.map((ex) => ({
      ...ex,
      ExerciseResponses: ex.ExerciseResponses ?? [],
    }));
    this.student_id = student_id;
    this.socket = socket;
    this.currentExerciseId = null;
    this.studentIdentifier = studentIdentifier;

    // DOM refs
    this.listEl = document.querySelector("#student-activities-list");
    this.listItemsEl = document.querySelector("#student-activities-list-items");
    this.placeholderEl = document.querySelector(
      "#student-activities-placeholder",
    );
    this.exerciseEl = document.querySelector("#student-activity");
    this.instructionsEl = document.querySelector(
      "#student-activity-instructions",
    );
    this.answerDisplayEl = document.querySelector("#student-answer-display");
    this.answerInputEl = document.querySelector("#student-answer-input");
    this.submitBtn = document.querySelector("#student-submit-btn");

    document
      .querySelector("#student-activity-back")
      .addEventListener("click", () => this._showList());
    this.submitBtn.addEventListener("click", () => this._submitAnswer());

    socket.on(SOCKET_MESSAGE_TYPE.EXERCISE_CREATED, (msg) => {
      if (msg.sessionNumber !== sessionNumber) return;
      let ex = { ...msg.exercise, end_ts: null, ExerciseResponses: [] };
      this.exercises.push(ex);
      this._renderList();
      openActivitiesPanel();
      this._showExercise(ex);
    });

    socket.on(SOCKET_MESSAGE_TYPE.EXERCISE_FINISHED, (msg) => {
      if (msg.sessionNumber !== sessionNumber) return;
      let ex = this.exercises.find((e) => e.id === msg.exerciseId);
      if (ex) ex.end_ts = Date.now();
      if (this.currentExerciseId === msg.exerciseId) {
        this.submitBtn.hidden = true;
        this.answerInputEl.hidden = true;
      }
      this._renderList();
    });

    // If there's an active exercise on load, open it
    let active = this.exercises.find((ex) => ex.end_ts == null);
    if (active) {
      openActivitiesPanel();
      this._showExercise(active);
    } else {
      this._showList();
    }
    this._renderList();
  }

  _showList() {
    this.currentExerciseId = null;
    this.exerciseEl.hidden = true;
    this.listEl.hidden = false;
  }

  _renderList() {
    this.listItemsEl.innerHTML = "";
    let hasItems = this.exercises.length > 0;
    this.placeholderEl.hidden = hasItems;
    [...this.exercises].reverse().forEach((ex) => {
      let myResponse = ex.ExerciseResponses.find(
        (r) => r.student_id === this.student_id,
      );
      let isActive = ex.end_ts == null;
      let item = document.createElement("div");
      item.className = "activity-list-item";
      let badge = isActive ? "Active" : "Done";
      let preview = ex.instructions
        ? ex.instructions.slice(0, 60)
        : "(no instructions)";
      let answerSnippet = myResponse
        ? ` — "${myResponse.answer.slice(0, 30)}"`
        : " — no answer";
      item.innerHTML = `<span class="activity-item-preview">${preview}</span><span class="activity-item-badge ${isActive ? "badge-active" : "badge-done"}">${badge}</span><span class="activity-item-answer">${answerSnippet}</span>`;
      item.addEventListener("click", () => this._showExercise(ex));
      this.listItemsEl.appendChild(item);
    });
  }

  _showExercise(ex) {
    this.currentExerciseId = ex.id;
    let myResponse = ex.ExerciseResponses.find(
      (r) => r.student_id === this.student_id,
    );
    let isActive = ex.end_ts == null;

    this.instructionsEl.textContent = ex.instructions ?? "";

    if (myResponse) {
      this.answerDisplayEl.textContent = `Your answer: ${myResponse.answer}`;
      this.answerDisplayEl.hidden = false;
      this.answerInputEl.value = myResponse.answer;
    } else {
      this.answerDisplayEl.hidden = true;
      this.answerInputEl.value = "";
    }

    this.answerInputEl.hidden = !isActive;
    this.submitBtn.hidden = !isActive;
    this.submitBtn.textContent = myResponse ? "Resubmit" : "Submit";

    this.listEl.hidden = true;
    this.exerciseEl.hidden = false;
  }

  async _submitAnswer() {
    let answer = this.answerInputEl.value.trim();
    if (!answer) return;
    let exerciseId = this.currentExerciseId;
    let res = await fetch("/exercise/response", {
      body: JSON.stringify({ exerciseId, student_id: this.student_id, answer }),
      ...POST_JSON_REQUEST,
    }).then((r) => r.json());
    if (res.error) {
      alert(res.error);
      return;
    }

    let ex = this.exercises.find((e) => e.id === exerciseId);
    if (ex) {
      let idx = ex.ExerciseResponses.findIndex(
        (r) => r.student_id === this.student_id,
      );
      if (idx >= 0) {
        ex.ExerciseResponses[idx].answer = answer;
      } else {
        ex.ExerciseResponses.push({ student_id: this.student_id, answer });
      }
    }

    this.answerDisplayEl.textContent = `Your answer: ${answer}`;
    this.answerDisplayEl.hidden = false;
    this.submitBtn.textContent = "Resubmit";
    this._renderList();

    this.socket.emit(SOCKET_MESSAGE_TYPE.STUDENT_SUBMITTED, {
      sessionNumber: this.sessionNumber,
      exerciseId,
      student_id: this.student_id,
      student_identifier: this.studentIdentifier,
      answer,
    });
  }
}

export class InstructorActivitiesPanel {
  constructor({
    sessionNumber,
    exercises,
    socket,
    activitiesPanel,
    openPanel,
  }) {
    console.log("Exercises: ", exercises);
    this.sessionNumber = sessionNumber;
    this.exercises = exercises.map((ex) => ({
      ...ex,
      ExerciseResponses: ex.ExerciseResponses ?? [],
    }));
    this.socket = socket;
    this.activitiesPanel = activitiesPanel;
    this.openPanel = openPanel;
    this.activeExerciseId = null;
    this.timerInterval = null;

    // DOM refs
    this.listEl = document.querySelector("#activities-list");
    this.listItemsEl = document.querySelector("#activities-list-items");
    this.createEl = document.querySelector("#activities-create");
    this.activeEl = document.querySelector("#activities-active");
    this.summaryEl = document.querySelector("#activities-summary");
    this.pollButton = document.querySelector("#poll-button");

    document
      .querySelector("#activities-back")
      .addEventListener("click", () => this._showView("list"));
    document
      .querySelector("#activities-active-back")
      .addEventListener("click", () => this._showView("list"));
    document
      .querySelector("#activities-summary-back")
      .addEventListener("click", () => this._showView("list"));
    document
      .querySelector("#activity-submit-create")
      .addEventListener("click", () => this._createExercise());
    document
      .querySelector("#activity-finish")
      .addEventListener("click", () => this._finishExercise());
    this.pollButton.addEventListener("click", () => {
      this.openPanel();
      this._showView("create");
      document.querySelector("#activity-instructions").value = "";
    });

    socket.on(SOCKET_MESSAGE_TYPE.STUDENT_SUBMITTED, (msg) => {
      if (msg.sessionNumber !== sessionNumber) return;
      if (msg.exerciseId !== this.activeExerciseId) return;
      let ex = this.exercises.find((e) => e.id === msg.exerciseId);
      if (ex) {
        // Update or add response in local list
        let idx = ex.ExerciseResponses.findIndex(
          (r) => r.student_id === msg.student_id,
        );
        if (idx >= 0) {
          ex.ExerciseResponses[idx].answer = msg.answer;
        } else {
          ex.ExerciseResponses.push({
            student_id: msg.student_id,
            student_identifier: msg.student_identifier,
            answer: msg.answer,
          });
        }
      }
      const countEl = document.querySelector("#activity-response-count");
      let count = ex ? ex.ExerciseResponses.length : 0;
      countEl.textContent = `${count} response${count !== 1 ? "s" : ""}`;
    });

    // Check for any already-active exercise on load
    let active = this.exercises.find((ex) => ex.end_ts == null);
    if (active) {
      this.activeExerciseId = active.id;
      this.openPanel();
      this._showActiveView(active);
    } else {
      this._showView("list");
    }
    this._renderList();
  }

  _showView(name) {
    console.log("CHANGING TO: ", name);
    this.listEl.hidden = name !== "list";
    this.createEl.hidden = name !== "create";
    this.activeEl.hidden = name !== "active";
    this.summaryEl.hidden = name !== "summary";
    this.activitiesPanel.classList.toggle("has-content", true);
  }

  _renderList() {
    this.listItemsEl.innerHTML = "";
    [...this.exercises].reverse().forEach((ex) => {
      let item = document.createElement("div");
      item.className = "activity-list-item";
      let isActive = ex.end_ts == null;
      let badge = isActive ? "Active" : "Done";
      let preview = ex.instructions
        ? ex.instructions.slice(0, 60)
        : "(no instructions)";
      item.innerHTML = `<span class="activity-item-preview">${preview}</span><span class="activity-item-badge ${isActive ? "badge-active" : "badge-done"}">${badge}</span>`;
      item.addEventListener("click", () => {
        if (isActive) {
          this._showActiveView(ex);
        } else {
          this._showSummaryView(ex);
        }
      });
      this.listItemsEl.appendChild(item);
    });
  }

  _showActiveView(ex) {
    document.querySelector("#activity-active-instructions").textContent =
      ex.instructions ?? "";
    let count = ex.ExerciseResponses.length;
    document.querySelector("#activity-response-count").textContent =
      `${count} response${count !== 1 ? "s" : ""}`;
    this._showView("active");
    this._startTimer(ex.start_ts);
  }

  _showSummaryView(ex) {
    document.querySelector("#activity-summary-instructions").textContent =
      ex.instructions ?? "";
    let responsesEl = document.querySelector("#activity-summary-responses");
    responsesEl.innerHTML = "";
    if (ex.ExerciseResponses.length === 0) {
      responsesEl.textContent = "No responses.";
    } else {
      ex.ExerciseResponses.forEach(
        ({ student_id, student_identifier, StudentSession, answer }) => {
          let displayName =
            StudentSession?.student_identifier ??
            student_identifier ??
            student_id;
          let div = document.createElement("div");
          div.className = "summary-response";
          div.innerHTML = `<span class="summary-student">${displayName}</span><pre class="summary-answer">${answer}</pre>`;
          responsesEl.appendChild(div);
        },
      );
    }
    this._showView("summary");
  }

  _startTimer(startTs) {
    if (this.timerInterval) clearInterval(this.timerInterval);
    const update = () => {
      let elapsed = Math.floor((Date.now() - startTs) / 1000);
      let m = Math.floor(elapsed / 60);
      let s = elapsed % 60;
      document.querySelector("#activity-timer").textContent =
        `${m}:${String(s).padStart(2, "0")}`;
    };
    update();
    this.timerInterval = setInterval(update, 1000);
  }

  async _createExercise() {
    let instructions = document
      .querySelector("#activity-instructions")
      .value.trim();
    let res = await fetch("/exercise", {
      body: JSON.stringify({
        lectureId: this.sessionNumber,
        type: "POLL",
        instructions,
      }),
      ...POST_JSON_REQUEST,
    }).then((r) => r.json());
    if (res.error) {
      alert(res.error);
      return;
    }

    let newEx = {
      id: res.exerciseId,
      type: "POLL",
      instructions,
      start_ts: Date.now(),
      end_ts: null,
      ExerciseResponses: [],
    };
    this.exercises.push(newEx);
    this.activeExerciseId = newEx.id;
    this._renderList();
    this.socket.emit(SOCKET_MESSAGE_TYPE.EXERCISE_CREATED, {
      sessionNumber: this.sessionNumber,
      exercise: {
        id: newEx.id,
        instructions: newEx.instructions,
        start_ts: newEx.start_ts,
        type: newEx.type,
      },
    });
    this._showActiveView(newEx);
  }

  async _finishExercise() {
    let ex = this.exercises.find((e) => e.id === this.activeExerciseId);
    if (!ex) return;
    let res = await fetch("/exercise/finish", {
      body: JSON.stringify({ exerciseId: ex.id }),
      ...POST_JSON_REQUEST,
    }).then((r) => r.json());
    if (res.error) {
      alert(res.error);
      return;
    }

    ex.end_ts = Date.now();
    this.activeExerciseId = null;
    clearInterval(this.timerInterval);
    this.timerInterval = null;
    this.socket.emit(SOCKET_MESSAGE_TYPE.EXERCISE_FINISHED, {
      sessionNumber: this.sessionNumber,
      exerciseId: ex.id,
    });
    this._renderList();
    this._showSummaryView(ex);
  }
}
