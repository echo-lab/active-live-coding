import { StateEffect, StateField, Facet, EditorState, Text, ChangeSet } from "@codemirror/state";
import { EditorView, WidgetType, Decoration, keymap } from "@codemirror/view";
import { minimalSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import { indentUnit } from "@codemirror/language";
import { VariantCodeEditor, VariantCodeFollowingEditor, ReviewCodeEditor } from "./code-editors.js";
import { followInstructorExtensions, setInstructorSelection } from "./cm-extensions.js";
import { SOCKET_MESSAGE_TYPE } from "../shared-constants.js";
import { POST_JSON_REQUEST, PATCH_JSON_REQUEST, PUT_JSON_REQUEST } from "./utils.js";

// ============================================================
// MARK: Module-level state
// ============================================================

// Registry of live widget instances keyed by versionBlockId.
const widgetInstances = new Map();

// Callbacks for instructor-side actions (set via versionBlockExtensions).
let _versionBlockCallbacks = null;

// Whether the inner editors should be read-only (set to true on student side).
let _readOnly = false;

// Whether version blocks start minimized by default.
const START_MINIMIZED = false;

export function setVersionBlockReadOnly(v) {
  _readOnly = v;
}

// MARK: Student Version
export class StudentVersionBlockWidget extends WidgetType {

  constructor({ versionBlockId, variants, activitiesManager = null, outerView = null }) {
    super();
    this.versionBlockId = versionBlockId;
    this.selectedIndex = 0;
    this.isMinimized = START_MINIMIZED;
    this.tabEls = [];
    this.tabsContainer = null;
    this.variantContainer = null;
    this.minimizeBtn = null;

    this._outerView = outerView;

    // Student exercise state
    this._activitiesManager = activitiesManager;
    this._exerciseId = null;
    this._exerciseReadOnly = false;
    this._studentAnswerEl = null;
    this._studentAnswerView = null;
    this._studentTabEl = null;
    this._studentTabSelected = false;
    this._submitBtn = null;

    // shape: {id, name, code, docVersion, el, editor}
    this.variants = variants.map(v => ({ ...v, ...this._makeVariantFollowingEditor(v) }));

    activitiesManager?.addEventListener("exerciseCreated", ({ detail: { exercise } }) => {
      if (exercise.VersionBlockId === this.versionBlockId) this._activateExercise(exercise, {shouldScroll: true});
    });
    activitiesManager?.addEventListener("exerciseFinished", ({ detail: { exercise } }) => {
      if (exercise.VersionBlockId === this.versionBlockId) this._deactivateExercise();
    });
  }

  eq(other) {
    return this.versionBlockId === other.versionBlockId;
  }

  ignoreEvent() {
    return true;
  }

  getActiveVariant() {
    if (this._studentTabSelected && this._studentAnswerView) {
      // This is kind of a hack -- it would be better if we created a dedicated class in code-editors.js.
      return { editor: { currentCode: () => this._studentAnswerView.state.doc.toString() } };
    }
    return this.variants[this.selectedIndex];
  }

  // -------------------------------------------------------
  // MARK: -- helpers
  // -------------------------------------------------------

  getPosition(state) {
    const decorations = state.field(versionBlocksField);
    let from = null;
    decorations.between(0, state.doc.length, (f, _t, deco) => {
      if (deco.spec.widget?.versionBlockId === this.versionBlockId) { from = f; return false; }
    });
    return from;
  }

  _makeVariantFollowingEditor(v) {
    const el = document.createElement("div");
    el.className = "cm-version-block-editor";
    el.hidden = true;
    const editor = new VariantCodeFollowingEditor({
      node: el,
      doc: v.code ?? "",
      variantId: v.id,
      docVersion: v.docVersion ?? 0,
    });
    return { el, editor };
  }

  _makeTabEl(index) {
    const variant = this.variants[index];
    const tab = document.createElement("div");
    tab.className = "cm-version-block-tab" + (index === this.selectedIndex ? " selected" : "");
    tab.dataset.variantId = variant.id;

    const label = document.createElement("span");
    label.className = "cm-version-block-tab-label";
    label.textContent = variant.name;
    tab.appendChild(label);

    tab.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const currentIndex = this.variants.findIndex(v => v.id === variant.id);
      if (currentIndex >= 0) this._selectTab(currentIndex);
    });

    this.tabEls.splice(index, 0, tab);
    return tab;
  }

  _selectTab(index) {
    const fromStudentTab = this._studentTabSelected;
    if (fromStudentTab) {
      this._studentTabEl?.classList.remove("selected");
      if (this._studentAnswerEl) this._studentAnswerEl.hidden = true;
      this._studentTabSelected = false;
    }
    if (!fromStudentTab && index === this.selectedIndex) return;
    this.tabEls[this.selectedIndex]?.classList.remove("selected");
    this.selectedIndex = index;
    this.tabEls[index]?.classList.add("selected");
    this._mountEditor(index);
  }

  _selectStudentTab() {
    this.tabEls[this.selectedIndex]?.classList.remove("selected");
    this.variants.forEach(({ el }) => { el.hidden = true; });
    this._studentTabEl?.classList.add("selected");
    this._studentTabSelected = true;
    if (this._studentAnswerEl) this._studentAnswerEl.hidden = false;
  }

  _mountEditor(index) {
    this.variants.forEach(({ el }, idx) => { el.hidden = idx !== index; });
    if (this._studentAnswerEl) this._studentAnswerEl.hidden = true;
  }

  _setMinimized(minimized) {
    this.isMinimized = minimized;
    this.variantContainer?.classList.toggle("minimized", minimized);
    if (this.minimizeBtn) {
      this.minimizeBtn.textContent = minimized ? "⤢" : "_";
      this.minimizeBtn.title = minimized ? "Expand version block" : "Minimize version block";
    }
  }

  // -------------------------------------------------------
  // MARK: -- exercise (student answer)
  // -------------------------------------------------------

  _activateExercise(exercise, { readOnly = false, shouldScroll = false } = {}) {
    if (this._studentAnswerEl) return; // guard against double activation
    this._exerciseId = exercise.id;
    this._exerciseReadOnly = readOnly;

    const priorAnswer = exercise.ExerciseResponses?.[0]?.answer;
    const initialDoc = priorAnswer ?? exercise.default_answer ?? "";

    const el = document.createElement("div");
    el.className = "cm-version-block-editor";
    el.hidden = true;
    this._studentAnswerEl = el;

    this._studentAnswerView = new EditorView({
      state: EditorState.create({
        doc: initialDoc,
        extensions: [
          minimalSetup,
          python(),
          indentUnit.of("    "),
          keymap.of([indentWithTab]),
          EditorView.lineWrapping,
          ...(readOnly ? [EditorView.editable.of(false), EditorState.readOnly.of(true)] : []),
        ],
      }),
      parent: el,
    });

    const tab = document.createElement("div");
    tab.className = "cm-version-block-tab";
    tab.classList.add("my-answer");
    this._myAnswerTab = tab;
    const label = document.createElement("span");
    label.className = "cm-version-block-tab-label";
    label.textContent = "My Answer";
    tab.appendChild(label);
    tab.addEventListener("mousedown", (e) => { e.preventDefault(); this._selectStudentTab(); });
    this._studentTabEl = tab;

    if (this.variantContainer) {
      this.variantContainer.appendChild(el);
      this.tabsContainer.appendChild(tab);
      if (!readOnly) {
        this._submitBtn.hidden = false;
        if (priorAnswer) this._submitBtn.textContent = "Resubmit";
        this.variantContainer.classList.add("exercise-open");
      }
      this._selectStudentTab();
    }
    if (shouldScroll && this._outerView) {
      const from = this.getPosition(this._outerView.state);
      if (from !== null) {
        const scroller = this._outerView.scrollDOM;
        scroller.style.scrollBehavior = "smooth";
        this._outerView.dispatch({
          effects: EditorView.scrollIntoView(from, { y: "nearest", yMargin: 40 }),
        });
        // setTimeout(() => { scroller.style.scrollBehavior = ""; }, 600);
      }
    }
  }

  _deactivateExercise() {
    this._exerciseReadOnly = true;
    if (this._submitBtn) {
      this._submitBtn.hidden = true;
      this._submitBtn.disabled = true;
    }
    if (this._studentAnswerView) {
      this._studentAnswerView.dispatch({
        effects: StateEffect.appendConfig.of([EditorView.editable.of(false), EditorState.readOnly.of(true)]),
      });
    }
    this.variantContainer?.classList.remove("exercise-open");
  }

  async _submitAnswer() {
    if (!this._activitiesManager || !this._exerciseId) return;
    const answer = this._studentAnswerView.state.doc.toString();
    this._submitBtn.disabled = true;
    this._submitBtn.textContent = "Submitting…";
    try {
      await this._activitiesManager.submitResponse({ exerciseId: this._exerciseId, answer });
      this._submitBtn.textContent = "Submitted!";
      setTimeout(() => {
        this._submitBtn.disabled = false;
        this._submitBtn.textContent = "Resubmit";
      }, 1500);
    } catch (err) {
      console.error("Failed to submit answer:", err);
      this._submitBtn.disabled = false;
      this._submitBtn.textContent = "Submit";
    }
  }

  // -------------------------------------------------------
  // MARK: -- DOM
  // -------------------------------------------------------

  toDOM() {
    const container = document.createElement("div");
    container.className = "cm-version-block-widget";

    const toolbar = document.createElement("div");
    toolbar.className = "cm-version-block-toolbar";

    const leftGroup = document.createElement("div");
    leftGroup.className = "cm-version-block-left";

    const tabsContainer = document.createElement("div");
    tabsContainer.className = "cm-version-block-tabs";
    this.tabsContainer = tabsContainer;
    leftGroup.appendChild(tabsContainer);

    // Right group: submit button (shown only during an active exercise)
    const rightGroup = document.createElement("div");
    rightGroup.className = "cm-version-block-right";
    const submitBtn = document.createElement("button");
    submitBtn.className = "cm-version-block-btn cm-version-block-submit-answer";
    submitBtn.textContent = "Submit";
    submitBtn.hidden = true;
    submitBtn.addEventListener("mousedown", (e) => { e.preventDefault(); this._submitAnswer(); });
    this._submitBtn = submitBtn;
    rightGroup.appendChild(submitBtn);

    const minimizeBtn = document.createElement("button");
    minimizeBtn.className = "cm-version-block-btn cm-version-block-minimize";
    minimizeBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this._setMinimized(!this.isMinimized);
    });
    this.minimizeBtn = minimizeBtn;
    rightGroup.appendChild(minimizeBtn);

    const toolbarInner = document.createElement("div");
    toolbarInner.className = "cm-version-block-toolbar-inner";
    toolbarInner.appendChild(leftGroup);
    toolbarInner.appendChild(rightGroup);
    toolbar.appendChild(toolbarInner);
    container.appendChild(toolbar);

    this.variantContainer = container;
    this.variants.forEach(({ el }, idx) => {
      el.hidden = idx !== this.selectedIndex;
      container.appendChild(el);
    });

    this.tabEls = [];
    for (let i = 0; i < this.variants.length; i++) {
      tabsContainer.appendChild(this._makeTabEl(i));
    }

    // Handle exercise activation that may have happened before toDOM() was called,
    // or check for a pre-existing exercise from page load.
    if (this._studentAnswerEl) {
      container.appendChild(this._studentAnswerEl);
      this.tabsContainer.appendChild(this._studentTabEl);
      this._submitBtn.hidden = this._exerciseReadOnly;
      if (!this._exerciseReadOnly) container.classList.add("exercise-open");
      this._selectStudentTab();
    } else if (this._activitiesManager) {
      const ex = this._activitiesManager.getExerciseForVersionBlock(this.versionBlockId);
      if (ex) {
        const hasResponse = ex.ExerciseResponses?.length > 0;
        if (!ex.end_ts) {
          this._activateExercise(ex);
        } else if (hasResponse) {
          this._activateExercise(ex, { readOnly: true });
        }
      }
    }

    this._setMinimized(this.isMinimized);

    return container;
  }

  // -------------------------------------------------------
  // MARK: -- public methods called by StudentCodeEditor
  // -------------------------------------------------------

  getVariantEditor(variantId) {
    return this.variants.find(v => v.id === variantId)?.editor;
  }

  addVariant(v) {
    const variant = { ...v, ...this._makeVariantFollowingEditor(v) };
    this.variants.push(variant);
    if (!this.variantContainer) return;
    const newIndex = this.variants.length - 1;
    const tabEl = this._makeTabEl(newIndex);
    this.variantContainer.appendChild(variant.el);
    if (this._myAnswerTab) {
      this.tabsContainer.insertBefore(tabEl, this._myAnswerTab);
    } else {
      this.tabsContainer.appendChild(tabEl);
    }
    this._selectTab(newIndex);
  }

  renameVariant(variantId, name) {
    const variant = this.variants.find(v => v.id === variantId);
    if (!variant) return;
    variant.name = name;
    const tab = this.tabEls.find(t => t.dataset.variantId === String(variantId));
    if (tab) tab.querySelector(".cm-version-block-tab-label").textContent = name;
  }

  removeVariant(variantId) {
    const index = this.variants.findIndex(v => v.id === variantId);
    if (index < 0 || this.variants.length <= 1) return;

    const selectedVariantId = this.variants[this.selectedIndex]?.id;
    const deletingSelected = variantId === selectedVariantId;

    this.tabEls[this.selectedIndex]?.classList.remove("selected");
    this.variants.splice(index, 1)[0]?.el?.remove();
    this.tabEls.splice(index, 1)[0]?.remove();

    if (deletingSelected) {
      const newIndex = Math.max(0, index - 1);
      this.selectedIndex = newIndex;
      this.tabEls[newIndex]?.classList.add("selected");
      this._mountEditor(newIndex);
    } else {
      const newIndex = this.variants.findIndex(v => v.id === selectedVariantId);
      this.selectedIndex = newIndex >= 0 ? newIndex : 0;
      this.tabEls[this.selectedIndex]?.classList.add("selected");
    }
  }

}

