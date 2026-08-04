import { PollMcqBuilder } from "./activities-panel.js";

// MARK: PollCreatePopover
//
// Floating popover for stage 1 (creating) of a poll exercise. Anchored either to the
// toolbar "Poll" button (a standalone poll) or to a code selection (a code-anchored
// draft poll, via right-click "Create Poll" in the editor). Once submitted, the manager's
// "exerciseCreated" event takes over and the sidebar opens into the active view --
// this popover only needs to know how to close itself. Only the close ("x") button
// dismisses it -- it stays open through clicks elsewhere on the page so it doesn't
// disappear mid-edit.
export class PollCreatePopover {
  constructor({ manager, getCurrentCode, onAbandonDraft, getPollDraftAnchor, onHighlightChange }) {
    this._manager = manager;
    this._getCurrentCode = getCurrentCode;
    this._onAbandonDraft = onAbandonDraft;
    this._getPollDraftAnchor = getPollDraftAnchor;
    this._onHighlightChange = onHighlightChange;

    this._rootEl = null;
    this._isDraft = false;
    this._submitted = false;
    this._code = "";
    this._mcqBuilder = null;
    this._promptEl = null;
  }

  openStandalone({ anchorEl }) {
    this.close();
    this._isDraft = false;
    this._code = "";
    this._build();
    this._position(anchorEl.getBoundingClientRect());
  }

  openForSelection({ code, anchorRect }) {
    this.close();
    this._isDraft = true;
    this._code = code ?? "";
    this._build();
    this._position(anchorRect);
    this._onHighlightChange?.(true);
  }

  isOpen() {
    return this._rootEl != null;
  }

  close() {
    if (!this._rootEl) return;
    this._rootEl.remove();
    this._rootEl = null;
    this._mcqBuilder = null;
    if (this._isDraft && !this._submitted) this._onAbandonDraft?.();
    this._isDraft = false;
    this._submitted = false;
    this._onHighlightChange?.(false);
  }

  // MARK: Building

  _build() {
    const root = document.createElement("div");
    root.className = "poll-popover";
    root.setAttribute("role", "dialog");

    const arrow = document.createElement("div");
    arrow.className = "poll-popover-arrow";
    root.appendChild(arrow);

    const header = document.createElement("div");
    header.className = "poll-popover-header";
    const title = document.createElement("span");
    title.className = "poll-popover-title";
    title.textContent = "✦ Create poll";
    const closeBtn = document.createElement("button");
    closeBtn.className = "poll-popover-close";
    closeBtn.textContent = "×";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.addEventListener("click", () => this.close());
    header.appendChild(title);
    header.appendChild(closeBtn);
    root.appendChild(header);

    const prompt = document.createElement("textarea");
    prompt.className = "poll-popover-prompt";
    prompt.placeholder = "Describe the activity...";
    this._promptEl = prompt;
    root.appendChild(prompt);

    const choicesLabel = document.createElement("div");
    choicesLabel.className = "poll-popover-choices-label";
    choicesLabel.textContent = "Choices";
    choicesLabel.hidden = true;
    root.appendChild(choicesLabel);

    const mcqContainerEl = document.createElement("div");
    mcqContainerEl.hidden = true;
    root.appendChild(mcqContainerEl);

    this._mcqBuilder = new PollMcqBuilder(mcqContainerEl, {
      onSuggest: async () => {
        const instructions = this._promptEl.value.trim();
        return this._manager.suggestMcqChoices({
          instructions,
          instructor_code: this._code || null,
          full_instructor_code: this._getCurrentCode?.(),
        });
      },
      renderHeader: false,
      renderSubmitButton: false,
    });
    this._mcqBuilder.build();

    const footer = document.createElement("div");
    footer.className = "poll-popover-footer";

    const choicesBtn = document.createElement("button");
    choicesBtn.className = "poll-popover-choices-btn";
    choicesBtn.textContent = "+ Choices";
    choicesBtn.addEventListener("click", () => {
      if (mcqContainerEl.hidden) {
        mcqContainerEl.hidden = false;
        choicesLabel.hidden = false;
        choicesBtn.textContent = "Suggest choices";
      } else {
        this._mcqBuilder.suggest(choicesBtn, "Suggest choices");
      }
    });

    const submitBtn = document.createElement("button");
    submitBtn.className = "poll-popover-submit-btn";
    submitBtn.textContent = "Ask class";
    submitBtn.addEventListener("click", () => this._submit(submitBtn));

    footer.appendChild(choicesBtn);
    footer.appendChild(submitBtn);
    root.appendChild(footer);

    document.body.appendChild(root);
    this._rootEl = root;
    prompt.focus();
  }

  async _submit(submitBtn) {
    const instructions = this._promptEl.value.trim();
    const choices = this._mcqBuilder.getAnswers();
    const anchor = this._getPollDraftAnchor?.();
    const codeFields = {
      ...(this._code ? { instructor_code: this._code } : {}),
      full_instructor_code: this._getCurrentCode?.(),
      ...(anchor ? { code_anchor_from: anchor.from, code_anchor_to: anchor.to, code_anchor_doc_version: anchor.docVersion } : {}),
    };

    submitBtn.disabled = true;
    try {
      if (choices.length >= 2) {
        await this._manager.createPollMcqExercise({ instructions, choices, ...codeFields });
      } else {
        await this._manager.createPollExercise({ instructions, ...codeFields });
      }
      this._submitted = true;
      this.close();
    } finally {
      submitBtn.disabled = false;
    }
  }

  // MARK: Positioning
  //
  // Placed to the side of the anchor (right by default, flipping to the left if there's
  // no room) rather than above/below it, so it doesn't cover the code the instructor is
  // looking at.

  _position(anchorRect) {
    const root = this._rootEl;
    // Render off-screen first so we can measure its natural size before placing it.
    root.style.visibility = "hidden";
    root.style.left = "0px";
    root.style.top = "0px";

    requestAnimationFrame(() => {
      if (!this._rootEl) return; // Closed before the frame fired.
      const rect = root.getBoundingClientRect();
      const margin = 12;

      const fitsRight = anchorRect.right + margin + rect.width <= window.innerWidth - margin;
      const side = fitsRight ? "right" : "left";
      let left = side === "right"
        ? anchorRect.right + margin
        : anchorRect.left - margin - rect.width;
      left = Math.max(left, margin);
      left = Math.min(left, window.innerWidth - rect.width - margin);

      let top = anchorRect.top;
      top = Math.min(top, window.innerHeight - rect.height - margin);
      top = Math.max(top, margin);

      root.style.left = `${left}px`;
      root.style.top = `${top}px`;

      const arrowEl = root.querySelector(".poll-popover-arrow");
      arrowEl.classList.remove("poll-popover-arrow--left", "poll-popover-arrow--right");
      // side === "right" means the popover sits to the right of the anchor, so the arrow
      // points left (back at the anchor) and lives on the popover's left edge, and vice versa.
      arrowEl.classList.add(side === "right" ? "poll-popover-arrow--left" : "poll-popover-arrow--right");
      const anchorCenterY = anchorRect.top + anchorRect.height / 2;
      const arrowTop = Math.min(Math.max(anchorCenterY - top - 7, 12), rect.height - 26);
      arrowEl.style.top = `${arrowTop}px`;

      root.style.visibility = "visible";
    });
  }
}
