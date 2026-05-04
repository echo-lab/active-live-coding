import { StateEffect, StateField, Facet } from "@codemirror/state";
import { EditorView, showTooltip } from "@codemirror/view";

// Facet: injected callback, receives { instructor_code, default_answer, code_line_context_start, code_line_context_end }
export const handleCreateCodeExercise = Facet.define({
  combine: (values) => (values.length ? values.at(-1) : null),
});

const showFillInBlankTooltip = StateEffect.define();
const hideFillInBlankTooltip = StateEffect.define();

export const fillInBlankTooltipField = StateField.define({
  create() {
    return null;
  },
  update(tooltip, tr) {
    if (tr.docChanged || tr.selection) tooltip = null;
    for (let e of tr.effects) {
      if (e.is(showFillInBlankTooltip)) tooltip = e.value;
      if (e.is(hideFillInBlankTooltip)) tooltip = null;
    }
    return tooltip;
  },
  provide: (f) =>
    showTooltip.computeN([f], (state) => {
      let t = state.field(f);
      return t ? [t] : [];
    }),
});

function createFillInBlankTooltipDOM(view) {
  let div = document.createElement("div");
  div.className = "cm-tooltip-fill-in-blank";
  div.textContent = "Ask for code";
  div.addEventListener("mousedown", (e) => {
    e.preventDefault(); // Prevent editor blur/selection-change from dismissing the tooltip
    view.dispatch({ effects: hideFillInBlankTooltip.of(null) });

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

    let callback = state.facet(handleCreateCodeExercise);
    callback &&
      callback({ instructor_code, default_answer, code_line_context_start, code_line_context_end });
  });
  return div;
}

export const fillInBlankContextMenu = EditorView.domEventHandlers({
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
      effects: showFillInBlankTooltip.of({
        pos: tooltipPos,
        above: true,
        arrow: true,
        create: (v) => ({ dom: createFillInBlankTooltipDOM(v) }),
      }),
    });
    return true;
  },
});

export const fillInBlankTooltipTheme = EditorView.baseTheme({
  ".cm-tooltip.cm-tooltip-fill-in-blank": {
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

export function fillInBlankExtensions(onCreateCodeExercise) {
  return [
    handleCreateCodeExercise.of(onCreateCodeExercise),
    fillInBlankTooltipField,
    fillInBlankContextMenu,
    fillInBlankTooltipTheme,
  ];
}