// ============================================================
// MARK: Version Block Widget
// ============================================================

// TODO: make another class for the students :)
export class VersionBlockWidget extends WidgetType {
  constructor({ versionBlockId, variants, socket = null, sessionNumber = null, activitiesManager = null, getInstructorCode, view, onDissolve, readOnly = false }) {
    super();
    this.versionBlockId = versionBlockId;
    this.socket = socket;
    this.sessionNumber = sessionNumber;
    this.activitiesManager = activitiesManager;
    this.getInstructorCodeForExercise = getInstructorCode;  // Substitutes this variant's code w/ string {{ANSWER}}
    this._outerView = view;
    this._onDissolve = onDissolve ?? null;
    this.readOnly = readOnly;

    this.selectedIndex = 0; // TODO: make this an ID instead... maybe?
    this.isMinimized = START_MINIMIZED;

    this.innerView = null;

    this.tabEls = [];
    this.toolbar = null;
    this.minimizeBtn = null;
    this.container = null;
    this.variantContainer = null;
    this.exerciseBtnContainer = null;
    this._timerInterval = null;
    this._responseListener = null;
    this._summaryDisplayListener = null;

    // shape: {id, code, name, el, editor}
    this.variants = variants.map((v) => ({
        ...v,
        ...(this.readOnly ? this._makeVariantViewer(v) : this._makeVariantCodeEditor(v)),
    }));

    // In the historical view, default to showing the student's own answer (if present) rather
    // than the instructor's first variant.
    const ownAnswerIndex = this.variants.findIndex((v) => v.isOwnAnswer);
    if (ownAnswerIndex >= 0) this.selectedIndex = ownAnswerIndex;

    // A read-only widget shows a frozen historical snapshot -- it has no exercise workflow (no
    // "ask students"/"finish"/dissolve buttons) to keep in sync, so none of these are needed.
    if (!this.readOnly && this.activitiesManager) {
      activitiesManager.addEventListener("exerciseCreated", ({ detail: { exercise } }) => {
        if (exercise.VersionBlockId === this.versionBlockId) this._updateExerciseBtn();
      });
      activitiesManager.addEventListener("exerciseFinished", ({ detail: { exercise } }) => {
        if (exercise.VersionBlockId === this.versionBlockId) this._updateExerciseBtn();
      });
      this._summaryDisplayListener = ({ detail: { exerciseId } }) => {
        const ex = this.activitiesManager.getExerciseForVersionBlock(this.versionBlockId);
        this.container?.classList.toggle("code-summary-active", !!ex && ex.id === exerciseId);
      };
      activitiesManager.addEventListener("codeSummaryDisplayed", this._summaryDisplayListener);
    }
  }

