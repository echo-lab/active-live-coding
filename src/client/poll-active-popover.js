import { PollMcqBuilder } from "./activities-panel.js";
import { positionPopover } from "./popover-position.js";

// MARK: Shared building blocks

function buildLiveHeader(onClose) {
  const header = document.createElement("div");
  header.className = "poll-popover-live-header";

  const badge = document.createElement("span");
  badge.className = "poll-popover-live-badge";
  const dot = document.createElement("span");
  dot.className = "poll-popover-live-dot";
  const label = document.createElement("span");
  label.className = "poll-popover-live-label";
  label.textContent = "Live poll";
  badge.appendChild(dot);
  badge.appendChild(label);
  header.appendChild(badge);

  const right = document.createElement("div");
  right.className = "poll-popover-live-right";
  header.appendChild(right);

  const closeBtn = document.createElement("button");
  closeBtn.className = "poll-popover-close";
  closeBtn.textContent = "×";
  closeBtn.setAttribute("aria-label", "Dismiss");
  closeBtn.addEventListener("click", onClose);

  return { header, right, closeBtn };
}

// MARK: InstructorActivePollPopover
//
// Floating popover for stage 2 (active/awaiting responses) of a poll exercise, on the
// instructor's side. Anchored beside the linked code for code-anchored polls; if the anchor was
// later invalidated by the instructor deleting the anchored code, falls back to a fixed rect near
// the code editor pane (see InstructorActivitiesPanel's getAnchor). Stays open for as long as the
// poll is active; only closes when the poll finishes or a new one replaces it.
export class InstructorActivePollPopover {
  constructor({ manager, showPollPopover, hidePollPopover, coordinator, onClose }) {
    this._manager = manager;
    this._showPollPopover = showPollPopover;
    this._hidePollPopover = hidePollPopover;
    this._coordinator = coordinator;
    this._onClose = onClose;
    this._rootEl = null;
    this._anchorKey = null;
    this._exerciseId = null;
    this._responseCountEl = null;
    this._timerEl = null;
    this._timerInterval = null;
  }

  isOpenFor(id) {
    return this._rootEl != null && this._exerciseId === id;
  }

  // `anchor` is either `{kind: "code", at, getRange}` (a live doc position, plus a live
  // `() => {from, to}` getter for fitting the popover beside the widest anchored line) or
  // `{kind: "standalone", rect}` (the anchor was invalidated after the anchored code was
  // deleted).
  open({ exercise, anchor }) {
    if (this.isOpenFor(exercise.id)) return;
    this.close();
    this._coordinator?.notifyOpening(this);
    this._exerciseId = exercise.id;
    if (anchor?.kind === "code") {
      this._anchorKey = `active:${exercise.id}`;
      this._showPollPopover({
        key: this._anchorKey,
        at: anchor.at,
        getRange: anchor.getRange,
        mount: (containerEl) => this._build(exercise, { container: containerEl, anchored: true }),
        unmount: () => this._stopTimer(),
      });
    } else {
      this._build(exercise);
      positionPopover(this._rootEl, anchor?.rect);
    }
    this._startTimer(exercise.start_ts);
  }

  close() {
    this._coordinator?.notifyClosed(this);
    if (!this._rootEl) return;
    const anchorKey = this._anchorKey;
    const rootEl = this._rootEl;
    this._rootEl = null;
    this._anchorKey = null;
    this._exerciseId = null;
    this._responseCountEl = null;
    this._timerEl = null;
    if (anchorKey) {
      this._hidePollPopover(anchorKey); // synchronously triggers unmount() -> _stopTimer()
    } else {
      this._stopTimer();
      rootEl.remove();
    }
    this._onClose?.();
  }

  updateResponseCount(count) {
    if (this._responseCountEl) this._responseCountEl.textContent = `Responses so far: ${count}`;
  }

