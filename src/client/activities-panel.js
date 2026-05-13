import { EditorView, minimalSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { python } from "@codemirror/lang-python";
import { indentUnit } from "@codemirror/language";
import { keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
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
  constructor({ manager, pollEl, onBack, getSelectedCode }) {
    this.pollEl = pollEl;
    this.timerInterval = null;
    this.getSelectedCode = getSelectedCode;
    this._onBack = onBack;
    this._manager = manager;

    this._timerEl = null;
    this._responseCountEl = null;
    this._responsesEl = null;
    this._instructionsInput = null;

    const readOnlyExtensions = [
      minimalSetup,
      python(),
      EditorView.lineWrapping,
      EditorView.editable.of(false),
    ];

    this.codeEditorEl = document.createElement("div");
    this.codeEditorEl.classList.add("poll-code-box");
    this.codeView = new EditorView({
      state: EditorState.create({ doc: "", extensions: readOnlyExtensions }),
      parent: this.codeEditorEl,
    });
  }

  _setCode(code) {
    this.codeView.dispatch({
      changes: { from: 0, to: this.codeView.state.doc.length, insert: code },
    });
  }

  // MARK: Helpers for building :)

  // Empty the interface and start building the shared elements (e.g., the header)
  _reset() {
    this._stopTimer();
    this.codeEditorEl.remove();
    this.pollEl.innerHTML = "";
  }

  _buildHeader() {
    // Create a header w/ a back button and a timer element (which starts out empty)
    const header = document.createElement("div");
    header.className = "poll-activity-header";
    const backBtn = document.createElement("button");
    backBtn.className = "poll-back-btn";
    backBtn.textContent = "← Back to list";
    backBtn.addEventListener("click", this._onBack);
    this._timerEl = document.createElement("div");
    this._timerEl.className = "poll-timer";
    header.appendChild(backBtn);
    header.appendChild(this._timerEl);
    this.pollEl.appendChild(header);
  }

  _buildCodeEditor(code) {
    this._setCode(code);
    this.codeEditorEl.hidden = !code;
    this.pollEl.appendChild(this.codeEditorEl);
  }

  showCreate() {
    this._reset();
    this._buildHeader();
    const selectedCode = this.getSelectedCode?.() ?? "";
    this._buildCodeEditor(selectedCode);

    const textarea = document.createElement("textarea");
    textarea.className = "poll-instructions-input";
    textarea.placeholder = "Describe the activity...";
    this._instructionsInput = textarea;
    this.pollEl.appendChild(textarea);

    const startBtn = document.createElement("button");
    startBtn.textContent = "Start Activity";
    startBtn.addEventListener("click", async () => {
      const instructions = this._instructionsInput.value.trim();
      const code = this.codeView.state.doc.toString().trim();
      await this._manager.createPollExercise({
        instructions,
        ...(code ? { instructor_code: code } : {}),
      });
    });
    this.pollEl.appendChild(startBtn);
  }

  showActive(ex) {
    this._reset();
    this._buildHeader();
    const code = ex.instructor_code ?? "";
    this._buildCodeEditor(code);

    const instructionsEl = document.createElement("div");
    instructionsEl.className = "poll-instructions-display";
    instructionsEl.textContent = ex.instructions ?? "";
    this.pollEl.appendChild(instructionsEl);

    let count = ex.ExerciseResponses.filter((r) => !r.isSimulated).length;
    this._responseCountEl = document.createElement("div");
    this._responseCountEl.className = "poll-response-count";
    this._responseCountEl.textContent = `${count} response${count !== 1 ? "s" : ""}`;
    this.pollEl.appendChild(this._responseCountEl);

    const finishBtn = document.createElement("button");
    finishBtn.textContent = "Finish";
    finishBtn.addEventListener("click", () => this._manager.finishPollExercise());
    this.pollEl.appendChild(finishBtn);

    this._startTimer(ex.start_ts);
  }

  showSummary(ex, { loading = false, groups = undefined } = {}) {
    this._reset();
    this._buildHeader();
    const code = ex.instructor_code ?? "";
    this._buildCodeEditor(code);

    const instructionsEl = document.createElement("div");
    instructionsEl.className = "poll-instructions-display";
    instructionsEl.textContent = ex.instructions ?? "";
    this.pollEl.appendChild(instructionsEl);

    this._responsesEl = document.createElement("div");
    this.pollEl.appendChild(this._responsesEl);

    if (loading) {
      const loadingEl = document.createElement("div");
      loadingEl.className = "summary-loading";
      loadingEl.textContent = "Generating summary…";
      this._responsesEl.appendChild(loadingEl);
    } else {
      const resolvedGroups = groups ?? (ex.summary ? JSON.parse(ex.summary) : null);
      renderResponsesEl(this._responsesEl, ex, resolvedGroups);
    }
  }

  updateResponses(ex, groups) {
    if (this._responsesEl) {
      this._responsesEl.innerHTML = "";
      renderResponsesEl(this._responsesEl, ex, groups);
    }
  }

  stopTimer() {
    this._stopTimer();
  }

  updateResponseCount(count) {
    if (this._responseCountEl) {
      this._responseCountEl.textContent = `${count} response${count !== 1 ? "s" : ""}`;
    }
  }

  _startTimer(startTs) {
    if (this.timerInterval) clearInterval(this.timerInterval);
    const update = () => {
      let elapsed = Math.floor((Date.now() - startTs) / 1000);
      let m = Math.floor(elapsed / 60);
      let s = elapsed % 60;
      if (this._timerEl) this._timerEl.textContent = `${m}:${String(s).padStart(2, "0")}`;
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
  constructor({ codeExerciseEl, onBack }) {
    this.codeExerciseEl = codeExerciseEl;
    this._onBack = onBack;
    this._responsesEl = null;

    const readOnlyExtensions = [
      minimalSetup,
      python(),
      EditorView.lineWrapping,
      EditorView.editable.of(false),
    ];

    this.codeEditorEl = document.createElement("div");
    this.codeView = new EditorView({
      state: EditorState.create({ doc: "", extensions: readOnlyExtensions }),
      parent: this.codeEditorEl,
    });
  }

  showSummary(ex, { loading = false, groups = undefined } = {}) {
    this.codeEditorEl.remove();
    this.codeExerciseEl.innerHTML = "";

    const code = ex.instructor_code ?? "";
    this.codeView.dispatch({
      changes: { from: 0, to: this.codeView.state.doc.length, insert: code },
    });

    const backBtn = document.createElement("button");
    backBtn.className = "poll-back-btn";
    backBtn.textContent = "← Back to list";
    backBtn.addEventListener("click", this._onBack);
    this.codeExerciseEl.appendChild(backBtn);

    this.codeEditorEl.hidden = !code;
    this.codeExerciseEl.appendChild(this.codeEditorEl);

    const instructionsEl = document.createElement("div");
    instructionsEl.className = "poll-instructions-display";
    instructionsEl.textContent = ex.instructions ?? "";
    this.codeExerciseEl.appendChild(instructionsEl);

    this._responsesEl = document.createElement("div");
    this.codeExerciseEl.appendChild(this._responsesEl);

    if (loading) {
      const loadingEl = document.createElement("div");
      loadingEl.className = "summary-loading";
      loadingEl.textContent = "Generating summary…";
      this._responsesEl.appendChild(loadingEl);
    } else {
      const resolvedGroups = groups ?? (ex.summary ? JSON.parse(ex.summary) : null);
      renderResponsesEl(this._responsesEl, ex, resolvedGroups);
    }
  }

  updateResponses(ex, groups) {
    if (this._responsesEl) {
      this._responsesEl.innerHTML = "";
      renderResponsesEl(this._responsesEl, ex, groups);
    }
  }
}

// MARK: Instructor Panel
export class InstructorActivitiesPanel {
  constructor(manager, {
    activitiesPanelEl,
    openPanel,
    getSelectedCode,
  }) {
    /** @type {InstructorActivitiesManager} */
    this.manager = manager;
    this.activitiesPanelEl = activitiesPanelEl;
    this.openPanel = openPanel;

    // DOM refs owned by this panel
    this.listEl = document.querySelector("#activities-list");
    this.listItemsEl = document.querySelector("#activities-list-items");
    this.pollEl = document.querySelector("#activities-poll");
    this.codeExerciseEl = document.querySelector("#activities-code-exercise");
    this.pollButton = document.querySelector("#poll-button");

    const onBack = () => this._showView("list");

    this.pollWidget = new PollExerciseWidget({
      manager,
      pollEl: this.pollEl,
      onBack,
      getSelectedCode,
    });
    this.codeWidget = new CodeExerciseSummaryWidget({
      codeExerciseEl: this.codeExerciseEl,
      onBack,
    });

    this.pollButton.addEventListener("click", () => {
      this.openPanel();
      this.pollWidget.showCreate();
      this._showView("poll");
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
      if (ex.type === "CODE_VARIANT") {
        this.codeWidget.updateResponses(ex, groups);
      } else {
        this.pollWidget.updateResponses(ex, groups);
      }
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
    this.pollEl.hidden = name !== "poll";
    this.codeExerciseEl.hidden = name !== "code-exercise";
    this.activitiesPanelEl.classList.toggle("has-content", true);
  }

  _showActiveView(ex) {
    this.pollWidget.showActive(ex);
    this._showView("poll");
  }

  _showSummaryView(ex, options = {}) {
    if (ex.type === "CODE_VARIANT") {
      this.codeWidget.showSummary(ex, options);
      this._showView("code-exercise");
    } else {
      this.pollWidget.showSummary(ex, options);
      this._showView("poll");
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
