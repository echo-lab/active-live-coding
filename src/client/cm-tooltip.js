import { StateEffect, StateField, Facet } from "@codemirror/state";
import { EditorView, showTooltip } from "@codemirror/view";

export const handleCreateVersionBlock = Facet.define({
  combine: (values) => (values.length ? values.at(-1) : null),
});

export const handleCreatePoll = Facet.define({
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
  let container = document.createElement("div");
  container.className = "cm-tooltip-version-widget";

  function handleShareCodeBlock() {
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
    callback && callback({ variantCode, from: firstLine.from, to: lastLine.to, autoStartExercise: true });
  }

  function handleCreatePollClick() {
    view.dispatch({ effects: hideVersionWidgetTooltip.of(null) });
    let state = view.state;
    let callback = state.facet(handleCreatePoll);
    let { from, to } = state.selection.main;
    if (from === to) {
      callback && callback({ from: null, to: null });
      return;
    }
    let startLine = state.doc.lineAt(from);
    let endLine = state.doc.lineAt(to);
    let lineStart = startLine.number;
    let lineEnd = to > from && to === endLine.from ? endLine.number - 1 : endLine.number;
    let firstLine = state.doc.line(lineStart);
    let lastLine = state.doc.line(lineEnd);
    callback && callback({ from: firstLine.from, to: lastLine.to });
  }

  let createPollOption = document.createElement("div");
  createPollOption.className = "cm-tooltip-version-option";
  createPollOption.textContent = "Create Poll";
  createPollOption.addEventListener("mousedown", (e) => { e.preventDefault(); handleCreatePollClick(); });

  let shareCodeBlockOption = document.createElement("div");
  shareCodeBlockOption.className = "cm-tooltip-version-option";
  shareCodeBlockOption.textContent = "Share code block";
  shareCodeBlockOption.addEventListener("mousedown", (e) => { e.preventDefault(); handleShareCodeBlock(); });

  container.appendChild(createPollOption);
  container.appendChild(shareCodeBlockOption);
  return container;
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
    backgroundColor: "#5861ff",
    color: "white",
    border: "none",
    borderRadius: "4px",
    padding: "2px 0",
    "& .cm-tooltip-arrow:before": {
      borderTopColor: "##5861ff",
    },
    "& .cm-tooltip-arrow:after": {
      borderTopColor: "transparent",
    },
  },
  ".cm-tooltip-version-option": {
    padding: "3px 10px",
    cursor: "pointer",
  },
  ".cm-tooltip-version-option:hover": {
    backgroundColor: "#9298ff",
  },
  ".cm-tooltip-version-option:not(:last-child)": {
    borderBottom: "1px solid rgba(255,255,255,0.25)",
  },
});

export function versionWidgetTooltipExtensions(onCreateVersionBlock, onCreatePoll) {
  return [
    handleCreateVersionBlock.of(onCreateVersionBlock),
    handleCreatePoll.of(onCreatePoll),
    versionWidgetTooltipField,
    versionWidgetContextMenu,
    versionWidgetTooltipTheme,
  ];
}
