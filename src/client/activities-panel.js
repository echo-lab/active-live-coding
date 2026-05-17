import { EditorView, minimalSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { python } from "@codemirror/lang-python";
import { indentUnit } from "@codemirror/language";
import { keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { SOCKET_MESSAGE_TYPE } from "../shared-constants.js";
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
  constructor(manager, { student_id, openActivitiesPanel }) {
    this.manager = manager;
    this.student_id = student_id;
    this.openActivitiesPanel = openActivitiesPanel;
    this.currentExerciseId = null;

    this.listEl = document.querySelector("#student-activities-list");
    this.listItemsEl = document.querySelector("#student-activities-list-items");
    this.placeholderEl = document.querySelector("#student-activities-placeholder");
    this.exerciseEl = document.querySelector("#student-activity");

    this._subscribeToManager();
    this._init();
  }

  _init() {
    const active = this.manager.exercises.find(
      (ex) => (ex.type === "POLL" || ex.type === "POLL_MCQ") && ex.end_ts == null
    );
    if (active) {
      this.openActivitiesPanel();
      this._showExercise(active);
    } else {
      this._showList();
    }
    this._renderList();
  }

  _subscribeToManager() {
    this.manager.addEventListener("exerciseCreated", ({ detail: { exercise } }) => {
      if (exercise.type !== "POLL" && exercise.type !== "POLL_MCQ") return;
      this._renderList();
      this.openActivitiesPanel();
      this._showExercise(exercise);
    });

    this.manager.addEventListener("exerciseFinished", ({ detail: { exercise } }) => {
      if (exercise.type !== "POLL" && exercise.type !== "POLL_MCQ") return;
      this._renderList();
      if (this.currentExerciseId === exercise.id) {
        this._showExercise(exercise);
      }
    });
  }

  _showList() {
    this.currentExerciseId = null;
    this.exerciseEl.hidden = true;
    this.listEl.hidden = false;
  }

  _renderList() {
    this.listItemsEl.innerHTML = "";
    const pollExercises = this.manager.exercises.filter(
      (ex) => ex.type === "POLL" || ex.type === "POLL_MCQ"
    );
    this.placeholderEl.hidden = pollExercises.length > 0;
    [...pollExercises].reverse().forEach((ex) => {
      const myResponse = ex.ExerciseResponses.find((r) => r.student_id === this.student_id);
      const isActive = ex.end_ts == null;
      const item = document.createElement("div");
      item.className = "activity-list-item";
      const badge = isActive ? "Active" : "Done";
      const preview = ex.instructions ? ex.instructions.slice(0, 60) : "(no instructions)";
      let answerSnippet;
      if (myResponse) {
        if (ex.type === "POLL_MCQ" && ex.default_answer) {
          const choices = JSON.parse(ex.default_answer);
          const idx = parseInt(myResponse.answer, 10);
          const letter = !isNaN(idx) && choices[idx] ? String.fromCharCode(65 + idx) : "?";
          answerSnippet = ` — Choice ${letter}`;
        } else {
          answerSnippet = ` — "${myResponse.answer.slice(0, 30)}"`;
        }
      } else {
        answerSnippet = " — no answer";
      }
      item.innerHTML = `<span class="activity-item-preview">${preview}</span><span class="activity-item-badge ${isActive ? "badge-active" : "badge-done"}">${badge}</span><span class="activity-item-answer">${answerSnippet}</span>`;
      item.addEventListener("click", () => this._showExercise(ex));
      this.listItemsEl.appendChild(item);
    });
  }

  _showExercise(ex) {
    this.currentExerciseId = ex.id;
    const latestEx = this.manager.getExercise(ex.id) ?? ex;
    this.exerciseEl.innerHTML = "";
    this.listEl.hidden = true;
    this.exerciseEl.hidden = false;
    const isActive = latestEx.end_ts == null;
    const myResponse = latestEx.ExerciseResponses.find((r) => r.student_id === this.student_id);
    if (latestEx.type === "POLL") {
      isActive ? this._showPollActive(latestEx, myResponse) : this._showPollComplete(latestEx, myResponse);
    } else if (latestEx.type === "POLL_MCQ") {
      isActive ? this._showPollMcqActive(latestEx, myResponse) : this._showPollMcqComplete(latestEx, myResponse);
    }
  }

  // --- Shared helpers ---

  _buildScreenHeader() {
    const header = document.createElement("div");
    header.className = "poll-activity-header";
    const backBtn = document.createElement("button");
    backBtn.className = "poll-back-btn";
    backBtn.textContent = "← Back to list";
    backBtn.addEventListener("click", () => this._showList());
    header.appendChild(backBtn);
    this.exerciseEl.appendChild(header);
  }

  _buildCodeEditorIfPresent(code) {
    if (!code) return;
    const codeBoxEl = document.createElement("div");
    codeBoxEl.className = "poll-code-box";
    new EditorView({
      state: EditorState.create({
        doc: code,
        extensions: [minimalSetup, python(), EditorView.lineWrapping, EditorView.editable.of(false)],
      }),
      parent: codeBoxEl,
    });
    this.exerciseEl.appendChild(codeBoxEl);
  }

  _buildInstructions(text) {
    const el = document.createElement("div");
    el.className = "poll-instructions-display";
    el.textContent = text ?? "";
    this.exerciseEl.appendChild(el);
  }

  _updateLocalResponse(ex, answer) {
    const managerEx = this.manager.getExercise(ex.id);
    if (!managerEx) return;
    const idx = managerEx.ExerciseResponses.findIndex((r) => r.student_id === this.student_id);
    if (idx >= 0) {
      managerEx.ExerciseResponses[idx].answer = answer;
    } else {
      managerEx.ExerciseResponses.push({ student_id: this.student_id, answer });
    }
  }

  // --- Screen 2: POLL active ---

  _showPollActive(ex, myResponse) {
    this._buildScreenHeader();
    this._buildCodeEditorIfPresent(ex.instructor_code);
    this._buildInstructions(ex.instructions);

    if (myResponse) {
      const submittedEl = document.createElement("div");
      submittedEl.appendChild(
        createAnswerDisplay(myResponse.answer, "POLL", { label: "Your answer:", startExpanded: true })
      );
      this.exerciseEl.appendChild(submittedEl);
    }

    const textarea = document.createElement("textarea");
    textarea.className = "poll-instructions-input";
    textarea.placeholder = "Your answer...";
    textarea.maxLength = 500;
    textarea.value = myResponse?.answer ?? "";
    this.exerciseEl.appendChild(textarea);

    const submitBtn = document.createElement("button");
    submitBtn.className = "poll-submit-btn";
    submitBtn.textContent = myResponse ? "Resubmit" : "Submit";
    submitBtn.addEventListener("click", async () => {
      const answer = textarea.value.trim();
      if (!answer) return;
      submitBtn.disabled = true;
      try {
        await this.manager.submitResponse({ exerciseId: ex.id, answer });
        this._updateLocalResponse(ex, answer);
        this._renderList();
        this._showExercise(ex);
      } catch (e) {
        alert(e.message);
      } finally {
        submitBtn.disabled = false;
      }
    });
    this.exerciseEl.appendChild(submitBtn);
  }

  // --- Screen 3: POLL complete ---

  _showPollComplete(ex, myResponse) {
    this._buildScreenHeader();
    this._buildCodeEditorIfPresent(ex.instructor_code);
    this._buildInstructions(ex.instructions);

    if (myResponse) {
      const submittedEl = document.createElement("div");
      submittedEl.appendChild(
        createAnswerDisplay(myResponse.answer, "POLL", { label: "Your answer:", startExpanded: true })
      );
      this.exerciseEl.appendChild(submittedEl);
    } else {
      const noAnswerEl = document.createElement("div");
      noAnswerEl.className = "no-answer-message";
      noAnswerEl.textContent = "You didn't submit an answer.";
      this.exerciseEl.appendChild(noAnswerEl);
    }
  }

  // --- Screen 4: POLL_MCQ active ---

  _showPollMcqActive(ex, myResponse) {
    this._buildScreenHeader();
    this._buildCodeEditorIfPresent(ex.instructor_code);
    this._buildInstructions(ex.instructions);

    const choices = ex.default_answer ? JSON.parse(ex.default_answer) : [];
    const selectedIndex = myResponse ? parseInt(myResponse.answer, 10) : null;

    const choicesEl = document.createElement("div");
    choicesEl.className = "poll-mcq-choices-display";

    choices.forEach((choice, i) => {
      const item = document.createElement("div");
      item.className = "poll-mcq-choice-item";
      item.style.cursor = "pointer";

      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = `mcq-${ex.id}`;
      radio.value = String(i);
      radio.checked = selectedIndex === i;
      radio.style.flexShrink = "0";
      radio.style.marginRight = "6px";

      const label = document.createElement("span");
      label.className = "poll-mcq-choice-label";
      label.textContent = String.fromCharCode(65 + i) + ".";

      const text = document.createElement("span");
      text.className = "poll-mcq-choice-text";
      text.textContent = choice;

      item.addEventListener("click", () => { radio.checked = true; });

      item.appendChild(radio);
      item.appendChild(label);
      item.appendChild(text);
      if (selectedIndex === i) {
        const yourAnswerEl = document.createElement("span");
        yourAnswerEl.className = "your-answer-label";
        yourAnswerEl.textContent = "(your answer)";
        yourAnswerEl.style.color = "var(--color-active, #2e7d32)";
        yourAnswerEl.style.marginLeft = "8px";
        item.appendChild(yourAnswerEl);
      }
      choicesEl.appendChild(item);
    });
    this.exerciseEl.appendChild(choicesEl);

    const submitBtn = document.createElement("button");
    submitBtn.className = "poll-submit-btn";
    submitBtn.textContent = myResponse ? "Change Answer" : "Submit";
    submitBtn.addEventListener("click", async () => {
      const checked = choicesEl.querySelector(`input[name="mcq-${ex.id}"]:checked`);
      if (!checked) return;
      const answer = checked.value;
      submitBtn.disabled = true;
      try {
        await this.manager.submitResponse({ exerciseId: ex.id, answer });
        this._updateLocalResponse(ex, answer);
        this._renderList();
        this._showExercise(ex);
      } catch (e) {
        alert(e.message);
      } finally {
        submitBtn.disabled = false;
      }
    });
    this.exerciseEl.appendChild(submitBtn);
  }

  // --- Screen 5: POLL_MCQ complete ---

  _showPollMcqComplete(ex, myResponse) {
    this._buildScreenHeader();
    this._buildCodeEditorIfPresent(ex.instructor_code);
    this._buildInstructions(ex.instructions);

    const choices = ex.default_answer ? JSON.parse(ex.default_answer) : [];

    if (myResponse) {
      const selectedIdx = parseInt(myResponse.answer, 10);
      const choicesEl = document.createElement("div");
      choicesEl.className = "poll-mcq-choices-display";

      choices.forEach((choice, i) => {
        const item = document.createElement("div");
        item.className = "poll-mcq-choice-item";
        const isSelected = i === selectedIdx;
        if (isSelected) {
          item.style.fontWeight = "600";
        }

        const label = document.createElement("span");
        label.className = "poll-mcq-choice-label";
        label.textContent = String.fromCharCode(65 + i) + ".";

        const text = document.createElement("span");
        text.className = "poll-mcq-choice-text";
        text.textContent = choice;

        item.appendChild(label);
        item.appendChild(text);
        if (isSelected) {
          const yourAnswerEl = document.createElement("span");
          yourAnswerEl.className = "your-answer-label";
          yourAnswerEl.textContent = "(your answer)";
          yourAnswerEl.style.color = "var(--color-active, #2e7d32)";
          yourAnswerEl.style.marginLeft = "8px";
          item.appendChild(yourAnswerEl);
        }
        choicesEl.appendChild(item);
      });
      this.exerciseEl.appendChild(choicesEl);
    } else {
      const noAnswerEl = document.createElement("div");
      noAnswerEl.className = "no-answer-message";
      noAnswerEl.textContent = "You didn't submit an answer.";
      this.exerciseEl.appendChild(noAnswerEl);
    }
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

// MARK: PollMcqBuilder
class PollMcqBuilder {
  constructor(container, { onSuggest, onSubmit } = {}) {
    this._container = container;
    this._onSuggest = onSuggest;
    this._onSubmit = onSubmit;
    this._rows = [];
    this._rowsEl = null;
    this._addBtn = null;
  }

  build() {
    const section = document.createElement("div");
    section.className = "poll-mcq-section";

    // Header row: title + suggest button
    const header = document.createElement("div");
    header.className = "poll-mcq-header";

    const title = document.createElement("span");
    title.className = "poll-mcq-title";
    title.textContent = "(Optional) Provide Choices";

    const suggestBtn = document.createElement("button");
    suggestBtn.className = "poll-mcq-suggest-btn";
    suggestBtn.textContent = "Suggest Choices";
    suggestBtn.addEventListener("click", async () => {
      if (!this._onSuggest) return;
      suggestBtn.disabled = true;
      suggestBtn.textContent = "Loading...";
      try {
        const choices = await this._onSuggest();
        if (choices?.length) this.setSuggestedChoices(choices);
      } finally {
        suggestBtn.disabled = false;
        suggestBtn.textContent = "Suggest Choices";
      }
    });

    header.appendChild(title);
    header.appendChild(suggestBtn);
    section.appendChild(header);

    // Rows container
    this._rowsEl = document.createElement("div");
    this._rowsEl.className = "poll-mcq-rows";
    section.appendChild(this._rowsEl);

    // Start with 2 rows
    this._addRowInternal();
    this._addRowInternal();

    // Footer: add + clear
    const footer = document.createElement("div");
    footer.className = "poll-mcq-footer";

    const addBtn = document.createElement("button");
    addBtn.className = "poll-mcq-add-btn";
    addBtn.textContent = "+ Add choice";
    addBtn.addEventListener("click", () => {
      this._addRowInternal();
      this._reindex();
      this._updateAddBtn();
    });
    this._addBtn = addBtn;

    const clearBtn = document.createElement("button");
    clearBtn.className = "poll-mcq-clear-btn";
    clearBtn.textContent = "Clear All";
    clearBtn.addEventListener("click", () => this._clearAll());

    footer.appendChild(addBtn);
    footer.appendChild(clearBtn);
    section.appendChild(footer);

    const submitBtn = document.createElement("button");
    submitBtn.className = "poll-mcq-submit-btn";
    submitBtn.textContent = "Ask as Multiple Choice";
    submitBtn.addEventListener("click", async () => {
      if (!this._onSubmit) return;
      const choices = this.getAnswers();
      if (choices.length < 2) { alert("Please provide at least 2 choices."); return; }
      submitBtn.disabled = true;
      try { await this._onSubmit(choices); } finally { submitBtn.disabled = false; }
    });
    section.appendChild(submitBtn);

    this._container.appendChild(section);
  }

  _addRowInternal() {
    const index = this._rows.length;

    const rowEl = document.createElement("div");
    rowEl.className = "poll-mcq-row";

    const label = document.createElement("span");
    label.className = "poll-mcq-label";
    label.textContent = String.fromCharCode(65 + index);

    const input = document.createElement("textarea");
    input.className = "poll-mcq-input";
    input.placeholder = `Choice ${String.fromCharCode(65 + index)}`;

    rowEl.appendChild(label);
    rowEl.appendChild(input);

    if (index >= 2) {
      const removeBtn = document.createElement("button");
      removeBtn.className = "poll-mcq-remove-btn";
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", () => this._removeRow(rowEl));
      rowEl.appendChild(removeBtn);
    }

    this._rowsEl.appendChild(rowEl);
    this._rows.push({ rowEl, labelEl: label, inputEl: input });
  }

  _removeRow(rowEl) {
    const idx = this._rows.findIndex((r) => r.rowEl === rowEl);
    if (idx < 2) return;
    rowEl.remove();
    this._rows.splice(idx, 1);
    this._reindex();
    this._updateAddBtn();
  }

  _reindex() {
    this._rows.forEach(({ labelEl, inputEl }, i) => {
      const letter = String.fromCharCode(65 + i);
      labelEl.textContent = letter;
      inputEl.placeholder = `Choice ${letter}`;
    });
  }

  _updateAddBtn() {
    if (this._addBtn) this._addBtn.style.visibility = this._rows.length >= 5 ? "hidden" : "";
  }

  _clearAll() {
    const extras = this._rows.splice(2);
    extras.forEach(({ rowEl }) => rowEl.remove());
    this._rows.forEach(({ inputEl }) => (inputEl.value = ""));
    this._reindex();
    this._updateAddBtn();
  }

  getAnswers() {
    return this._rows.map(({ inputEl }) => inputEl.value.trim()).filter(Boolean);
  }

  setSuggestedChoices(choices) {
    this._clearAll();
    choices.slice(0, 5).forEach((choice, i) => {
      if (i >= this._rows.length) this._addRowInternal();
      this._rows[i].inputEl.value = choice.replaceAll('\\n', '\n');
    });
    this._updateAddBtn();
  }

  static buildActiveChoices(container, choices) {
    const list = document.createElement("div");
    list.className = "poll-mcq-choices-display";
    choices.forEach((choice, i) => {
      const item = document.createElement("div");
      item.className = "poll-mcq-choice-item";
      const label = document.createElement("span");
      label.className = "poll-mcq-choice-label";
      label.textContent = String.fromCharCode(65 + i) + ".";
      const text = document.createElement("span");
      text.className = "poll-mcq-choice-text";
      text.textContent = choice;
      item.appendChild(label);
      item.appendChild(text);
      list.appendChild(item);
    });
    container.appendChild(list);
  }

  static buildSummaryResults(container, choices, responses) {
    const counts = new Array(choices.length).fill(0);
    let total = 0;
    responses.forEach((r) => {
      const idx = parseInt(r.answer, 10);
      if (!isNaN(idx) && idx >= 0 && idx < choices.length) {
        counts[idx]++;
        total++;
      }
    });

    const list = document.createElement("div");
    list.className = "poll-mcq-results";
    choices.forEach((choice, i) => {
      const item = document.createElement("div");
      item.className = "poll-mcq-result-item";
      const count = counts[i];
      const pct = total > 0 ? Math.round((count / total) * 100) : 0;
      const label = document.createElement("span");
      label.className = "poll-mcq-choice-label";
      label.textContent = String.fromCharCode(65 + i) + ".";
      const text = document.createElement("span");
      text.className = "poll-mcq-choice-text";
      text.textContent = choice;
      const countEl = document.createElement("span");
      countEl.className = "poll-mcq-result-count";
      countEl.textContent = `${count} response${count !== 1 ? "s" : ""} (${pct}%)`;
      item.appendChild(label);
      item.appendChild(text);
      item.appendChild(countEl);
      list.appendChild(item);
    });
    container.appendChild(list);
  }
}

// MARK: PollExerciseWidget
class PollExerciseWidget {
  constructor({ manager, pollEl, onBack, getSelectedCode, getCurrentCode }) {
    this.pollEl = pollEl;
    this.timerInterval = null;
    this.getSelectedCode = getSelectedCode;
    this.getCurrentCode = getCurrentCode;
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
    this._headerRightEl = document.createElement("div");
    this._headerRightEl.className = "poll-header-right";
    this._headerRightEl.appendChild(this._timerEl);
    header.appendChild(backBtn);
    header.appendChild(this._headerRightEl);
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
    startBtn.textContent = "Ask as Free Response";
    startBtn.className = "poll-submit-btn";
    startBtn.addEventListener("click", async () => {
      const instructions = this._instructionsInput.value.trim();
      const code = this.codeView.state.doc.toString().trim();
      await this._manager.createPollExercise({
        instructions,
        ...(code ? { instructor_code: code } : {}),
        full_instructor_code: this.getCurrentCode?.(),
      });
    });
    this.pollEl.appendChild(startBtn);

    new PollMcqBuilder(this.pollEl, {
      onSuggest: async () => {
        const instructions = this._instructionsInput.value.trim();
        const code = this.codeView.state.doc.toString().trim();
        return this._manager.suggestMcqChoices({
          instructions,
          instructor_code: code || null,
          full_instructor_code: this.getCurrentCode?.(),
        });
      },
      onSubmit: async (choices) => {
        const instructions = this._instructionsInput.value.trim();
        const code = this.codeView.state.doc.toString().trim();
        await this._manager.createPollMcqExercise({
          instructions,
          ...(code ? { instructor_code: code } : {}),
          full_instructor_code: this.getCurrentCode?.(),
          choices,
        });
      },
    }).build();
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

    if (ex.type === "POLL_MCQ" && ex.default_answer) {
      PollMcqBuilder.buildActiveChoices(this.pollEl, JSON.parse(ex.default_answer));
    }

    let count = ex.ExerciseResponses.filter((r) => !r.isSimulated).length;
    this._responseCountEl = document.createElement("div");
    this._responseCountEl.className = "poll-response-count";
    this._responseCountEl.textContent = `Responses so far: ${count}`;
    this.pollEl.appendChild(this._responseCountEl);

    const finishBtn = document.createElement("button");
    finishBtn.textContent = "Finish";
    finishBtn.className = "poll-finish-button";
    finishBtn.addEventListener("click", () => this._manager.finishPollExercise());
    this._headerRightEl.appendChild(finishBtn);

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

    if (ex.type === "POLL_MCQ") {
      const choices = ex.default_answer ? JSON.parse(ex.default_answer) : [];
      PollMcqBuilder.buildSummaryResults(this._responsesEl, choices, ex.ExerciseResponses ?? []);
    } else if (loading) {
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
      if (ex.type === "POLL_MCQ") {
        const choices = ex.default_answer ? JSON.parse(ex.default_answer) : [];
        PollMcqBuilder.buildSummaryResults(this._responsesEl, choices, ex.ExerciseResponses ?? []);
      } else {
        renderResponsesEl(this._responsesEl, ex, groups);
      }
    }
  }

  stopTimer() {
    this._stopTimer();
  }

  updateResponseCount(count) {
    if (this._responseCountEl) {
      this._responseCountEl.textContent = `Responses so far: ${count}`;
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
  }

  showSummary(ex, { loading = false, groups = undefined } = {}) {
    this.codeExerciseEl.innerHTML = "";

    const backBtn = document.createElement("button");
    backBtn.className = "poll-back-btn";
    backBtn.textContent = "← Back to list";
    backBtn.addEventListener("click", this._onBack);
    this.codeExerciseEl.appendChild(backBtn);

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
    getCurrentCode,
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
      getCurrentCode,
    });
    this.codeWidget = new CodeExerciseSummaryWidget({
      codeExerciseEl: this.codeExerciseEl,
      onBack,
    });

    this.pollButton.addEventListener("click", () => {
      this.openPollCreate();
    });

    this.#subscribeToManager();

    for (let ex of manager.getActiveExercises()) {
      if (ex.type === "POLL" || ex.type === "POLL_MCQ") {
        this.openPanel();
        this._showActiveView(ex);
        break;
      }
    }
    this._renderList();
  }

  #subscribeToManager() {
    this.manager.addEventListener("exerciseCreated", ({ detail: { exercise } }) => {
      if (exercise.type !== "POLL" && exercise.type !== "POLL_MCQ") return;
      this.openPanel();
      this._renderList();
      this._showActiveView(exercise);
    });

    this.manager.addEventListener("exerciseFinished", ({ detail: { exercise } }) => {
      if (exercise.type === "POLL" || exercise.type === "POLL_MCQ") this.pollWidget.stopTimer();
      this.openPanel();
      this._renderList();
      this._showSummaryView(exercise, { loading: exercise.type === "POLL" || exercise.type === "CODE_VARIANT" });
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

  openPollCreate() {
    this.openPanel();
    this.pollWidget.showCreate();
    this._showView("poll");
  }

  openActivePoll(exercise) {
    this.openPanel();
    this._showActiveView(exercise);
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
      if (ex.type !== "POLL" && ex.type !== "POLL_MCQ") return;

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