  eq(other) {
    return this.versionBlockId === other.versionBlockId;
  }

  getActiveVariant() {
    return this.variants[this.selectedIndex];
  }

  toDOM() {
    const container = document.createElement("div");
    container.className = "cm-version-block-widget" + (this.readOnly ? " read-only" : "");

    this.container = container;

    // Toolbar
    this.toolbar = document.createElement("div");
    this.toolbar.className = "cm-version-block-toolbar";

    // Left group: # button + tabs + + button
    const leftGroup = document.createElement("div");
    leftGroup.className = "cm-version-block-left";

    // const hashBtn = document.createElement("button");
    // hashBtn.className = "cm-version-block-btn cm-version-block-hash";
    // hashBtn.textContent = "#";
    // hashBtn.title = "Version block options";
    // leftGroup.appendChild(hashBtn);

    const tabsContainer = document.createElement("div");
    tabsContainer.className = "cm-version-block-tabs";
    this.tabsContainer = tabsContainer;
    leftGroup.appendChild(tabsContainer);

    let addBtn = null;
    if (!this.readOnly) {
      addBtn = document.createElement("button");
      addBtn.className = "cm-version-block-btn cm-version-block-add";
      addBtn.textContent = "+";
      addBtn.title = "Add variant";
      addBtn.addEventListener("mousedown", async (e) => {
        e.preventDefault();
        await this._createVariant();
      });
      this.addBtn = addBtn;
    }

    // Right group: ask students + minimize + dissolve (the first and last only when editable)
    const rightGroup = document.createElement("div");
    rightGroup.className = "cm-version-block-right";

    if (!this.readOnly) {
      this.exerciseBtnContainer = document.createElement("div");
      this.exerciseBtnContainer.style.fontSize = "10px";  // else it's too tall!
      rightGroup.appendChild(this.exerciseBtnContainer);
      this._updateExerciseBtn();
    }

    const minimizeBtn = document.createElement("button");
    minimizeBtn.className = "cm-version-block-btn cm-version-block-minimize";
    minimizeBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this._setMinimized(!this.isMinimized);
    });
    this.minimizeBtn = minimizeBtn;
    rightGroup.appendChild(minimizeBtn);

    if (!this.readOnly) {
      const closeBtn = document.createElement("button");
      closeBtn.className = "cm-version-block-btn cm-version-block-close";
      closeBtn.textContent = "✕";
      closeBtn.title = "Dissolve version block";
      closeBtn.addEventListener("mousedown", async (e) => {
        e.preventDefault();
        if (window.confirm("Are you sure you want to dissolve this version block?")) {
          await this.dissolve();
        }
      });
      rightGroup.appendChild(closeBtn);
    }

    const toolbarInner = document.createElement("div");
    toolbarInner.className = "cm-version-block-toolbar-inner";
    toolbarInner.appendChild(leftGroup);
    toolbarInner.appendChild(rightGroup);
    this.toolbar.appendChild(toolbarInner);
    container.appendChild(this.toolbar);

    // Editor area
    this.variants.forEach(({el}, idx) => {
        el.hidden = idx !== this.selectedIndex;
        container.appendChild(el);
    });
    this.variantContainer = container; // Should be separate from the main container, but eh.

    // Build initial tabs and editor
    this.tabEls = [];
    for (let i = 0; i < this.variants.length; i++) {
      tabsContainer.appendChild(this._makeTabEl(i));
    }
    if (addBtn) tabsContainer.appendChild(addBtn);
    this._updateDeleteBtnVisibility();
    this._setMinimized(this.isMinimized);

    return container;
  }

