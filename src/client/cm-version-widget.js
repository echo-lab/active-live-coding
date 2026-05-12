import { StateEffect, StateField, Facet, EditorState, Text, ChangeSet } from "@codemirror/state";
import { EditorView, showTooltip, WidgetType, Decoration, keymap } from "@codemirror/view";
import { minimalSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import { indentUnit } from "@codemirror/language";
import { VariantCodeEditor, VariantCodeFollowingEditor } from "./code-editors.js";
import { followInstructorExtensions, setInstructorSelection } from "./cm-extensions.js";
import { SOCKET_MESSAGE_TYPE } from "../shared-constants.js";
import { POST_JSON_REQUEST, PATCH_JSON_REQUEST } from "./utils.js";

// ============================================================
// MARK: Module-level state
// ============================================================

// Registry of live widget instances keyed by versionBlockId.
const widgetInstances = new Map();

// Callbacks for instructor-side actions (set via versionWidgetExtensions).
let _versionBlockCallbacks = null;

// Whether the inner editors should be read-only (set to true on student side).
let _readOnly = false;

export function setVersionBlockReadOnly(v) {
  _readOnly = v;
}

// MARK: Student Version
export class StudentVersionBlockWidget extends WidgetType {

  constructor({ versionBlockId, variants }) {
    // console.log("Making a version block: ", versionBlockId);
    super();
    this.versionBlockId = versionBlockId;
    this.selectedIndex = 0;
    this.tabEls = [];
    this.tabsContainer = null;
    this.variantContainer = null;
    console.log("variants: ", variants);
    // shape: {id, name, code, docVersion, el, editor}
    this.variants = variants.map(v => ({ ...v, ...this._makeVariantFollowingEditor(v) }));
  }

  eq(other) {
    return this.versionBlockId === other.versionBlockId;
  }

  ignoreEvent() {
    return true;
  }

  getActiveVariant() {
    return this.variants[this.selectedIndex];
  }

  // -------------------------------------------------------
  // MARK: -- helpers
  // -------------------------------------------------------

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
    if (index === this.selectedIndex) return;
    this.tabEls[this.selectedIndex]?.classList.remove("selected");
    this.selectedIndex = index;
    this.tabEls[index]?.classList.add("selected");
    this._mountEditor(index);
  }

  _mountEditor(index) {
    this.variants.forEach(({ el }, idx) => { el.hidden = idx !== index; });
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

    const hashBtn = document.createElement("button");
    hashBtn.className = "cm-version-block-btn cm-version-block-hash";
    hashBtn.textContent = "#";
    hashBtn.disabled = true;
    leftGroup.appendChild(hashBtn);

    const tabsContainer = document.createElement("div");
    tabsContainer.className = "cm-version-block-tabs";
    this.tabsContainer = tabsContainer;
    leftGroup.appendChild(tabsContainer);

    toolbar.appendChild(leftGroup);
    container.appendChild(toolbar);

    this.variantContainer = container;
    this.variants.forEach(({ el }, idx) => {
      el.hidden = idx !== 0;
      container.appendChild(el);
    });

    this.tabEls = [];
    for (let i = 0; i < this.variants.length; i++) {
      tabsContainer.appendChild(this._makeTabEl(i));
    }

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
    this.variantContainer.appendChild(variant.el);
    const newIndex = this.variants.length - 1;
    const tabEl = this._makeTabEl(newIndex);
    this.tabsContainer.appendChild(tabEl);
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
  constructor({ versionBlockId, variants, socket, sessionNumber, activitiesManager, getInstructorCode }) {
    super();
    this.versionBlockId = versionBlockId;
    this.socket = socket;
    this.sessionNumber = sessionNumber;
    this.activitiesManager = activitiesManager;
    this.getInstructorCodeForExercise = getInstructorCode;  // Substitutes this variant's code w/ string {{ANSWER}}

    this.selectedIndex = 0; // TODO: make this an ID instead... maybe?

    this.innerView = null;

    this.tabEls = [];
    this.toolbar = null;
    this.variantContainer = null;
    this.exerciseBtnContainer = null;

    // shape: {id, code, name, el, editor}
    this.variants = variants.map((v) => ({
        ...v,
        ...this._makeVariantCodeEditor(v),
    }));

    activitiesManager.addEventListener("exerciseCreated", ({ detail: { exercise } }) => {
      if (exercise.VersionBlockId === this.versionBlockId) this._updateExerciseBtn();
    });
    activitiesManager.addEventListener("exerciseFinished", ({ detail: { exercise } }) => {
      if (exercise.VersionBlockId === this.versionBlockId) this._updateExerciseBtn();
    });
  }

  eq(other) {
    return this.versionBlockId === other.versionBlockId;
  }

  getActiveVariant() {
    return this.variants[this.selectedIndex];
  }

  toDOM() {
    const container = document.createElement("div");
    container.className = "cm-version-block-widget";

    // Toolbar
    this.toolbar = document.createElement("div");
    this.toolbar.className = "cm-version-block-toolbar";

    // Left group: # button + tabs + + button
    const leftGroup = document.createElement("div");
    leftGroup.className = "cm-version-block-left";

    const hashBtn = document.createElement("button");
    hashBtn.className = "cm-version-block-btn cm-version-block-hash";
    hashBtn.textContent = "#";
    hashBtn.title = "Version block options";
    leftGroup.appendChild(hashBtn);

    const tabsContainer = document.createElement("div");
    tabsContainer.className = "cm-version-block-tabs";
    this.tabsContainer = tabsContainer;
    leftGroup.appendChild(tabsContainer);

    const addBtn = document.createElement("button");
    addBtn.className = "cm-version-block-btn cm-version-block-add";
    addBtn.textContent = "+";
    addBtn.title = "Add variant";
    addBtn.addEventListener("mousedown", async (e) => {
      e.preventDefault();
      await this._createVariant();
    });
    leftGroup.appendChild(addBtn);

    // Right group: ask students + X
    const rightGroup = document.createElement("div");
    rightGroup.className = "cm-version-block-right";

    this.exerciseBtnContainer = document.createElement("div");
    rightGroup.appendChild(this.exerciseBtnContainer);
    this._updateExerciseBtn();

    // Probably nix this? Or make it different!
    const closeBtn = document.createElement("button");
    closeBtn.className = "cm-version-block-btn cm-version-block-close";
    closeBtn.textContent = "✕";
    rightGroup.appendChild(closeBtn);

    this.toolbar.appendChild(leftGroup);
    this.toolbar.appendChild(rightGroup);
    container.appendChild(this.toolbar);

    // Editor area
    this.variants.forEach(({el}, idx) => {
        el.hidden = idx !== 0;
        container.appendChild(el);
    });
    this.variantContainer = container; // Should be separate from the main container, but eh.

    // Build initial tabs and editor
    this.tabEls = [];
    for (let i = 0; i < this.variants.length; i++) {
      tabsContainer.appendChild(this._makeTabEl(i));
    }
    this._updateDeleteBtnVisibility();

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

  _updateExerciseBtn() {
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
      btn.textContent = "finish exercise";
      btn.addEventListener("mousedown", (e) => { e.preventDefault(); this._finishExercise(); });
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

  _makeTabEl(index) {
    const variant = this.variants[index];
    const tab = document.createElement("div");
    tab.className = "cm-version-block-tab" + (index === this.selectedIndex ? " selected" : "");
    tab.dataset.variantId = variant.id;

    const label = document.createElement("span");
    label.className = "cm-version-block-tab-label";
    label.textContent = variant.name;
    label.addEventListener("dblclick", (e) => {
      e.preventDefault();
      const currentIndex = this.variants.findIndex((v) => v.id === variant.id);
      if (currentIndex >= 0) this._startRename(currentIndex, label, tab);
    });

    // TODO: change the UI of this...
    const delBtn = document.createElement("button");
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

    tab.appendChild(label);
    tab.appendChild(delBtn);
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

  // -------------------------------------------------------
  // MARK: -- variants CRUD
  // -------------------------------------------------------

  // May throw an exception!
  async _createVariant() {
    try {
      let variant = await this._createVariantBackend();
      variant = {
        ...variant,
        ...this._makeVariantCodeEditor(variant),
      };
      this.variants.push(variant);
      this.variantContainer.appendChild(variant.el);
      const newIndex = this.variants.length - 1;
      const tabEl = this._makeTabEl(newIndex);
      this.tabsContainer.appendChild(tabEl);
      this._updateDeleteBtnVisibility();
      this._selectTab(newIndex);
    } catch (err) {
      console.error("Failed to add variant:", err);
    }
  }

  async _createVariantBackend() {
    // Step 1: create on the backend.
    const name = `v${this.variants.length}`;
    const res = await fetch("/variant", {
      body: JSON.stringify({ versionBlockId: this.versionBlockId, name }),
      ...POST_JSON_REQUEST,
    });
    const { variantId, error } = await res.json();
    if (error) { console.error("Failed to add variant:", error); return; }
    const variant = {id: variantId, name, code: "", docVersion: 1};

    // Step 2: Emit the update to students.
    this.socket.emit(
      SOCKET_MESSAGE_TYPE.VARIANT_ADDED,
      {
        sessionId: this.sessionNumber,
        versionBlockId: this.versionBlockId,
        variant,
      }
    );

    return variant;
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

export const versionBlocksField = StateField.define({
  create: () => Decoration.none,
  update(decorations, tr) {
    decorations = decorations.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(addVersionBlockEffect)) continue;
      const {from, to, widget } = e.value;
      decorations = decorations.update({
        add: [Decoration.replace({ widget, block: true }).range(from, to)],
        sort: true,
      });
    }
    return decorations;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ============================================================
// MARK: Tooltip for instructor to create a Version Widget
// ============================================================

export const handleCreateVersionBlock = Facet.define({
  combine: (values) => (values.length ? values.at(-1) : null),
});

const showVersionWidgetTooltip = StateEffect.define();
const hideVersionWidgetTooltip = StateEffect.define();

export const versionWidgetTooltipField = StateField.define({
  create() {
    return null;
  },
  update(tooltip, tr) {
    if (tr.docChanged || tr.selection) tooltip = null;
    for (let e of tr.effects) {
      if (e.is(showVersionWidgetTooltip)) tooltip = e.value;
      if (e.is(hideVersionWidgetTooltip)) tooltip = null;
    }
    return tooltip;
  },
  provide: (f) =>
    showTooltip.computeN([f], (state) => {
      let t = state.field(f);
      return t ? [t] : [];
    }),
});

function createVersionWidgetTooltipDOM(view) {
  let div = document.createElement("div");
  div.className = "cm-tooltip-version-widget";
  div.textContent = "New Version";
  div.addEventListener("mousedown", (e) => {
    e.preventDefault();
    view.dispatch({ effects: hideVersionWidgetTooltip.of(null) });

    let state = view.state;
    let { from, to } = state.selection.main;
    let startLine = state.doc.lineAt(from);
    let endLine = state.doc.lineAt(to);
    let lineStart = startLine.number;
    let lineEnd = to > from && to === endLine.from ? endLine.number - 1 : endLine.number;

    let firstLine = state.doc.line(lineStart);
    let lastLine = state.doc.line(lineEnd);
    let variantCode = state.doc.sliceString(firstLine.from, lastLine.to);

    let callback = state.facet(handleCreateVersionBlock);
    callback && callback({ variantCode, from: firstLine.from, to: lastLine.to });
  });
  return div;
}

export const versionWidgetContextMenu = EditorView.domEventHandlers({
  contextmenu(event, view) {
    event.preventDefault();
    let pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) return true;

    let { from, to } = view.state.selection.main;
    if (pos < from || pos > to) {
      view.dispatch({ selection: { anchor: pos } });
    }

    let tooltipPos = view.state.selection.main.head;
    view.dispatch({
      effects: showVersionWidgetTooltip.of({
        pos: tooltipPos,
        above: true,
        arrow: true,
        create: (v) => ({ dom: createVersionWidgetTooltipDOM(v) }),
      }),
    });
    return true;
  },
});

export const versionWidgetTooltipTheme = EditorView.baseTheme({
  ".cm-tooltip.cm-tooltip-version-widget": {
    backgroundColor: "#2a7a2a",
    color: "white",
    border: "none",
    padding: "2px 7px",
    borderRadius: "4px",
    cursor: "pointer",
    "& .cm-tooltip-arrow:before": {
      borderTopColor: "#2a7a2a",
    },
    "& .cm-tooltip-arrow:after": {
      borderTopColor: "transparent",
    },
  },
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

export function versionWidgetExtensions(onCreateVersionBlock) {
  return [
    handleCreateVersionBlock.of(onCreateVersionBlock),
    versionWidgetTooltipField,
    versionWidgetContextMenu,
    versionWidgetTooltipTheme,
    versionBlocksField,
    versionBlockProtection,
  ];
}
