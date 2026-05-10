import { StateEffect, StateField, Facet, EditorState } from "@codemirror/state";
import { EditorView, showTooltip, WidgetType, Decoration, keymap } from "@codemirror/view";
import { minimalSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import { indentUnit } from "@codemirror/language";

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

// ============================================================
// MARK: Version Block Widget
// ============================================================

class VersionBlockWidget extends WidgetType {
  constructor({ versionBlockId, variants }) {
    super();
    this.versionBlockId = versionBlockId;
    this.variants = variants.map((v) => ({ ...v }));
    this.selectedIndex = 0;
    this.innerView = null;
    this.tabEls = [];
    this.toolbar = null;
    this.editorContainer = null;
    this._saveTimer = null;
  }

  eq(other) {
    return this.versionBlockId === other.versionBlockId;
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
    addBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      _versionBlockCallbacks?.onAddVariant(this.versionBlockId, this.variants.length);
    });
    leftGroup.appendChild(addBtn);

    // Right group: ask students + X
    const rightGroup = document.createElement("div");
    rightGroup.className = "cm-version-block-right";

    const askBtn = document.createElement("button");
    askBtn.className = "cm-version-block-btn cm-version-block-ask";
    askBtn.textContent = "ask students";
    rightGroup.appendChild(askBtn);

    const closeBtn = document.createElement("button");
    closeBtn.className = "cm-version-block-btn cm-version-block-close";
    closeBtn.textContent = "✕";
    rightGroup.appendChild(closeBtn);

    this.toolbar.appendChild(leftGroup);
    this.toolbar.appendChild(rightGroup);
    container.appendChild(this.toolbar);

    // Editor area
    this.editorContainer = document.createElement("div");
    this.editorContainer.className = "cm-version-block-editor";
    container.appendChild(this.editorContainer);

    // Build initial tabs and editor
    this.tabEls = [];
    for (let i = 0; i < this.variants.length; i++) {
      tabsContainer.appendChild(this._makeTabEl(i));
    }
    this._updateDeleteBtnVisibility();
    this._mountEditor(this.selectedIndex);

    widgetInstances.set(this.versionBlockId, this);
    return container;
  }

  destroy() {
    clearTimeout(this._saveTimer);
    this.innerView?.destroy();
    this.innerView = null;
    widgetInstances.delete(this.versionBlockId);
  }

  ignoreEvent() {
    return true;
  }

  // -------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------

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

    const delBtn = document.createElement("button");
    delBtn.className = "cm-version-block-tab-delete";
    delBtn.textContent = "×";
    delBtn.title = "Delete variant";
    delBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      _versionBlockCallbacks?.onDeleteVariant(this.versionBlockId, variant.id);
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
        _versionBlockCallbacks?.onRenameVariant(this.versionBlockId, variant.id, newName);
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
    clearTimeout(this._saveTimer);
    this.innerView?.destroy();
    this.innerView = null;

    const variant = this.variants[index];
    const extensions = [
      minimalSetup,
      python(),
      indentUnit.of("    "),
      keymap.of([indentWithTab]),
      EditorView.lineWrapping,
    ];

    if (_readOnly) {
      extensions.push(EditorState.readOnly.of(true));
    } else {
      // TODO: this is not right :)  We should stream updates via the web socket, just like we do for the instructor
      // editor changes.
      extensions.push(
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const code = update.state.doc.toString();
          variant.code = code;
          clearTimeout(this._saveTimer);
          this._saveTimer = setTimeout(() => {
            _versionBlockCallbacks?.onSaveCode(variant.id, this.versionBlockId, code);
          }, 300);
        }),
      );
    }

    this.editorContainer.innerHTML = "";
    this.innerView = new EditorView({
      state: EditorState.create({ doc: variant.code ?? "", extensions }),
      parent: this.editorContainer,
    });
  }

  _updateDeleteBtnVisibility() {
    const onlyOne = this.variants.length <= 1;
    for (const tab of this.tabEls) {
      const delBtn = tab.querySelector(".cm-version-block-tab-delete");
      if (delBtn) delBtn.classList.toggle("hidden", onlyOne);
    }
  }

  // -------------------------------------------------------
  // Public methods called by notifyVariant* functions
  // -------------------------------------------------------

  addVariant(variant) {
    this.variants.push({ ...variant });
    const newIndex = this.variants.length - 1;
    const tabEl = this._makeTabEl(newIndex);
    this.tabsContainer.appendChild(tabEl);
    this._updateDeleteBtnVisibility();
    this._selectTab(newIndex);
  }

  renameVariant(variantId, newName) {
    const index = this.variants.findIndex((v) => v.id === variantId);
    if (index < 0) return;
    this.variants[index].name = newName;
    const labelEl = this.tabEls[index]?.querySelector(".cm-version-block-tab-label");
    if (labelEl) labelEl.textContent = newName;
  }

  deleteVariant(variantId) {
    const index = this.variants.findIndex((v) => v.id === variantId);
    if (index < 0 || this.variants.length <= 1) return;

    const selectedVariantId = this.variants[this.selectedIndex]?.id;
    const deletingSelected = variantId === selectedVariantId;

    this.tabEls[this.selectedIndex]?.classList.remove("selected");
    this.variants.splice(index, 1);
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

  updateVariantCode(variantId, code) {
    const index = this.variants.findIndex((v) => v.id === variantId);
    if (index < 0) return;
    this.variants[index].code = code;
    if (index === this.selectedIndex && this.innerView) {
      const currentCode = this.innerView.state.doc.toString();
      if (currentCode !== code) {
        this.innerView.dispatch({
          changes: { from: 0, to: currentCode.length, insert: code },
        });
      }
    }
  }
}

// ============================================================
// MARK: Exported notify functions (called from socket handlers)
// ============================================================

export function notifyVariantAdded(versionBlockId, variant) {
  widgetInstances.get(versionBlockId)?.addVariant(variant);
}

export function notifyVariantRenamed(versionBlockId, variantId, name) {
  widgetInstances.get(versionBlockId)?.renameVariant(variantId, name);
}

export function notifyVariantDeleted(versionBlockId, variantId) {
  widgetInstances.get(versionBlockId)?.deleteVariant(variantId);
}

export function notifyVariantCodeUpdated(versionBlockId, variantId, code) {
  widgetInstances.get(versionBlockId)?.updateVariantCode(variantId, code);
}

// TODO: add a function here to reconstruct a code editor w/ the contents of all the variants :)
// Or, at least, it should expose each version block's current location and contents.

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
      const { from, to, versionBlockId, variants } = e.value;
      const widget = new VersionBlockWidget({ versionBlockId, variants });
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

export function versionWidgetExtensions(onCreateVersionBlock, callbacks) {
  _versionBlockCallbacks = callbacks ?? null;
  return [
    handleCreateVersionBlock.of(onCreateVersionBlock),
    versionWidgetTooltipField,
    versionWidgetContextMenu,
    versionWidgetTooltipTheme,
    versionBlocksField,
    versionBlockProtection,
  ];
}
