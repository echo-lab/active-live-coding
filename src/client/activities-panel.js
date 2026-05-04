import { SOCKET_MESSAGE_TYPE } from "../shared-constants.js";
import { POST_JSON_REQUEST } from "./utils.js";
import { ReviewCodeEditor } from "./code-editors.js";
import { stripTrailingWhitespace } from "./diff-utils.js";
import { createForkDisplay } from "./cm-diff-extensions.js";

// MARK: Code/Poll HTML
function trimAnswer(text) {
  const perLineTrimmed = stripTrailingWhitespace(text);
  const lines = perLineTrimmed.split("\n");
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") start++;
  let end = lines.length - 1;
  while (end >= start && lines[end].trim() === "") end--;
  return lines.slice(start, end + 1).join("\n");
}

function isFillInTheBlank(exercise) {
  return exercise?.type === "CODE" && exercise?.code_line_context_start != null;
}

function createAnswerDisplay(answer, exerciseType, { label = "Your submission:", startExpanded = true } = {}) {
  const trimmed = trimAnswer(answer);

  const wrapper = document.createElement("div");
  wrapper.className = "answer-display-collapsible";

  const header = document.createElement("div");
  header.className = "answer-display-header";

  const caret = document.createElement("span");
  caret.className = "answer-display-caret";
  caret.textContent = startExpanded ? "▼" : "▶";

  const labelEl = document.createElement("span");
  labelEl.className = "answer-display-label";
  labelEl.textContent = label;

  header.appendChild(caret);
  header.appendChild(labelEl);

  const content = document.createElement("div");
  content.className = "answer-display-content";
  content.hidden = !startExpanded;

  if (exerciseType === "CODE") {
    const editorContainer = document.createElement("div");
    new ReviewCodeEditor({ node: editorContainer, doc: trimmed.split("\n"), isEditable: false });
    content.appendChild(editorContainer);
  } else {
    const pre = document.createElement("pre");
    pre.className = "answer-display-pre";
    pre.textContent = trimmed;
    content.appendChild(pre);
  }

  header.addEventListener("click", () => {
    const isExpanded = !content.hidden;
    content.hidden = isExpanded;
    caret.textContent = isExpanded ? "▶" : "▼";
  });

  wrapper.appendChild(header);
  wrapper.appendChild(content);
  return wrapper;
}

// MARK: Student Panel
export class StudentActivitiesPanel {
  constructor({
    sessionNumber,
    exercises,
    student_id,
    socket,
    openActivitiesPanel,
    studentIdentifier,
    showExerciseTab,
    closeExerciseTab,
    showFillInBlank,
    hideFillInBlank,
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
    this.showExerciseTab = showExerciseTab;
    this.closeExerciseTab = closeExerciseTab;
    this.showFillInBlank = showFillInBlank ?? null;
    this.hideFillInBlank = hideFillInBlank ?? null;

    // DOM refs
    this.listEl = document.querySelector("#student-activities-list");
    this.listItemsEl = document.querySelector("#student-activities-list-items");
    this.placeholderEl = document.querySelector("#student-activities-placeholder");
    this.exerciseEl = document.querySelector("#student-activity");
    this.instructionsEl = document.querySelector("#student-activity-instructions");
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
      if (ex.type === "CODE_FORK" && this.showExerciseTab) {
        this.showExerciseTab(msg.exercise.instructor_code, msg.exercise.id, null);
      } else if (isFillInTheBlank(ex)) {
        this.showFillInBlank?.(ex);
      }
    });

    socket.on(SOCKET_MESSAGE_TYPE.EXERCISE_FINISHED, (msg) => {
      if (msg.sessionNumber !== sessionNumber) return;
      let ex = this.exercises.find((e) => e.id === msg.exerciseId);
      if (ex) ex.end_ts = Date.now();
      if (ex?.type === "CODE_FORK" && this.closeExerciseTab) {
        this.closeExerciseTab();
      }
      if (isFillInTheBlank(ex)) {
        this.hideFillInBlank?.();
      }
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
      if (active.type === "CODE_FORK" && this.showExerciseTab) {
        let myResponse = active.ExerciseResponses.find((r) => r.student_id === this.student_id);
        this.showExerciseTab(active.instructor_code, active.id, myResponse?.answer ?? null);
      }
      if (active.type === "CODE" && active.code_line_context_start != null) {
        this.showFillInBlank?.(active);
      }
    } else {
      this._showList();
    }
    this._renderList();
  }