  _build(exercise, { container = document.body, anchored = false } = {}) {
    const root = document.createElement("div");
    const isSingleLine = !(exercise.instructor_code ?? "").includes("\n");
    root.className =
      "poll-popover poll-popover--active" +
      (anchored ? " poll-popover--anchored" : "") +
      (anchored && isSingleLine ? " single-line" : "");
    root.setAttribute("role", "dialog");

    const arrow = document.createElement("div");
    arrow.className = "poll-popover-arrow";
    root.appendChild(arrow);

    const { header, right, closeBtn } = buildLiveHeader(() => this.close());
    this._timerEl = document.createElement("span");
    this._timerEl.className = "poll-popover-timer";
    right.appendChild(this._timerEl);
    right.appendChild(closeBtn);
    root.appendChild(header);

    const instructionsEl = document.createElement("div");
    instructionsEl.className = "poll-instructions-display";
    instructionsEl.textContent = exercise.instructions ?? "";
    root.appendChild(instructionsEl);

    if (exercise.type === "POLL_MCQ" && exercise.default_answer) {
      PollMcqBuilder.buildActiveChoices(root, JSON.parse(exercise.default_answer));
    }

    const footer = document.createElement("div");
    footer.className = "poll-popover-footer";

    const count = exercise.ExerciseResponses.filter((r) => !r.isSimulated).length;
    this._responseCountEl = document.createElement("span");
    this._responseCountEl.className = "poll-response-count";
    this._responseCountEl.textContent = `Responses so far: ${count}`;
    footer.appendChild(this._responseCountEl);

    const finishBtn = document.createElement("button");
    finishBtn.className = "poll-popover-finish-btn";
    finishBtn.textContent = "Finish";
    finishBtn.addEventListener("click", () => this._manager.finishExercise(exercise.id));
    footer.appendChild(finishBtn);

    root.appendChild(footer);

    container.appendChild(root);
    this._rootEl = root;
  }

  _startTimer(startTs) {
    const update = () => {
      const elapsed = Math.floor((Date.now() - startTs) / 1000);
      const m = Math.floor(elapsed / 60);
      const s = elapsed % 60;
      if (this._timerEl) this._timerEl.textContent = `${m}:${String(s).padStart(2, "0")}`;
    };
    update();
    this._timerInterval = setInterval(update, 1000);
  }

  _stopTimer() {
    clearInterval(this._timerInterval);
    this._timerInterval = null;
  }
}

// MARK: StudentActivePollPopover
//
// Floating popover for stage 2 (active/awaiting responses) of a poll exercise, on the student's
// side. Anchored beside the linked code for code-anchored polls, or a fixed point supplied by
// the caller for standalone polls (students have no "poll" button to anchor to).
export class StudentActivePollPopover {
  constructor({ manager, student_id, showPollPopover, hidePollPopover, coordinator, onClose }) {
    this._manager = manager;
    this._student_id = student_id;
    this._showPollPopover = showPollPopover;
    this._hidePollPopover = hidePollPopover;
    this._coordinator = coordinator;
    this._onClose = onClose;
    this._rootEl = null;
    this._anchorKey = null;
    this._exerciseId = null;
  }

  isOpenFor(id) {
    return this._rootEl != null && this._exerciseId === id;
  }