//   destroy() {
//     if (this._innerEditor) { this._innerEditor.destroy(); }
//     else { this.innerView?.destroy(); }
//     this.innerView = null;
//     this._innerEditor = null;
//     widgetInstances.delete(this.versionBlockId);
//   }

  ignoreEvent() {
    return true;
  }

  // Takes a CodeMirror state and returns the position of the VersionBlockWidget.
  getPosition(state) {
    const decorations = state.field(versionBlocksField);
    let from = null, to = null;
    decorations.between(0, state.doc.length, (f, t, deco) => {
      if (deco.spec.widget?.versionBlockId === this.versionBlockId) {
        from = f; to = t; return false;
      }
    });
    return {from, to};
  }

  async dissolve() {
    await this._onDissolve?.();  // from InstructorCodeEditor.
    // Cleanup
    for (const { editor } of this.variants) { editor?.destroy(); }
    this._clearExerciseState();
    this.activitiesManager.removeEventListener("codeSummaryDisplayed", this._summaryDisplayListener);
  }

  _clearExerciseState() {
    if (this._timerInterval) { clearInterval(this._timerInterval); this._timerInterval = null; }
    if (this._responseListener) {
      this.activitiesManager.removeEventListener("responseReceived", this._responseListener);
      this._responseListener = null;
    }
    this.container?.classList.remove("exercise-open");
  }

  _updateExerciseBtn() {
    this._clearExerciseState();
    this.exerciseBtnContainer.innerHTML = "";
    const btn = document.createElement("button");
    btn.className = "cm-version-block-btn cm-version-block-ask";

    const ex = this.activitiesManager.getExerciseForVersionBlock(this.versionBlockId);
    if (!ex) {
      btn.textContent = "ask students";
      btn.addEventListener("mousedown", (e) => { e.preventDefault(); this._askStudents(); });
    } else if (ex.end_ts) {
      btn.textContent = "view responses";
      btn.addEventListener("mousedown", (e) => { e.preventDefault(); this.activitiesManager.showSummaryForExercise(ex.id); });
    } else {
      // The exercise is open: display the response count, flash the border, and include a timer.
      this.container?.classList.add("exercise-open");

      const countEl = document.createElement("span");
      countEl.className = "cm-version-block-response-count";
      const updateCount = () => {
        const count = ex.ExerciseResponses.filter((r) => !r.isSimulated).length;
        countEl.textContent = `${count} responses |`;
      };
      updateCount();
      this._responseListener = ({ detail: { exercise } }) => {
        if (exercise.id === ex.id) updateCount();
      };
      this.activitiesManager.addEventListener("responseReceived", this._responseListener);

      const timerEl = document.createElement("span");
      timerEl.className = "cm-version-block-timer";
      const updateTimer = () => {
        const elapsed = Math.floor((Date.now() - new Date(ex.start_ts).getTime()) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        timerEl.textContent = mins > 0 ? `${mins}:${secs.toString().padStart(2, "0")}` : `${secs}s`;
      };
      updateTimer();
      this._timerInterval = setInterval(updateTimer, 1000);

      btn.textContent = "finish exercise";
      btn.addEventListener("mousedown", (e) => { e.preventDefault(); this._finishExercise(); });

      this.exerciseBtnContainer.appendChild(countEl);
      this.exerciseBtnContainer.appendChild(timerEl);
    }

    this.exerciseBtnContainer.appendChild(btn);
  }

  async _askStudents() {
    const activeVariant = this.getActiveVariant();
    const currentCode = activeVariant.editor?.currentCode();
    const instructor_code = this.getInstructorCodeForExercise?.();
    const newEx = await this.activitiesManager.createCodeVariantExercise({
      default_answer: currentCode,
      instructor_code,
      versionBlockId: this.versionBlockId,
    });
    // Below: handled by the event listeners...
    // if (newEx) this._updateExerciseBtn();
  }

  async _finishExercise() {
    const ex = this.activitiesManager.getExerciseForVersionBlock(this.versionBlockId);
    if (!ex) return;
    await this.activitiesManager.finishExercise(ex.id);
    // Below: handled by the event listeners...
    // this._updateExerciseBtn();
  }

  // -------------------------------------------------------
  // MARK: -- helpers
  // -------------------------------------------------------

  // Returns both the element and the actual editor
  _makeVariantCodeEditor(v) {
    const el = document.createElement("div");
    el.className = "cm-version-block-editor";
    el.hidden = true;
    let editor;
    editor = new VariantCodeEditor({
      node: el,
      doc: v.code ?? "",
      variantId: v.id,
      socket: this.socket,
      sessionNumber: this.sessionNumber,
      versionBlockId: this.versionBlockId,
      docVersion: v.docVersion ?? 0,
    });
    return {el, editor};
  }

  // Read-only counterpart to _makeVariantCodeEditor -- used when this widget is displaying a
  // frozen historical snapshot. ReviewCodeEditor needs no socket/versionBlockId coupling (unlike
  // VariantCodeEditor, which is built to receive a live edit stream this snapshot will never get).
  _makeVariantViewer(v) {
    const el = document.createElement("div");
    el.className = "cm-version-block-editor";
    el.hidden = true;
    const editor = new ReviewCodeEditor({ node: el, doc: (v.code ?? "").split("\n"), isEditable: false });
    return { el, editor };
  }

  _makeTabEl(index) {
    const variant = this.variants[index];
    const tab = document.createElement("div");
    tab.className = "cm-version-block-tab" + (index === this.selectedIndex ? " selected" : "");
    tab.dataset.variantId = variant.id;
    if (variant.isOwnAnswer) tab.classList.add("my-answer");

    const label = document.createElement("span");
    label.className = "cm-version-block-tab-label";
    label.textContent = variant.name;
    if (!this.readOnly) {
      label.addEventListener("dblclick", (e) => {
        e.preventDefault();
        const currentIndex = this.variants.findIndex((v) => v.id === variant.id);
        if (currentIndex >= 0) this._startRename(currentIndex, label, tab);
      });
    }
    tab.appendChild(label);

    let delBtn = null;
    if (!this.readOnly) {
      // TODO: change the UI of this...
      delBtn = document.createElement("button");
      delBtn.className = "cm-version-block-tab-delete";
      delBtn.textContent = "×";
      delBtn.title = "Delete variant";
      delBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (window.confirm("Are you sure you want to delete this?")) {
          this._deleteVariant(variant.id);
        }
      });
      tab.appendChild(delBtn);
    }

    tab.addEventListener("mousedown", (e) => {
      if (e.target === delBtn) return;
      e.preventDefault();
      const currentIndex = this.variants.findIndex((v) => v.id === variant.id);
      if (currentIndex >= 0) this._selectTab(currentIndex);
    });

    this.tabEls.splice(index, 0, tab);
    return tab;
  }

  _startRename(index, labelEl, tabEl) {
    const variant = this.variants[index];
    const input = document.createElement("input");
    input.className = "cm-version-block-tab-rename";
    input.value = variant.name;
    input.style.width = Math.max(40, variant.name.length * 8) + "px";
    labelEl.replaceWith(input);
    input.focus();
    input.select();

    const commit = () => {
      const newName = input.value.trim() || variant.name;
      input.replaceWith(labelEl);
      labelEl.textContent = newName;
      if (newName !== variant.name) {
        variant.name = newName;
        this._renameVariantBackend(variant.id, newName);
      }
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
      if (e.key === "Escape") { input.value = variant.name; input.blur(); }
    });
  }

  _selectTab(index) {
    if (index === this.selectedIndex) return;
    this.tabEls[this.selectedIndex]?.classList.remove("selected");
    this.selectedIndex = index;
    this.tabEls[index]?.classList.add("selected");
    this._mountEditor(index);
  }

  _mountEditor(index) {
    this.variants.forEach(({el}, idx) => {
        el.hidden = (idx !== index);
    });
  }

  _setMinimized(minimized) {
    this.isMinimized = minimized;
    this.container?.classList.toggle("minimized", minimized);
    if (this.minimizeBtn) {
      this.minimizeBtn.textContent = minimized ? "⤢" : "_";
      this.minimizeBtn.title = minimized ? "Expand version block" : "Minimize version block";
    }
  }

  // -------------------------------------------------------
  // MARK: -- variants CRUD
  // -------------------------------------------------------

  async _createVariant() {
    try {
      const variant = await this._createVariantBackend();
      if (!variant) return;
      this._mountVariant(variant);
      this._broadcastVariantAdded(variant);
    } catch (err) {
      console.error("Failed to add variant:", err);
    }
  }

  // Creates a new variant pre-populated with `code` -- e.g. promoting a student's exercise
  // response into a variant the instructor can walk through with the rest of the class. Reuses
  // the (until now unused) PUT /variant/:id/code endpoint to seed its content server-side.
  async addVariantFromCode(code, name) {
    try {
      const created = await this._createVariantBackend(name);
      if (!created) return;
      const res = await fetch(`/variant/${created.id}/code`, {
        body: JSON.stringify({ code }),
        ...PUT_JSON_REQUEST,
      });
      const { error } = await res.json();
      if (error) { console.error("Failed to seed new variant's code:", error); return; }
      const variant = { ...created, code, docVersion: created.docVersion + 1 };
      this._mountVariant(variant);
      this._broadcastVariantAdded(variant);
    } catch (err) {
      console.error("Failed to add variant from response:", err);
    }
  }

  // Backend half of variant creation: persists an empty variant and returns its data, or null on
  // error. Doesn't touch the DOM or broadcast -- callers decide when/what to mount and announce
  // (e.g. addVariantFromCode seeds the code in between the two).
  async _createVariantBackend(name = `v${this.variants.length}`) {
    const res = await fetch("/variant", {
      body: JSON.stringify({ versionBlockId: this.versionBlockId, name }),
      ...POST_JSON_REQUEST,
    });
    const { variantId, name: returnedName, docVersion, error } = await res.json();
    if (error) { console.error("Failed to add variant:", error); return null; }
    return { id: variantId, name: returnedName, code: "", docVersion };
  }

  // Local UI half of variant creation: mounts the editor, tab, and selects it. Shared by
  // _createVariant and addVariantFromCode.
  _mountVariant(variant) {
    variant = {
      ...variant,
      ...this._makeVariantCodeEditor(variant),
    };
    this.variants.push(variant);
    this.variantContainer.appendChild(variant.el);
    const newIndex = this.variants.length - 1;
    const tabEl = this._makeTabEl(newIndex);
    this.tabsContainer.insertBefore(tabEl, this.addBtn);
    this._updateDeleteBtnVisibility();
    this._selectTab(newIndex);
    this._flashNewVariant();
  }

  // Briefly pulses the widget's border to draw the instructor's eye to it -- e.g. after adding a
  // variant from the sidebar summary, where the widget may not be the thing they were just
  // looking at.
  _flashNewVariant() {
    if (!this.container) return;
    this.container.classList.add("new-variant-flash");
    setTimeout(() => this.container?.classList.remove("new-variant-flash"), 1200);
  }

  _broadcastVariantAdded(variant) {
    this.socket.emit(SOCKET_MESSAGE_TYPE.VARIANT_ADDED, {
      sessionId: this.sessionNumber,
      versionBlockId: this.versionBlockId,
      variant: { id: variant.id, name: variant.name, code: variant.code, docVersion: variant.docVersion },
    });
  }

  async _renameVariantBackend(variantId, newName) {
    try {
      await fetch(`/variant/${variantId}`, {
        method: "PATCH",
        body: JSON.stringify({ name: newName }),
        ...PATCH_JSON_REQUEST,
      });
      this.socket.emit(SOCKET_MESSAGE_TYPE.VARIANT_RENAMED,
        {
          sessionId: this.sessionNumber,
          versionBlockId: this.versionBlockId,
          variantId,
          name: newName
        }
      );
    } catch (err) {
      console.error("Failed to rename variant:", err);
    }
  }

  _updateDeleteBtnVisibility() {
    const onlyOne = this.variants.length <= 1;
    for (const tab of this.tabEls) {
      const delBtn = tab.querySelector(".cm-version-block-tab-delete");
      if (delBtn) delBtn.classList.toggle("hidden", onlyOne);
    }
  }

  async _deleteVariantBackend(variantId) {
    try {
      const res = await fetch(`/variant/${variantId}`, { method: "DELETE" });
      const { error } = await res.json();
      if (error) { console.error("Failed to delete variant:", error); return; }
      this.socket.emit(SOCKET_MESSAGE_TYPE.VARIANT_DELETED, { sessionId: this.sessionNumber, versionBlockId: this.versionBlockId, variantId });
    } catch (err) {
      console.error("Failed to delete variant:", err);
    }
  }

  async _deleteVariant(variantId) {
    try {
      await this._deleteVariantBackend(variantId);
    } catch (err) {
      console.err("Failed to delete variant: ", err);
      return;
    }

    const index = this.variants.findIndex((v) => v.id === variantId);
    if (index < 0 || this.variants.length <= 1) return;

    const selectedVariantId = this.variants[this.selectedIndex]?.id;
    const deletingSelected = variantId === selectedVariantId;

    this.tabEls[this.selectedIndex]?.classList.remove("selected");
    const [removed] = this.variants.splice(index, 1);
    removed.el.remove();
    removed.editor.destroy();
    this.tabEls.splice(index, 1)[0]?.remove();
    this._updateDeleteBtnVisibility();

    if (deletingSelected) {
      const newIndex = Math.max(0, index - 1);
      this.selectedIndex = newIndex;
      this.tabEls[newIndex]?.classList.add("selected");
      this._mountEditor(newIndex);
    } else {
      const newIndex = this.variants.findIndex((v) => v.id === selectedVariantId);
      this.selectedIndex = newIndex >= 0 ? newIndex : 0;
      this.tabEls[this.selectedIndex]?.classList.add("selected");
    }
  }


  // -------------------------------------------------------
  // Public methods called by notifyVariant* functions
  // -------------------------------------------------------


  // TODO update
  // applyVariantEdit(variantId, changes) {
  //   const index = this.variants.findIndex((v) => v.id === variantId);
  //   if (index < 0) return;
  //   const changeSet = ChangeSet.fromJSON(changes);
  //   if (index === this.selectedIndex && this.innerView) {
  //     this.innerView.dispatch({ changes: changeSet });
  //     this.variants[index].code = this.innerView.state.doc.toString();
  //   } else {
  //     const doc = Text.of((this.variants[index].code ?? "").split("\n"));
  //     this.variants[index].code = changeSet.apply(doc).toString();
  //   }
  // }

  // applyVariantCursor(variantId, anchor, head) {
  //   const index = this.variants.findIndex((v) => v.id === variantId);
  //   if (index !== this.selectedIndex || !this.innerView) return;
  //   if (anchor > this.innerView.state.doc.length || head > this.innerView.state.doc.length) return;
  //   this.innerView.dispatch({ effects: setInstructorSelection.of({ anchor, head }) });
  // }
}

