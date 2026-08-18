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

export function createAnswerDisplay(answer, exerciseType, { label = "Your submission:", startExpanded = true } = {}) {
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

function mostRecentlyCreated(exercises) {
  return exercises.length
    ? exercises.reduce((a, b) => (b.start_ts > a.start_ts ? b : a))
    : null;
}

// Single-line preview text for an activity-list row: polls preview their instructions,
// code exercises (which have no instructions) preview their first non-blank line of code instead.
function activityPreviewText(ex) {
  if (ex.type === "CODE_VARIANT") {
    const code = ex.default_answer ?? "";
    const firstLine = code.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
    return firstLine ? firstLine.slice(0, 60) : "(empty code exercise)";
  }
  return ex.instructions ? ex.instructions.slice(0, 60) : "(no instructions)";
}

// Icon shown to the left of an activity-list row's preview text, indicating its type.
function activityIconHtml(ex) {
  const isPoll = ex.type === "POLL" || ex.type === "POLL_MCQ";
  return isPoll
    ? `<span class="activity-item-icon activity-item-icon-poll">?</span>`
    : `<span class="activity-item-icon activity-item-icon-code">&lt;/&gt;</span>`;
}

// True when the code an activity was anchored to has since been deleted -- a poll's anchor is
// always set at creation (poll-create-popover.js) and gets nulled out server-side once the
// anchored code is entirely deleted (see LectureSession._resolvePollAnchors); a code exercise's
// anchor is its Version Block, which is soft-deleted (not removed) when dissolved.
function isAnchorDeleted(ex) {
  const isPoll = ex.type === "POLL" || ex.type === "POLL_MCQ";
  return isPoll ? ex.code_anchor_from == null : ex.VersionBlock?.deleted === true;
}

// MARK: Student Panel
export class StudentActivitiesPanel {
  constructor(manager, { student_id, onPollPanelOpenChange, activePopover, completePopover, getAnchor, scrollToExercise, openHistoricalView }) {
    this.manager = manager;
    this.student_id = student_id;
    this.onPollPanelOpenChange = onPollPanelOpenChange;
    this._activePopover = activePopover;
    this._completePopover = completePopover;
    this._getAnchor = getAnchor;
    this._scrollToExercise = scrollToExercise;
    this._openHistoricalView = openHistoricalView;
    this._selectedActivityId = null;

    this.listEl = document.querySelector("#student-activities-list");
    this.listItemsEl = document.querySelector("#student-activities-list-items");
    this.placeholderEl = document.querySelector("#student-activities-placeholder");

    this._subscribeToManager();
    this._init();
  }

  _init() {
    const mostRecentActive = mostRecentlyCreated(
      this.manager.exercises.filter(
        (ex) => (ex.type === "POLL" || ex.type === "POLL_MCQ") && ex.end_ts == null
      )
    );
    if (mostRecentActive) {
      this._openActivePopover(mostRecentActive);
    } else {
      this._showList();
    }
    this._renderList();
  }

  _subscribeToManager() {
    this.manager.addEventListener("exerciseCreated", ({ detail: { exercise } }) => {
      this._renderList();
      if (exercise.type !== "POLL" && exercise.type !== "POLL_MCQ") return;
      this._openActivePopover(exercise);
    });

    this.manager.addEventListener("exerciseFinished", ({ detail: { exercise } }) => {
      this._renderList();
      if (exercise.type !== "POLL" && exercise.type !== "POLL_MCQ") return;
      this._openFinished(exercise);
    });

    this.manager.addEventListener("exerciseUpdated", () => {
      this._renderList();
    });
  }

  _showList() {
    this.listEl.hidden = false;
    this._notifyPollHighlight(null);
  }

  // Scrolls the anchored code into view before opening -- the poll's marker may not
  // already be on-screen (e.g. page load, or the user scrolled away since it opened).
  _openActivePopover(ex) {
    this._scrollToExercise?.(ex);
    this._activePopover.open({ exercise: ex, anchor: this._getAnchor(ex) });
    this._notifyPollHighlight(ex.id);
  }

  _openCompletePopover(ex) {
    this._completePopover.open({ exercise: ex, anchor: this._getAnchor(ex) });
    this._notifyPollHighlight(ex.id);
  }

  // Scrolls the anchored code into view, then opens the stage-3 review popover.
  _openFinished(ex) {
    this._scrollToExercise?.(ex);
    this._openCompletePopover(ex);
  }

  // Called by the complete popover when it closes itself (e.g. via its own "x").
  notifyCompletePopoverClosed() {
    this._notifyPollHighlight(null);
  }

  // Called by the active popover when it closes itself (e.g. via its own "x").
  notifyActivePopoverClosed() {
    this._notifyPollHighlight(null);
  }

  // Single choke point for "which activity is currently selected" -- keeps the sidebar row
  // highlight in lockstep with whatever id drives the gutter marker's glow.
  _notifyPollHighlight(id) {
    this._selectedActivityId = id;
    this._updateSelectedHighlight();
    this.onPollPanelOpenChange?.(id);
  }

  _updateSelectedHighlight() {
    this.listItemsEl.querySelectorAll(".activity-list-item[data-exercise-id]").forEach((el) => {
      el.classList.toggle("selected", Number(el.dataset.exerciseId) === this._selectedActivityId);
    });
  }

  // Opens the popover for a specific exercise (e.g. from clicking its code-editor gutter
  // marker) -- active exercises open the active popover, finished ones the complete popover.
  showExerciseById(id) {
    const ex = this.manager.getExercise(id);
    if (!ex) return;
    if (ex.end_ts == null) {
      this._openActivePopover(ex);
    } else {
      this._openFinished(ex);
    }
  }

  _renderList() {
    this.listItemsEl.innerHTML = "";
    const relevantExercises = this.manager.exercises.filter(
      (ex) => ex.type === "POLL" || ex.type === "POLL_MCQ" || ex.type === "CODE_VARIANT"
    );
    this.placeholderEl.hidden = relevantExercises.length > 0;
    [...relevantExercises].reverse().forEach((ex) => {
      const isPoll = ex.type === "POLL" || ex.type === "POLL_MCQ";
      const isActive = ex.end_ts == null;
      const item = document.createElement("div");
      item.className = "activity-list-item";
      item.classList.toggle("anchor-deleted", isAnchorDeleted(ex));
      const icon = activityIconHtml(ex);
      const preview = activityPreviewText(ex);
      const previewClass = ex.type === "CODE_VARIANT" ? "activity-item-preview is-code" : "activity-item-preview";
      const badge = isActive ? `<span class="activity-item-badge badge-active">Active</span>` : "";

      if (isPoll) {
        const myResponse = ex.ExerciseResponses.find((r) => r.student_id === this.student_id);
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
        item.innerHTML = `${icon}<span class="${previewClass}">${preview}</span>${badge}<span class="activity-item-answer">${answerSnippet}</span>`;
        item.dataset.exerciseId = ex.id;
        item.classList.toggle("selected", ex.id === this._selectedActivityId);
        item.addEventListener("click", () => {
          if (isAnchorDeleted(ex)) {
            this._openHistoricalView?.(ex);
          } else if (isActive) {
            this._openActivePopover(ex);
          } else {
            this._openFinished(ex);
          }
        });
      } else {
        item.innerHTML = `${icon}<span class="${previewClass}">${preview}</span>${badge}`;
        item.addEventListener("click", () => {
          if (isAnchorDeleted(ex)) {
            this._openHistoricalView?.(ex);
          } else {
            this._scrollToExercise?.(ex);
          }
        });
      }
      this.listItemsEl.appendChild(item);
    });
  }
}

// MARK: Helpers for constructing UI for the instructor

// Assigns "Anonymous student N" labels to responses with no email on file, numbered in
// the order they appear so instructors can refer to a specific one during discussion.
function computeAnonLabels(responses) {
  let labels = new Map();
  let n = 0;
  responses.forEach((r) => {
    let identifier = r.StudentSession?.student_identifier || r.student_identifier;
    if (!identifier) labels.set(r, `Anonymous student ${++n}`);
  });
  return labels;
}

// Renders a single student response element.
function renderResponseEl(response, ex, anonLabels) {
  let { student_identifier, StudentSession, answer } = response;
  let displayName =
    StudentSession?.student_identifier || student_identifier || anonLabels.get(response);
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
  let anonLabels = computeAnonLabels(ex.ExerciseResponses);
  if (!groups) {
    ex.ExerciseResponses.forEach((response) => {
      responsesEl.appendChild(renderResponseEl(response, ex, anonLabels));
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

    groupEl.appendChild(renderResponseEl(responses[0], ex, anonLabels));

    if (responses.length > 1) {
      let extraEl = document.createElement("div");
      extraEl.className = "group-extra-responses";
      extraEl.hidden = true;
      responses.slice(1).forEach((r) => {
        extraEl.appendChild(renderResponseEl(r, ex, anonLabels));
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
export class PollMcqBuilder {
  constructor(container, { onSuggest, onSubmit, renderHeader = true, renderSubmitButton = true } = {}) {
    this._container = container;
    this._onSuggest = onSuggest;
    this._onSubmit = onSubmit;
    this._renderHeader = renderHeader;
    this._renderSubmitButton = renderSubmitButton;
    this._rows = [];
    this._rowsEl = null;
    this._addBtn = null;
  }

  build() {
    const section = document.createElement("div");
    section.className = "poll-mcq-section";

    if (this._renderHeader) {
      // Header row: title + suggest button
      const header = document.createElement("div");
      header.className = "poll-mcq-header";

      const title = document.createElement("span");
      title.className = "poll-mcq-title";
      title.textContent = "(Optional) Provide Choices";

      const suggestBtn = document.createElement("button");
      suggestBtn.className = "poll-mcq-suggest-btn";
      suggestBtn.textContent = "Suggest Choices";
      suggestBtn.addEventListener("click", () => this.suggest(suggestBtn, "Suggest Choices"));

      header.appendChild(title);
      header.appendChild(suggestBtn);
      section.appendChild(header);
    }

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

    if (this._renderSubmitButton) {
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
    }

    this._container.appendChild(section);
  }

  // Runs the suggest-choices flow; optionally drives a button's disabled/loading label
  // (used by both this builder's own header button and an external caller's button).
  async suggest(buttonEl = null, restoreLabel = "Suggest Choices") {
    if (!this._onSuggest) return;
    if (buttonEl) { buttonEl.disabled = true; buttonEl.textContent = "Loading..."; }
    try {
      const choices = await this._onSuggest();
      if (choices?.length) this.setSuggestedChoices(choices);
    } finally {
      if (buttonEl) { buttonEl.disabled = false; buttonEl.textContent = restoreLabel; }
    }
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

  // Renders the full choice list read-only, bolding the respondent's own choice (no counts --
  // used for a single student's own review, as opposed to buildSummaryResults' aggregate view).
  static buildCompleteChoices(container, choices, selectedIndex) {
    const list = document.createElement("div");
    list.className = "poll-mcq-choices-display";
    choices.forEach((choice, i) => {
      const item = document.createElement("div");
      item.className = "poll-mcq-choice-item";
      const isSelected = i === selectedIndex;
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
      list.appendChild(item);
    });
    container.appendChild(list);
  }
}

// Builds a `.poll-activity-header` with a "back to list" link (left) and a "x" close button
// (right) -- shared between the poll and code-exercise summary views, which both need identical
// markup but different back/close behavior (the poll view also closes its linked popover).
function buildActivityHeader({ onBack, onClose }) {
  const header = document.createElement("div");
  header.className = "poll-activity-header";

  const backBtn = document.createElement("button");
  backBtn.className = "poll-back-btn";
  backBtn.textContent = "← Back to list";
  backBtn.addEventListener("click", () => onBack());
  header.appendChild(backBtn);

  const closeBtn = document.createElement("button");
  closeBtn.className = "poll-popover-close";
  closeBtn.textContent = "×";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.addEventListener("click", () => onClose());
  header.appendChild(closeBtn);

  return header;
}

// MARK: PollExerciseWidget
//
// Renders stage 3 (completed/summary) of a FREE-RESPONSE poll's aggregated responses in the
// sidebar -- the question and (for POLL_MCQ) results now live in InstructorPollCompletePopover
// instead (see poll-complete-popover.js); this widget is only ever shown for type "POLL".
class PollExerciseWidget {
  constructor({ pollEl, onBack, onClose }) {
    this.pollEl = pollEl;
    this._onBack = onBack;
    this._onClose = onClose;
    this._responsesEl = null;
  }

  // MARK: Helpers for building :)

  // Empty the interface and start building the shared elements (e.g., the header)
  _reset() {
    this.pollEl.innerHTML = "";
  }

  _buildHeader() {
    this.pollEl.appendChild(buildActivityHeader({ onBack: this._onBack, onClose: this._onClose }));
  }

  showSummary(ex, { loading = false, groups = undefined } = {}) {
    this._reset();
    this._buildHeader();

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
}

// MARK: CodeExerciseSummaryWidget
class CodeExerciseSummaryWidget {
  constructor({ codeExerciseEl, onBack, onClose }) {
    this.codeExerciseEl = codeExerciseEl;
    this._onBack = onBack;
    this._onClose = onClose;
    this._responsesEl = null;
  }

  showSummary(ex, { loading = false, groups = undefined } = {}) {
    this.codeExerciseEl.innerHTML = "";

    this.codeExerciseEl.appendChild(buildActivityHeader({ onBack: this._onBack, onClose: this._onClose }));

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
    closePanel,
    onPollPanelOpenChange,
    activePopover,
    completePopover,
    getAnchor,
    scrollToExercise,
    openHistoricalView,
  }) {
    /** @type {InstructorActivitiesManager} */
    this.manager = manager;
    this.activitiesPanelEl = activitiesPanelEl;
    this.openPanel = openPanel;
    this.closePanel = closePanel;
    this.onPollPanelOpenChange = onPollPanelOpenChange;
    this._activePopover = activePopover;
    this._completePopover = completePopover;
    this._getAnchor = getAnchor;
    this._scrollToExercise = scrollToExercise;
    this._openHistoricalView = openHistoricalView;
    this._currentPollId = null;
    this._activePopoverId = null;
    this._completePopoverId = null;
    this._selectedActivityId = null;

    // DOM refs owned by this panel
    this.listEl = document.querySelector("#activities-list");
    this.listItemsEl = document.querySelector("#activities-list-items");
    this.pollEl = document.querySelector("#activities-poll");
    this.codeExerciseEl = document.querySelector("#activities-code-exercise");

    const onBack = () => this._showView("list");
    // The poll summary's back also needs to close the linked complete popover -- hide the
    // sidebar first so the popover's own onClose (notifyCompletePopoverClosed) sees the sidebar
    // already hidden and doesn't redundantly re-trigger _showView.
    const onPollBack = () => {
      this._showView("list");
      this._completePopover.close();
    };
    // The "x" close button (present in all 3 views) fully closes the sidebar -- same ordering
    // as onPollBack (reset view before closing the popover) so notifyCompletePopoverClosed's own
    // guard short-circuits instead of double-firing _showView.
    const onClose = () => {
      const wasPoll = !this.pollEl.hidden;
      this._showView("list");
      if (wasPoll) this._completePopover.close();
      this.closePanel();
    };

    document.querySelector("#activities-list-close").addEventListener("click", onClose);

    this.pollSummaryWidget = new PollExerciseWidget({
      pollEl: this.pollEl,
      onBack: onPollBack,
      onClose,
    });
    this.codeWidget = new CodeExerciseSummaryWidget({
      codeExerciseEl: this.codeExerciseEl,
      onBack,
      onClose,
    });

    this.#subscribeToManager();

    const mostRecentActive = mostRecentlyCreated(
      manager.getActiveExercises().filter((ex) => ex.type === "POLL" || ex.type === "POLL_MCQ")
    );
    if (mostRecentActive) this._openActivePopover(mostRecentActive);
    this._renderList();
  }

  #subscribeToManager() {
    this.manager.addEventListener("exerciseCreated", ({ detail: { exercise } }) => {
      this._renderList();
      if (exercise.type !== "POLL" && exercise.type !== "POLL_MCQ") return;
      this._openActivePopover(exercise);
    });

    this.manager.addEventListener("exerciseFinished", ({ detail: { exercise } }) => {
      this._renderList();
      if (exercise.type === "POLL" || exercise.type === "POLL_MCQ") {
        this._openFinished(exercise, { loading: exercise.type === "POLL" });
      } else {
        this.openPanel();
        this._showSummaryView(exercise, { loading: exercise.type === "CODE_VARIANT" });
      }
    });

    this.manager.addEventListener("summaryReady", ({ detail: { exerciseId, groups } }) => {
      const ex = this.manager.getExercise(exerciseId);
      if (!ex) return;
      if (ex.type === "CODE_VARIANT") {
        this.codeWidget.updateResponses(ex, groups);
      } else {
        this.pollSummaryWidget.updateResponses(ex, groups);
      }
    });

    this.manager.addEventListener("showSummary", ({ detail: { exercise } }) => {
      this.openPanel();
      this._showSummaryView(exercise);
    });

    this.manager.addEventListener("responseReceived", ({ detail: { exercise, responseCount } }) => {
      if (this._activePopover.isOpenFor(exercise.id)) this._activePopover.updateResponseCount(responseCount);
    });

    this.manager.addEventListener("exerciseUpdated", () => {
      this._renderList();
    });
  }

  // Opens the sidebar directly to the activities list -- e.g. from the topbar's "activities
  // list" button. Deliberately doesn't touch any popover; list navigation and popover lifecycle
  // stay decoupled, same as everywhere else in this class.
  openToList() {
    this.openPanel();
    this._showView("list");
  }

  // Opens the popover/sidebar to a specific exercise regardless of active/finished state --
  // e.g. from clicking its code-editor gutter marker.
  openExercise(ex) {
    if (ex.end_ts == null) {
      this._openActivePopover(ex);
    } else {
      this._openFinished(ex);
    }
  }

  _showView(name) {
    if (name !== "code-exercise") this.manager.notifyCodeSummaryDisplayed(null);
    // if (name === "code-exercise") ==> we already notified w/ the actual exercise
    this.listEl.hidden = name !== "list";
    this.pollEl.hidden = name !== "poll";
    this.codeExerciseEl.hidden = name !== "code-exercise";
    this.activitiesPanelEl.classList.toggle("has-content", true);
    this._syncPollHighlight();
  }

  // Scrolls the anchored code into view before opening -- the poll's marker may not
  // already be on-screen (e.g. page load, or the user scrolled away since it opened).
  _openActivePopover(ex) {
    this._scrollToExercise?.(ex);
    this._activePopoverId = ex.id;
    this._activePopover.open({ exercise: ex, anchor: this._getAnchor(ex) });
    this._notifyPollHighlight(ex.id);
  }

  _openCompletePopover(ex) {
    this._completePopoverId = ex.id;
    this._completePopover.open({ exercise: ex, anchor: this._getAnchor(ex) });
    this._syncPollHighlight();
  }

  // Scrolls the anchored code into view, then opens the stage-3 review popover. For
  // free-response POLLs, also opens the (now results-only) sidebar summary; MCQ results live
  // entirely in the popover, so the sidebar panel is left untouched for those.
  _openFinished(ex, options = {}) {
    this._scrollToExercise?.(ex);
    this._openCompletePopover(ex);
    if (ex.type === "POLL") {
      this.openPanel();
      this._showSummaryView(ex, options);
    }
  }

  // Called by the complete popover when it closes itself (e.g. via its own "x"). If the
  // free-response poll summary is the sidebar's current view, close it too so the two stay
  // in sync.
  notifyCompletePopoverClosed() {
    this._completePopoverId = null;
    if (!this.pollEl.hidden) this._showView("list");
    this._syncPollHighlight();
  }

  // Called by the active popover when it closes itself (e.g. via its own "x").
  notifyActivePopoverClosed() {
    this._activePopoverId = null;
    this._syncPollHighlight();
  }

  // The editor's code-highlight for a poll should stay on as long as ANY of the active popover,
  // the complete popover, or the (free-response-only) sidebar summary is showing it -- e.g.
  // switching the sidebar to the list view while an active popover is still open elsewhere must
  // not clear its highlight.
  _syncPollHighlight() {
    const sidebarId = !this.pollEl.hidden ? this._currentPollId : null;
    this._notifyPollHighlight(this._activePopoverId ?? this._completePopoverId ?? sidebarId ?? null);
  }

  // Single choke point for "which activity is currently selected" -- keeps the sidebar row
  // highlight (which has no other way to know about popover/gutter-driven selection changes)
  // in lockstep with whatever id drives the gutter marker's glow.
  _notifyPollHighlight(id) {
    this._selectedActivityId = id;
    this._updateSelectedHighlight();
    this.onPollPanelOpenChange?.(id);
  }

  _updateSelectedHighlight() {
    this.listItemsEl.querySelectorAll(".activity-list-item[data-exercise-id]").forEach((el) => {
      el.classList.toggle("selected", Number(el.dataset.exerciseId) === this._selectedActivityId);
    });
  }

  _showSummaryView(ex, options = {}) {
    if (ex.type === "CODE_VARIANT") {
      this._currentPollId = null;
      this.manager.notifyCodeSummaryDisplayed(ex.id);
      this.codeWidget.showSummary(ex, options);
      this._showView("code-exercise");
    } else {
      this._currentPollId = ex.id;
      this.pollSummaryWidget.showSummary(ex, options);
      this._showView("poll");
    }
  }

  _renderList() {
    this.listItemsEl.innerHTML = "";
    [...this.manager.getExercises()].reverse().forEach((ex) => {
      const isPoll = ex.type === "POLL" || ex.type === "POLL_MCQ";
      if (!isPoll && ex.type !== "CODE_VARIANT") return;

      let item = document.createElement("div");
      item.className = "activity-list-item";
      item.classList.toggle("anchor-deleted", isAnchorDeleted(ex));
      let isActive = ex.end_ts == null;
      let icon = activityIconHtml(ex);
      let preview = activityPreviewText(ex);
      let previewClass = ex.type === "CODE_VARIANT" ? "activity-item-preview is-code" : "activity-item-preview";
      let badge = isActive ? `<span class="activity-item-badge badge-active">Active</span>` : "";
      item.innerHTML = `${icon}<span class="${previewClass}">${preview}</span>${badge}`;

      if (isPoll) {
        item.dataset.exerciseId = ex.id;
        item.classList.toggle("selected", ex.id === this._selectedActivityId);
        item.addEventListener("click", () => {
          if (isAnchorDeleted(ex)) {
            this._openHistoricalView?.(ex);
          } else if (isActive) {
            this._openActivePopover(ex);
          } else {
            this._openFinished(ex);
          }
        });
      } else {
        item.addEventListener("click", () => {
          if (isAnchorDeleted(ex)) {
            this._openHistoricalView?.(ex);
            return;
          }
          this._scrollToExercise?.(ex);
          this.openPanel();
          this._showSummaryView(ex);
        });
      }
      this.listItemsEl.appendChild(item);
    });
  }
}