  onForkSubmitted(exerciseId, code) {
    let ex = this.exercises.find((e) => e.id === exerciseId);
    if (!ex) return;
    let idx = ex.ExerciseResponses.findIndex((r) => r.student_id === this.student_id);
    if (idx >= 0) {
      ex.ExerciseResponses[idx].answer = code;
    } else {
      ex.ExerciseResponses.push({ student_id: this.student_id, answer: code });
    }
    if (this.currentExerciseId === exerciseId) {
      this._showExercise(ex);
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

    if (ex.type === "CODE_FORK") {
      // Fork: no inline editor — student edits in the exercise tab
      this.answerInputEl.hidden = true;
      this.codeEditorEl.hidden = true;
      this.submitBtn.hidden = true;

      if (isActive) {
        this.answerDisplayEl.textContent = "Edit the code in the exercise tab, then click Submit.";
        this.answerDisplayEl.classList.remove("no-answer");
        this.answerDisplayEl.hidden = false;
      } else {
        this.answerDisplayEl.hidden = true;
      }

      if (myResponse) {
        this._showCollapsibleCode(myResponse.answer, ex.instructor_code ?? null);
      } else if (!isActive) {
        this.answerDisplayEl.textContent = "You didn't submit an answer.";
        this.answerDisplayEl.classList.add("no-answer");
        this.answerDisplayEl.hidden = false;
        this.codeSubmittedEl.hidden = true;
      } else {
        this.codeSubmittedEl.hidden = true;
      }
    } else if (ex.type === "CODE") {
      this.answerInputEl.hidden = true;
      this.answerDisplayEl.hidden = true;
      this.codeSubmittedEl.hidden = true;

      if (isFillInTheBlank(ex)) {
        // Fill-in-the-blank: student answers in the main code editor widget, not the sidebar.
        this.codeEditorEl.hidden = true;
        this.submitBtn.hidden = true;

        if (isActive) {
          this.answerDisplayEl.textContent = "Answer in the code editor above.";
          this.answerDisplayEl.classList.remove("no-answer");
          this.answerDisplayEl.hidden = false;
        } else if (myResponse) {
          this.codeSubmittedEl.innerHTML = "";
          this.codeSubmittedEl.appendChild(
            createAnswerDisplay(myResponse.answer, "CODE", { label: "Your submission:", startExpanded: true })
          );
          this.codeSubmittedEl.hidden = false;
        } else {
          this.answerDisplayEl.textContent = "You didn't submit an answer.";
          this.answerDisplayEl.classList.add("no-answer");
          this.answerDisplayEl.hidden = false;
        }
      } else if (!isActive) {
        if (myResponse) {
          this.codeEditorEl.hidden = true;
          this.codeSubmittedEl.innerHTML = "";
          this.codeSubmittedEl.appendChild(
            createAnswerDisplay(myResponse.answer, "CODE", { label: "Your submission:", startExpanded: true })
          );
          this.codeSubmittedEl.hidden = false;
        } else {
          this.codeEditorEl.hidden = true;
          this.codeSubmittedEl.hidden = true;
          this.answerDisplayEl.textContent = "You didn't submit an answer.";
          this.answerDisplayEl.classList.add("no-answer");
          this.answerDisplayEl.hidden = false;
        }
        this.submitBtn.hidden = true;
      } else {
        if (!this._codeEditors[ex.id]) {
          let container = document.createElement("div");
          let initialDoc;
          if (myResponse) {
            initialDoc = myResponse.answer.split("\n");
          } else if (ex.default_answer) {
            initialDoc = ex.default_answer.split("\n"); // fill-in-the-blank pre-population
          } else {
            initialDoc = [""];
          }
          this._codeEditors[ex.id] = {
            editor: new ReviewCodeEditor({
              node: container,
              doc: initialDoc,
              isEditable: true,
              showLineNumbers: true,
            }),
            container,
          };
        }
        this.codeEditorEl.innerHTML = "";
        this.codeEditorEl.appendChild(this._codeEditors[ex.id].container);
        this.codeEditorEl.hidden = false;

        if (myResponse) {
          this._showCollapsibleCode(myResponse.answer);
        }

        this.submitBtn.hidden = false;
        this.submitBtn.textContent = myResponse ? "Resubmit" : "Submit";
      }
    } else {
      // POLL
      this.codeEditorEl.hidden = true;

      if (!isActive && myResponse) {
        // Completed with answer: use unified display
        this.codeSubmittedEl.innerHTML = "";
        this.codeSubmittedEl.appendChild(
          createAnswerDisplay(myResponse.answer, "POLL", { label: "Your answer:", startExpanded: true })
        );
        this.codeSubmittedEl.hidden = false;
        this.answerDisplayEl.hidden = true;
        this.answerInputEl.value = myResponse.answer;
      } else {
        this.codeSubmittedEl.hidden = true;
        if (myResponse) {
          // Active with prior answer
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
      }

      this.answerInputEl.hidden = !isActive;
      this.submitBtn.hidden = !isActive;
      this.submitBtn.textContent = myResponse ? "Resubmit" : "Submit";
    }

    this.listEl.hidden = true;
    this.exerciseEl.hidden = false;
  }

  _showCollapsibleCode(code, originalCode) {
    this.codeSubmittedEl.innerHTML = "";
    if (originalCode != null) {
      // CODE_FORK: label is inside the collapsible header
      this.codeSubmittedEl.appendChild(createForkDisplay(code, originalCode));
    } else {
      // CODE active: unified display (has its own header/label)
      this.codeSubmittedEl.appendChild(
        createAnswerDisplay(code, "CODE", { label: "Your submission:", startExpanded: true })
      );
    }
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

    this._showCollapsibleCode(answer);
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

// MARK: Instructor Panel
export class InstructorActivitiesPanel {
  constructor({
    sessionNumber,
    exercises,
    socket,
    activitiesPanel,
    openPanel,
    getInstructorCode,
    onFillInBlankActivated,
    onFillInBlankDeactivated,
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
    this.getInstructorCode = getInstructorCode;
    this.onFillInBlankActivated = onFillInBlankActivated ?? null;
    this.onFillInBlankDeactivated = onFillInBlankDeactivated ?? null;
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
      isFillInTheBlank(active) && this.onFillInBlankActivated?.(active);
    } else {
      this._showView("list");
    }
    this._renderList();
  }

  // Create a code exercise from the editor (TODO: possibly move to a different location?)
  async createCodeExercise({ instructor_code, default_answer, code_line_context_start, code_line_context_end }) {
    let res = await fetch("/exercise", {
      body: JSON.stringify({
        lectureId: this.sessionNumber,
        type: "CODE",
        instructor_code,
        default_answer,
        code_line_context_start,
        code_line_context_end,
      }),
      ...POST_JSON_REQUEST,
    }).then((r) => r.json());
    if (res.error) {
      alert(res.error);
      return;
    }

    this.openPanel();
    let newEx = {
      id: res.exerciseId,
      type: "CODE",
      instructor_code,
      default_answer,
      code_line_context_start,
      code_line_context_end,
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
        start_ts: newEx.start_ts,
        type: newEx.type,
        instructor_code: newEx.instructor_code,
        default_answer: newEx.default_answer,
        code_line_context_start: newEx.code_line_context_start,
        code_line_context_end: newEx.code_line_context_end,
      },
    });
    this._showActiveView(newEx);
    isFillInTheBlank(newEx) && this.onFillInBlankActivated?.(newEx);
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
    this._updatePollButton();
  }

  _updatePollButton() {
    let hasActive = this.exercises.some((ex) => ex.end_ts == null);
    this.pollButton.disabled = hasActive;
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
          // TODO: change the outer summary-response div? Maybe nix it.
          let div = document.createElement("div");
          div.className = "summary-response";
          if (ex.type === "CODE_FORK") {
            div.appendChild(createForkDisplay(answer, ex.instructor_code ?? "", { label: displayName }));
          } else {
            // ex.type == "CODE" or "POLL"
            let startExpanded = answer.trim().split("\n").length <= 3;
            let label = displayName;
            console.log("EX: ", ex);
            div.appendChild(
              createAnswerDisplay(answer, ex.type, { label, startExpanded })
            );
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
    let instructor_code = this._selectedType === "CODE_FORK" && this.getInstructorCode
      ? this.getInstructorCode()
      : undefined;
    let res = await fetch("/exercise", {
      body: JSON.stringify({
        lectureId: this.sessionNumber,
        type: this._selectedType,
        instructions,
        instructor_code,
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
      instructor_code,
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
        instructor_code: newEx.instructor_code,
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

    isFillInTheBlank(ex) && this.onFillInBlankDeactivated?.();
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
