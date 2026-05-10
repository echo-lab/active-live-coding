import { EditorState, StateEffect, StateField, Facet, EditorSelection } from "@codemirror/state";
import { EditorView, showTooltip, keymap, WidgetType, Decoration } from "@codemirror/view";
import { minimalSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import { indentUnit } from "@codemirror/language";

// ============================================================
// MARK: Tooltip for instructor to create a Version Widget
// ============================================================

// Facet: injected callback, receives { instructor_code, default_answer, code_line_context_start, code_line_context_end }
export const handleAskStudentsForCode = Facet.define({
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
    e.preventDefault(); // Prevent editor blur/selection-change from dismissing the tooltip
    view.dispatch({ effects: hideVersionWidgetTooltip.of(null) });

    let state = view.state;
    let { from, to } = state.selection.main;
    let startLine = state.doc.lineAt(from);
    let endLine = state.doc.lineAt(to);
    let code_line_context_start = startLine.number;
    // If selection ends exactly at the start of a line, don't count that line
    let code_line_context_end =
      to > from && to === endLine.from ? endLine.number - 1 : endLine.number;

    let firstLine = state.doc.line(code_line_context_start);
    let lastLine = state.doc.line(code_line_context_end);
    let default_answer = state.doc.sliceString(firstLine.from, lastLine.to);
    let instructor_code = state.doc.toString();

    let callback = state.facet(handleAskStudentsForCode);
    callback &&
      callback({ instructor_code, default_answer, code_line_context_start, code_line_context_end });
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

export function versionWidgetExtensions(onCreateCodeExercise) {
  return [
    handleAskStudentsForCode.of(onCreateCodeExercise),
    versionWidgetTooltipField,
    versionWidgetContextMenu,
    versionWidgetTooltipTheme,
  ];
}
