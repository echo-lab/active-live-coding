import { SOCKET_MESSAGE_TYPE } from "../shared-constants.js";
import { POST_JSON_REQUEST } from "./utils.js";
import { ReviewCodeEditor } from "./code-editors.js";

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
    this.codeSubmittedEl = document.querySelector("#student-code-submitted");
    this.answerInputEl = document.querySelector("#student-answer-input");
    this.codeEditorEl = document.querySelector("#student-code-editor");
    this.submitBtn = document.querySelector("#student-submit-btn");
    this._codeEditors = {}; // keyed by exerciseId, preserves in-progress code

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
      if (this.currentExerciseId === msg.exerciseId && ex) {
        this._showExercise(ex);
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
    let isCode = ex.type === "CODE";

    this.instructionsEl.textContent = ex.instructions ?? "";

    if (isCode) {
      this.answerInputEl.hidden = true;
      this.answerDisplayEl.hidden = true;
      this.codeSubmittedEl.hidden = true;

      if (!isActive) {
        // Exercise finished — show read-only CodeMirror or "no answer" message
        if (myResponse) {
          this.codeEditorEl.innerHTML = "";
          this.codeEditorEl.hidden = false;
          new ReviewCodeEditor({
            node: this.codeEditorEl,
            doc: myResponse.answer.split("\n"),
            isEditable: false,
          });
        } else {
          this.codeEditorEl.hidden = true;
          this.answerDisplayEl.textContent = "You didn't submit an answer.";
          this.answerDisplayEl.classList.add("no-answer");
          this.answerDisplayEl.hidden = false;
        }
        this.submitBtn.hidden = true;
      } else {
        // Exercise active — show editable CodeMirror, persisting in-progress code
        if (!this._codeEditors[ex.id]) {
          let container = document.createElement("div");
          this._codeEditors[ex.id] = {
            editor: new ReviewCodeEditor({
              node: container,
              doc: myResponse ? myResponse.answer.split("\n") : [""],
              isEditable: true,
              showLineNumbers: true,
            }),
            container,
          };
        }
        this.codeEditorEl.innerHTML = "";
        this.codeEditorEl.appendChild(this._codeEditors[ex.id].container);
        this.codeEditorEl.hidden = false;

        // If already submitted, show read-only snapshot of what was sent
        if (myResponse) {
          this._showCodeSubmitted(myResponse.answer);
        }

        this.submitBtn.hidden = false;
        this.submitBtn.textContent = myResponse ? "Resubmit" : "Submit";
      }
    } else {
      // POLL — existing text behaviour
      this.codeEditorEl.hidden = true;
      this.codeSubmittedEl.hidden = true;

      if (myResponse) {
        this.answerDisplayEl.textContent = `Your answer: ${myResponse.answer}`;
        this.answerDisplayEl.classList.remove("no-answer");
        this.answerDisplayEl.hidden = false;
        this.answerInputEl.value = myResponse.answer;
      } else if (!isActive) {
        this.answerDisplayEl.textContent = "You didn't submit an answer.";
        this.answerDisplayEl.classList.add("no-answer");
        this.answerDisplayEl.hidden = false;
        this.answerInputEl.value = "";
      } else {
        this.answerDisplayEl.hidden = true;
        this.answerInputEl.value = "";
      }

      this.answerInputEl.hidden = !isActive;
      this.submitBtn.hidden = !isActive;
      this.submitBtn.textContent = myResponse ? "Resubmit" : "Submit";
    }

    this.listEl.hidden = true;
    this.exerciseEl.hidden = false;
  }

  _showCodeSubmitted(code) {
    this.codeSubmittedEl.innerHTML = "";
    let label = document.createElement("span");
    label.className = "code-submitted-label";
    label.textContent = "Your submission:";
    this.codeSubmittedEl.appendChild(label);
    let editorContainer = document.createElement("div");
    this.codeSubmittedEl.appendChild(editorContainer);
    new ReviewCodeEditor({
      node: editorContainer,
      doc: code.split("\n"),
      isEditable: false,
    });
    this.codeSubmittedEl.hidden = false;
  }

  async _submitAnswer() {
    let exerciseId = this.currentExerciseId;
    let ex = this.exercises.find((e) => e.id === exerciseId);
    let answer;
    if (ex?.type === "CODE") {
      answer = this._codeEditors[exerciseId]?.editor.currentCode() ?? "";
    } else {
      answer = this.answerInputEl.value.trim();
    }
    if (!answer) return;
    let res = await fetch("/exercise/response", {
      body: JSON.stringify({ exerciseId, student_id: this.student_id, answer }),
      ...POST_JSON_REQUEST,
    }).then((r) => r.json());
    if (res.error) {
      alert(res.error);
      return;
    }

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

    if (ex?.type === "CODE") {
      this._showCodeSubmitted(answer);
    } else {
      this.answerDisplayEl.textContent = `Your answer: ${answer}`;
      this.answerDisplayEl.hidden = false;
    }
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
    this._selectedType = "POLL";
    document.querySelectorAll(".type-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.disabled) return;
        document.querySelectorAll(".type-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        this._selectedType = btn.dataset.type;
      });
    });

    this.pollButton.addEventListener("click", () => {
      this.openPanel();
      this._showView("create");
      document.querySelector("#activity-instructions").value = "";
      // Reset type toggle to Text/POLL
      document.querySelectorAll(".type-btn").forEach((b) => b.classList.remove("active"));
      document.querySelector('.type-btn[data-type="POLL"]').classList.add("active");
      this._selectedType = "POLL";
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
          let nameSpan = document.createElement("span");
          nameSpan.className = "summary-student";
          nameSpan.textContent = displayName;
          div.appendChild(nameSpan);
          if (ex.type === "CODE") {
            let codeContainer = document.createElement("div");
            codeContainer.className = "summary-code-answer";
            div.appendChild(codeContainer);
            new ReviewCodeEditor({
              node: codeContainer,
              doc: answer.split("\n"),
              isEditable: false,
            });
          } else {
            let pre = document.createElement("pre");
            pre.className = "summary-answer";
            pre.textContent = answer;
            div.appendChild(pre);
          }
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
        type: this._selectedType,
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
      type: this._selectedType,
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