// ============================================================
// MARK: StateEffect + StateField
// ============================================================

// value: { from, to, versionBlockId, variants: [{id, name, code}] }
export const addVersionBlockEffect = StateEffect.define();

// value: { versionBlockId }
export const removeVersionBlockEffect = StateEffect.define();

export const versionBlocksField = StateField.define({
  create: () => Decoration.none,
  update(decorations, tr) {
    decorations = decorations.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(addVersionBlockEffect)) {
        const { from, to, widget } = e.value;
        decorations = decorations.update({
          add: [Decoration.replace({ widget, block: true }).range(from, to)],
          sort: true,
        });
      } else if (e.is(removeVersionBlockEffect)) {
        const { versionBlockId } = e.value;
        decorations = decorations.update({
          filter: (_from, _to, deco) => deco.spec.widget?.versionBlockId !== versionBlockId,
        });
      }
    }
    return decorations;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Rejects any transaction that would modify the version block line or its surrounding newlines.
const versionBlockProtection = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  const decorations = tr.startState.field(versionBlocksField);
  let blocked = false;
  tr.changes.iterChanges((fromA, toA) => {
    if (blocked) return;
    decorations.between(0, tr.startState.doc.length, (dFrom, dTo) => {
      const pFrom = Math.max(0, dFrom - 1);
      const pTo = dTo + 1;
      if (fromA < pTo && toA > pFrom) blocked = true;
    });
  });
  return blocked ? [] : tr;
});

export function versionBlockExtensions() {
  return [versionBlocksField, versionBlockProtection];
}
