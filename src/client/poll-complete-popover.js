import { PollMcqBuilder, createAnswerDisplay } from "./activities-panel.js";
import { positionPopover } from "./popover-position.js";

// MARK: Shared building blocks

function buildHeader(title, onClose) {
  const header = document.createElement("div");
  header.className = "poll-popover-header";

  const titleEl = document.createElement("span");
  titleEl.className = "poll-popover-title";
  titleEl.textContent = title;

  const closeBtn = document.createElement("button");
  closeBtn.className = "poll-popover-close";
  closeBtn.textContent = "×";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.addEventListener("click", onClose);

  header.appendChild(titleEl);
  header.appendChild(closeBtn);
  return header;
}

function noAnswerEl() {
  const el = document.createElement("div");
  el.className = "no-answer-message";
  el.textContent = "You didn't submit an answer.";
  return el;
}

// MARK: InstructorPollCompletePopover
//
// Floating popover for stage 3 (complete/review) of a poll exercise, on the instructor's side.
// Always shows the original question. For POLL_MCQ it also shows the aggregate results (which
// no longer appear in the sidebar at all); for free-response POLL it shows only the question --
// the sidebar (PollExerciseWidget in activities-panel.js) shows the aggregated responses instead.
export class InstructorPollCompletePopover {
  constructor({ showPollPopover, hidePollPopover, onClose }) {
    this._showPollPopover = showPollPopover;
    this._hidePollPopover = hidePollPopover;
    this._onClose = onClose;
    this._rootEl = null;
    this._anchorKey = null;
    this._exerciseId = null;
  }

  isOpenFor(id) {
    return this._rootEl != null && this._exerciseId === id;
  }

  open({ exercise, anchor }) {
    if (this.isOpenFor(exercise.id)) return;
    this.close();
    this._exerciseId = exercise.id;
    if (anchor?.kind === "code") {
      this._anchorKey = `complete:${exercise.id}`;
      this._showPollPopover({
        key: this._anchorKey,
        at: anchor.at,
        getRange: anchor.getRange,
        mount: (containerEl) => this._build(exercise, { container: containerEl, anchored: true }),
        unmount: () => {},
      });
    } else {
      this._build(exercise);
      positionPopover(this._rootEl, anchor?.rect);
    }
  }

  close() {
    if (!this._rootEl) return;
    const anchorKey = this._anchorKey;
    const rootEl = this._rootEl;
    this._rootEl = null;
    this._anchorKey = null;
    this._exerciseId = null;
    if (anchorKey) this._hidePollPopover(anchorKey);
    else rootEl.remove();
    this._onClose?.();
  }

  _build(exercise, { container = document.body, anchored = false } = {}) {
    const root = document.createElement("div");
    const isSingleLine = !(exercise.instructor_code ?? "").includes("\n");
    root.className =
      "poll-popover poll-popover--complete" +
      (anchored ? " poll-popover--anchored" : "") +
      (anchored && isSingleLine ? " single-line" : "");
    root.setAttribute("role", "dialog");

    const arrow = document.createElement("div");
    arrow.className = "poll-popover-arrow";
    root.appendChild(arrow);

    root.appendChild(buildHeader("Poll", () => this.close()));

    const instructionsEl = document.createElement("div");
    instructionsEl.className = "poll-instructions-display";
    instructionsEl.textContent = exercise.instructions ?? "";
    root.appendChild(instructionsEl);

    if (exercise.type === "POLL_MCQ") {
      const choices = exercise.default_answer ? JSON.parse(exercise.default_answer) : [];
      PollMcqBuilder.buildSummaryResults(root, choices, exercise.ExerciseResponses ?? []);
    }

    container.appendChild(root);
    this._rootEl = root;
  }
}

// MARK: StudentPollCompletePopover
//
// Floating popover for stage 3 (complete/review) of a poll exercise, on the student's side.
// Shows the question and the student's own answer/choice, read-only.
export class StudentPollCompletePopover {
  constructor({ student_id, showPollPopover, hidePollPopover, onClose }) {
    this._student_id = student_id;
    this._showPollPopover = showPollPopover;
    this._hidePollPopover = hidePollPopover;
    this._onClose = onClose;
    this._rootEl = null;
    this._anchorKey = null;
    this._exerciseId = null;
  }

  isOpenFor(id) {
    return this._rootEl != null && this._exerciseId === id;
  }

  open({ exercise, anchor }) {
    if (this.isOpenFor(exercise.id)) return;
    this.close();
    this._exerciseId = exercise.id;
    if (anchor?.kind === "code") {
      this._anchorKey = `complete:${exercise.id}`;
      this._showPollPopover({
        key: this._anchorKey,
        at: anchor.at,
        getRange: anchor.getRange,
        mount: (containerEl) => this._build(exercise, { container: containerEl, anchored: true }),
        unmount: () => {},
      });
    } else {
      this._build(exercise);
      positionPopover(this._rootEl, anchor?.rect);
    }
  }

  close() {
    if (!this._rootEl) return;
    const anchorKey = this._anchorKey;
    const rootEl = this._rootEl;
    this._rootEl = null;
    this._anchorKey = null;
    this._exerciseId = null;
    if (anchorKey) this._hidePollPopover(anchorKey);
    else rootEl.remove();
    this._onClose?.();
  }

  _myResponse(exercise) {
    return exercise.ExerciseResponses.find((r) => r.student_id === this._student_id);
  }

  _build(exercise, { container = document.body, anchored = false } = {}) {
    const root = document.createElement("div");
    const isSingleLine = !(exercise.instructor_code ?? "").includes("\n");
    root.className =
      "poll-popover poll-popover--complete" +
      (anchored ? " poll-popover--anchored" : "") +
      (anchored && isSingleLine ? " single-line" : "");
    root.setAttribute("role", "dialog");

    const arrow = document.createElement("div");
    arrow.className = "poll-popover-arrow";
    root.appendChild(arrow);

    root.appendChild(buildHeader("Poll", () => this.close()));

    const instructionsEl = document.createElement("div");
    instructionsEl.className = "poll-instructions-display";
    instructionsEl.textContent = exercise.instructions ?? "";
    root.appendChild(instructionsEl);

    const myResponse = this._myResponse(exercise);
    if (exercise.type === "POLL_MCQ") {
      const choices = exercise.default_answer ? JSON.parse(exercise.default_answer) : [];
      if (myResponse) {
        PollMcqBuilder.buildCompleteChoices(root, choices, parseInt(myResponse.answer, 10));
      } else {
        root.appendChild(noAnswerEl());
      }
    } else if (myResponse) {
      root.appendChild(createAnswerDisplay(myResponse.answer, "POLL", { label: "Your answer:", startExpanded: true }));
    } else {
      root.appendChild(noAnswerEl());
    }

    container.appendChild(root);
    this._rootEl = root;
  }
}