  // `anchor` is either `{kind: "code", at, getRange}` (a live doc position, plus a live
  // `() => {from, to}` getter for fitting the popover beside the widest anchored line) or
  // `{kind: "standalone", rect}` (a fixed screen rect -- students have no button to anchor to).
  open({ exercise, anchor }) {
    if (this.isOpenFor(exercise.id)) return;
    this.close();
    this._coordinator?.notifyOpening(this);
    this._exerciseId = exercise.id;
    if (anchor?.kind === "code") {
      this._anchorKey = `active:${exercise.id}`;
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
    this._coordinator?.notifyClosed(this);
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

  _updateLocalResponse(exercise, answer) {
    const managerEx = this._manager.getExercise(exercise.id);
    if (!managerEx) return;
    const idx = managerEx.ExerciseResponses.findIndex((r) => r.student_id === this._student_id);
    if (idx >= 0) {
      managerEx.ExerciseResponses[idx].answer = answer;
    } else {
      managerEx.ExerciseResponses.push({ student_id: this._student_id, answer });
    }
  }

  _build(exercise, { container = document.body, anchored = false } = {}) {
    const root = document.createElement("div");
    const isSingleLine = !(exercise.instructor_code ?? "").includes("\n");
    root.className =
      "poll-popover poll-popover--active" +
      (anchored ? " poll-popover--anchored" : "") +
      (anchored && isSingleLine ? " single-line" : "");
    root.setAttribute("role", "dialog");

    const arrow = document.createElement("div");
    arrow.className = "poll-popover-arrow";
    root.appendChild(arrow);

    const { header, right, closeBtn } = buildLiveHeader(() => this.close());
    right.appendChild(closeBtn);
    root.appendChild(header);

    const instructionsEl = document.createElement("div");
    instructionsEl.className = "poll-instructions-display";
    instructionsEl.textContent = exercise.instructions ?? "";
    root.appendChild(instructionsEl);

    const myResponse = this._myResponse(exercise);
    if (exercise.type === "POLL_MCQ") {
      this._buildMcqAnswer(root, exercise, myResponse);
    } else {
      this._buildTextAnswer(root, exercise, myResponse);
    }

    container.appendChild(root);
    this._rootEl = root;
  }

  _buildTextAnswer(root, exercise, myResponse) {
    const textarea = document.createElement("textarea");
    textarea.className = "poll-instructions-input";
    textarea.placeholder = "Your answer...";
    textarea.maxLength = 500;
    textarea.value = myResponse?.answer ?? "";
    root.appendChild(textarea);

    const submitBtn = document.createElement("button");
    submitBtn.className = "poll-popover-submit-btn";
    submitBtn.textContent = myResponse ? "Resubmit" : "Submit";
    submitBtn.addEventListener("click", async () => {
      const answer = textarea.value.trim();
      if (!answer) return;
      submitBtn.disabled = true;
      try {
        await this._manager.submitResponse({ exerciseId: exercise.id, answer });
        this._updateLocalResponse(exercise, answer);
        submitBtn.textContent = "Resubmit";
      } catch (e) {
        alert(e.message);
      } finally {
        submitBtn.disabled = false;
      }
    });
    root.appendChild(submitBtn);
  }

  _buildMcqAnswer(root, exercise, myResponse) {
    const choices = exercise.default_answer ? JSON.parse(exercise.default_answer) : [];
    const selectedIndex = myResponse ? parseInt(myResponse.answer, 10) : null;

    const choicesEl = document.createElement("div");
    choicesEl.className = "poll-mcq-choices-display";

    choices.forEach((choice, i) => {
      const item = document.createElement("div");
      item.className = "poll-mcq-choice-item";
      item.style.cursor = "pointer";

      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = `mcq-${exercise.id}`;
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
    root.appendChild(choicesEl);

    const submitBtn = document.createElement("button");
    submitBtn.className = "poll-popover-submit-btn";
    submitBtn.textContent = myResponse ? "Change Answer" : "Submit";
    submitBtn.addEventListener("click", async () => {
      const checked = choicesEl.querySelector(`input[name="mcq-${exercise.id}"]:checked`);
      if (!checked) return;
      const answer = checked.value;
      submitBtn.disabled = true;
      try {
        await this._manager.submitResponse({ exerciseId: exercise.id, answer });
        this._updateLocalResponse(exercise, answer);
        submitBtn.textContent = "Change Answer";
      } catch (e) {
        alert(e.message);
      } finally {
        submitBtn.disabled = false;
      }
    });
    root.appendChild(submitBtn);
  }
}
