import { SOCKET_MESSAGE_TYPE } from "../shared-constants.js";
import { POST_JSON_REQUEST } from "./utils.js";
import { ReviewCodeEditor } from "./code-editors.js";
import { stripTrailingWhitespace } from "./diff-utils.js";
import { InstructorActivitiesManager } from "./activities-manager.js";

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

  if (exerciseType === "CODE_FITB" || exerciseType === "CODE_VARIANT") {
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
      if (ex.type === "CODE_FITB") {
        const currentAnswer = ex.default_answer ?? "";
        this.showFillInBlank?.(ex, currentAnswer, this._makeFitbSubmit(ex));
      }
    });

    socket.on(SOCKET_MESSAGE_TYPE.EXERCISE_FINISHED, (msg) => {
      if (msg.sessionNumber !== sessionNumber) return;
      let ex = this.exercises.find((e) => e.id === msg.exerciseId);
      if (ex) ex.end_ts = Date.now();
      if (ex?.type === "CODE_FITB") {
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
      if (active.type === "CODE_FITB") {
        const myResponse = active.ExerciseResponses.find((r) => r.student_id === this.student_id);
        const currentAnswer = myResponse?.answer ?? active.default_answer ?? "";
        this.showFillInBlank?.(active, currentAnswer, this._makeFitbSubmit(active));
      }
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

    if (ex.type === "CODE_FITB") {
      this.answerInputEl.hidden = true;
      this.answerDisplayEl.hidden = true;
      this.codeSubmittedEl.hidden = true;

      // Fill-in-the-blank: student answers in the main code editor widget, not the sidebar.
      this.submitBtn.hidden = true;

      if (isActive && myResponse) {
        this.codeSubmittedEl.innerHTML = "";
        this.codeSubmittedEl.appendChild(
          createAnswerDisplay(myResponse.answer, "CODE_FITB", { label: "Your submission:", startExpanded: true })
        );
        this.codeSubmittedEl.hidden = false;
      } else if (isActive) {
        this.answerDisplayEl.textContent = "Answer in the code editor.";
        this.answerDisplayEl.classList.remove("no-answer");
        this.answerDisplayEl.hidden = false;
      } else if (myResponse) {
        this.codeSubmittedEl.innerHTML = "";
        this.codeSubmittedEl.appendChild(
          createAnswerDisplay(myResponse.answer, "CODE_FITB", { label: "Your submission:", startExpanded: true })
        );
        this.codeSubmittedEl.hidden = false;
      } else {
        this.answerDisplayEl.textContent = "You didn't submit an answer.";
        this.answerDisplayEl.classList.add("no-answer");
        this.answerDisplayEl.hidden = false;
      }
    } else {
      // POLL

      if (myResponse) {
        this.codeSubmittedEl.innerHTML = "";
        this.codeSubmittedEl.appendChild(
          createAnswerDisplay(myResponse.answer, "POLL", { label: "Your answer:", startExpanded: true })
        );
        this.codeSubmittedEl.hidden = false;
        this.answerDisplayEl.hidden = true;
        this.answerInputEl.value = myResponse.answer;
      } else if (!isActive) {
        this.codeSubmittedEl.hidden = true;
        this.answerDisplayEl.textContent = "You didn't submit an answer.";
        this.answerDisplayEl.classList.add("no-answer");
        this.answerDisplayEl.hidden = false;
        this.answerInputEl.value = "";
      } else {
        this.codeSubmittedEl.hidden = true;
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

  _showCollapsibleCode(code) {
    this.codeSubmittedEl.innerHTML = "";
    this.codeSubmittedEl.appendChild(
      createAnswerDisplay(code, "POLL", { label: "Your submission:", startExpanded: true })
    );
    this.codeSubmittedEl.hidden = false;
  }

  _makeFitbSubmit(ex) {
    return async (code) => {
      const res = await fetch("/exercise/response", {
        body: JSON.stringify({ exerciseId: ex.id, student_id: this.student_id, answer: code }),
        ...POST_JSON_REQUEST,
      }).then((r) => r.json());
      if (res.error) { alert(res.error); return; }

      const idx = ex.ExerciseResponses.findIndex((r) => r.student_id === this.student_id);
      if (idx >= 0) {
        ex.ExerciseResponses[idx].answer = code;
      } else {
        ex.ExerciseResponses.push({ student_id: this.student_id, answer: code });
      }

      this.codeSubmittedEl.innerHTML = "";
      this.codeSubmittedEl.appendChild(
        createAnswerDisplay(code, "CODE_FITB", { label: "Your submission:", startExpanded: true })
      );
      this.codeSubmittedEl.hidden = false;
      this._renderList();

      this.socket.emit(SOCKET_MESSAGE_TYPE.STUDENT_SUBMITTED, {
        sessionNumber: this.sessionNumber,
        exerciseId: ex.id,
        student_id: this.student_id,
        student_identifier: this.studentIdentifier,
        answer: code,
        responseId: res.responseId,
      });
    };
  }

  async _submitAnswer() {
    let exerciseId = this.currentExerciseId;
    let ex = this.exercises.find((e) => e.id === exerciseId);
    let answer = this.answerInputEl.value.trim();
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
      responseId: res.responseId,
    });
  }
}

// MARK: Helpers for constructing UI for the instructor

// Renders a single student response element.
function renderResponseEl(response, ex) {
  let { student_id, student_identifier, StudentSession, answer } = response;
  let displayName = StudentSession?.student_identifier ?? student_identifier ?? student_id;
  let div = document.createElement("div");
  div.className = "summary-response";
  div.appendChild(createAnswerDisplay(answer, ex.type, { label: displayName, startExpanded: true }));
  return div;
}

// Renders all student responses into responsesEl, optionally grouped.
function renderResponsesEl(responsesEl, ex, groups) {
  if (!ex.ExerciseResponses || ex.ExerciseResponses.length === 0) {
    responsesEl.textContent = "No responses.";
    return;
  }
  if (!groups) {
    ex.ExerciseResponses.forEach((response) => {
      responsesEl.appendChild(renderResponseEl(response, ex));
    });
    return;
  }

  let responseById = {};
  ex.ExerciseResponses.forEach((r) => {
    let key = r.isSimulated ? `sim_${r.id}` : `real_${r.id}`;
    responseById[key] = r;
  });

  groups.forEach((group) => {
    let responses = group.response_ids
      .map((id) => responseById[id])
      .filter(Boolean);
    if (responses.length === 0) return;

    let groupEl = document.createElement("div");
    groupEl.className = "response-group";

    let headerEl = document.createElement("div");
    headerEl.className = "group-header";
    let descEl = document.createElement("span");
    descEl.className = "group-description";
    descEl.textContent = group.description;
    let countEl = document.createElement("span");
    countEl.className = "group-count";
    countEl.textContent = `(x${responses.length})`;
    headerEl.appendChild(descEl);
    headerEl.appendChild(countEl);
    groupEl.appendChild(headerEl);

    groupEl.appendChild(renderResponseEl(responses[0], ex));

    if (responses.length > 1) {
      let extraEl = document.createElement("div");
      extraEl.className = "group-extra-responses";
      extraEl.hidden = true;
      responses.slice(1).forEach((r) => {
        extraEl.appendChild(renderResponseEl(r, ex));
      });

      let toggleBtn = document.createElement("button");
      toggleBtn.className = "group-toggle-btn";
      toggleBtn.textContent = `▶ Show ${responses.length - 1} more`;
      toggleBtn.addEventListener("click", () => {
        let collapsed = extraEl.hidden;
        extraEl.hidden = !collapsed;
        toggleBtn.textContent = collapsed
          ? "▼ Show less"
          : `▶ Show ${responses.length - 1} more`;
      });

      groupEl.appendChild(toggleBtn);
      groupEl.appendChild(extraEl);
    }

    responsesEl.appendChild(groupEl);
  });
}

// MARK: PollExerciseWidget
class PollExerciseWidget {
  constructor({ manager, createEl, activeEl, onBack }) {
    this.createEl = createEl;
    this.activeEl = activeEl;
    this.timerInterval = null;

    createEl.querySelector("#activities-back")
      .addEventListener("click", onBack);
    activeEl.querySelector("#activities-active-back")
      .addEventListener("click", onBack);

    createEl.querySelector("#activity-submit-create")
      .addEventListener("click", async () => {
        const instructions = createEl.querySelector("#activity-instructions").value.trim();
        await manager.createPollExercise({ instructions });
      });

    activeEl.querySelector("#activity-finish")
      .addEventListener("click", () => manager.finishPollExercise());
  }

  showCreate() {
    this.createEl.querySelector("#activity-instructions").value = "";
    this.createEl.hidden = false;
    this.activeEl.hidden = true;
  }

  showActive(ex) {
    this.activeEl.querySelector("#activity-active-instructions").textContent =
      ex.instructions ?? "";
    let count = ex.ExerciseResponses.filter((r) => !r.isSimulated).length;
    this.activeEl.querySelector("#activity-response-count").textContent =
      `${count} response${count !== 1 ? "s" : ""}`;
    this.createEl.hidden = true;
    this.activeEl.hidden = false;
    this._startTimer(ex.start_ts);
  }

  hide() {
    this.createEl.hidden = true;
    this.activeEl.hidden = true;
    this._stopTimer();
  }

  stopTimer() {
    this._stopTimer();
  }

  updateResponseCount(count) {
    this.activeEl.querySelector("#activity-response-count").textContent =
      `${count} response${count !== 1 ? "s" : ""}`;
  }

  renderSummaryResponses(responsesEl, ex, groups) {
    renderResponsesEl(responsesEl, ex, groups);
  }

  _startTimer(startTs) {
    if (this.timerInterval) clearInterval(this.timerInterval);
    const update = () => {
      let elapsed = Math.floor((Date.now() - startTs) / 1000);
      let m = Math.floor(elapsed / 60);
      let s = elapsed % 60;
      this.activeEl.querySelector("#activity-timer").textContent =
        `${m}:${String(s).padStart(2, "0")}`;
    };
    update();
    this.timerInterval = setInterval(update, 1000);
  }

  _stopTimer() {
    clearInterval(this.timerInterval);
    this.timerInterval = null;
  }
}

// MARK: CodeExerciseSummaryWidget
class CodeExerciseSummaryWidget {
  renderSummaryResponses(responsesEl, ex, groups) {
    renderResponsesEl(responsesEl, ex, groups);
  }
}

// MARK: Instructor Panel
export class InstructorActivitiesPanel {
  constructor(manager, {
    activitiesPanelEl,
    openPanel,
  }) {
    /** @type {InstructorActivitiesManager} */
    this.manager = manager;
    this.activitiesPanelEl = activitiesPanelEl;
    this.openPanel = openPanel;

    // DOM refs owned by this panel
    this.listEl = document.querySelector("#activities-list");
    this.listItemsEl = document.querySelector("#activities-list-items");
    this.summaryEl = document.querySelector("#activities-summary");
    this.pollButton = document.querySelector("#poll-button");

    this.pollWidget = new PollExerciseWidget({
      manager,
      createEl: document.querySelector("#activities-create"),
      activeEl: document.querySelector("#activities-active"),
      onBack: () => this._showView("list"),
    });
    this.codeWidget = new CodeExerciseSummaryWidget();

    document
      .querySelector("#activities-summary-back")
      .addEventListener("click", () => this._showView("list"));

    this.pollButton.addEventListener("click", () => {
      this.openPanel();
      this._showView("create");
    });

    this.#subscribeToManager();

    for (let ex of manager.getActiveExercises()) {
      if (ex.type === "POLL") {
        this.openPanel();
        this._showActiveView(ex);
        break;
      }
    }
    this._renderList();
  }

  #subscribeToManager() {
    this.manager.addEventListener("exerciseCreated", ({ detail: { exercise } }) => {
      if (exercise.type !== "POLL") return;
      this.openPanel();
      this._renderList();
      this._showActiveView(exercise);
    });

    this.manager.addEventListener("exerciseFinished", ({ detail: { exercise } }) => {
      if (exercise.type === "POLL") this.pollWidget.stopTimer();
      this.openPanel();
      this._renderList();
      this._showSummaryView(exercise, { loading: true });
    });

    this.manager.addEventListener("summaryReady", ({ detail: { exerciseId, groups } }) => {
      const ex = this.manager.getExercise(exerciseId);
      if (!ex) return;
      const responsesEl = this.summaryEl.querySelector("#activity-summary-responses");
      responsesEl.innerHTML = "";
      this._renderSummaryResponses(responsesEl, ex, groups);
    });

    this.manager.addEventListener("showSummary", ({ detail: { exercise } }) => {
      this.openPanel();
      this._showSummaryView(exercise);
    });

    this.manager.addEventListener("responseReceived", ({ detail: { responseCount } }) => {
      this.pollWidget.updateResponseCount(responseCount);
    });
  }

  _showView(name) {
    this.listEl.hidden = name !== "list";
    this.summaryEl.hidden = name !== "summary";
    if (name === "create") {
      this.pollWidget.showCreate();
    } else if (name !== "active") {
      // "active" is managed directly by _showActiveView; for all other views, hide poll sections
      this.pollWidget.hide();
    }
    this.activitiesPanelEl.classList.toggle("has-content", true);
  }

  _showActiveView(ex) {
    this.listEl.hidden = true;
    this.summaryEl.hidden = true;
    this.pollWidget.showActive(ex);
    this.activitiesPanelEl.classList.toggle("has-content", true);
  }

  _showSummaryView(ex, { loading = false, groups = undefined } = {}) {
    const instructionsEl = this.summaryEl.querySelector("#activity-summary-instructions");
    const responsesEl = this.summaryEl.querySelector("#activity-summary-responses");
    instructionsEl.textContent = ex.instructions ?? "";
    responsesEl.innerHTML = "";
    if (loading) {
      let loadingEl = document.createElement("div");
      loadingEl.className = "summary-loading";
      loadingEl.textContent = "Generating summary…";
      responsesEl.appendChild(loadingEl);
    } else {
      let resolvedGroups = groups !== undefined ? groups
        : (ex.summary ? JSON.parse(ex.summary) : null);
      this._renderSummaryResponses(responsesEl, ex, resolvedGroups);
    }
    this._showView("summary");
  }

  // Delegates to the relevant widget.
  _renderSummaryResponses(responsesEl, ex, groups) {
    if (ex.type === "CODE_VARIANT") {
      this.codeWidget.renderSummaryResponses(responsesEl, ex, groups);
    } else {
      this.pollWidget.renderSummaryResponses(responsesEl, ex, groups);
    }
  }

  _renderList() {
    this.listItemsEl.innerHTML = "";
    [...this.manager.getExercises()].reverse().forEach((ex) => {
      if (ex.type !== "POLL") return;

      let item = document.createElement("div");
      item.className = "activity-list-item";
      let isActive = ex.end_ts == null;
      let badge = isActive ? "Active" : "Done";
      let preview = ex.instructions ? ex.instructions.slice(0, 60) : "(no instructions)";
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
    const activeExercises = this.manager.getActiveExercises();
    this.pollButton.disabled = activeExercises.some(ex => ex.type === "POLL");
  }
}
