import { StateEffect, StateField, Facet } from "@codemirror/state";
import { EditorView, showTooltip, WidgetType, Decoration } from "@codemirror/view";

// ============================================================
// MARK: Version Block Widget
// ============================================================

class VersionBlockWidget extends WidgetType {
  constructor({ versionBlockId, variantCode }) {
    super();
    this.versionBlockId = versionBlockId;
    this.variantCode = variantCode;
  }

  eq(other) {
    return this.versionBlockId === other.versionBlockId;
  }

  toDOM() {
    const container = document.createElement("div");
    container.className = "cm-version-block-widget";
    const placeholder = document.createElement("p");
    placeholder.textContent = "TODO: implement the Version Widget";
    container.appendChild(placeholder);
    return container;
  }

  ignoreEvent() {
    return true;
  }
}

// StateEffect dispatched to add a version block decoration to the editor.
// value: { from, to, versionBlockId, variantCode }
export const addVersionBlockEffect = StateEffect.define();

// StateField that owns all version block replacement decorations.
export const versionBlocksField = StateField.define({
  create: () => Decoration.none,
  update(decorations, tr) {
    decorations = decorations.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(addVersionBlockEffect)) continue;
      const { from, to, versionBlockId, variantCode } = e.value;
      const widget = new VersionBlockWidget({ versionBlockId, variantCode });
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

// Facet: injected callback, receives { variantCode, from, to }
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
    // If selection ends exactly at the start of a line, don't count that line
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

    // Move cursor to click position only if it's outside an existing selection
    let { from, to } = view.state.selection.main;
    if (pos < from || pos > to) {
      view.dispatch({ selection: { anchor: pos } });
    }

    // Second dispatch so the selection-change above doesn't null out the tooltip
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

export function versionWidgetExtensions(onCreateVersionBlock) {
  return [
    handleCreateVersionBlock.of(onCreateVersionBlock),
    versionWidgetTooltipField,
    versionWidgetContextMenu,
    versionWidgetTooltipTheme,
    versionBlocksField,
  ];
}
