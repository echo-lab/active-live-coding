import { basicSetup, minimalSetup, EditorView } from "codemirror";
import { EditorState, StateEffect, StateField, Facet } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import { python } from "@codemirror/lang-python";

import { showTooltip, Decoration, WidgetType, lineNumbers, highlightActiveLine } from "@codemirror/view";

const CONTEXT_LINES = 1; // How many lines above/below the selected code to capture
const MAX_DOC_LENGTH = 100000;

// Note: we can probably get rid of this later...
function makeID() {
  return Date.now();
}

// Given an Editor state, get the current selection as well as the surrounding context.
// Should return an object: {selection: <string>, context: <string>}
function getSelectionAndContext(state, range) {
  let { from, to } = range;
  let doc = state.doc;

  // First, let's get the selected text as a string.
  let selection = doc.slice(from, to).toString();
  let selectionPosition = { from, to };

  // Now we should get the surrounding context!
  // let [a, b] = [from, to]
  let startLineNumber = Math.max(1, doc.lineAt(from).number - CONTEXT_LINES);
  let endLineNumber = Math.min(
    doc.lines,
    doc.lineAt(to).number + CONTEXT_LINES
  );

  let contextFrom = doc.line(startLineNumber).from;
  let contextTo = doc.line(endLineNumber).to;

  let context = doc.slice(contextFrom, contextTo).toString();
  let relativeSelectionPosition = {
    from: from - contextFrom,
    to: to - contextFrom,
  };

  return {
    selection,
    context,
    selectionPosition,
    relativeSelectionPosition,
  };
}

function getCleanRange(state, range) {
  let { head, from, to } = range;
  return { head, from, to };
}

////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Tooltip for creating a new Code Anchor
////////////////////////////////////////////////////////////////////////////////////////////////////////////

// const handleNewCodeAnchorCompartment = new Compartment();

export const handleNewCodeAnchor = Facet.define({
  combine: (values) => (values.length ? values.at(-1) : () => {}),
});

export const codeAnchorTooltipField = StateField.define({
  create: getCodeAnchorTooltip,
  update(tooltips, tr) {
    if (!tr.docChanged && !tr.selection) return tooltips;
    return getCodeAnchorTooltip(tr.state);
  },
  provide: (f) => showTooltip.computeN([f], (state) => state.field(f)),
});

function getCodeAnchorTooltip(state) {
  // TODO: Maybe only use on state.selection.main??
  return state.selection.ranges
    .filter((range) => !range.empty)
    .map((range) => ({
      pos: getCleanRange(state, range).head,
      above: true,
      arrow: true,
      create: (view) => ({
        dom: createCreateNoteTooltip(view),
      }),
    }));
}

function createCreateNoteTooltip(view) {
  let state = view.state;
  let div = document.createElement("div");
  div.className = "cm-tooltip-add-note";
  div.textContent = "Add to Notes";
  let onClick = () => {
    // Make an ID and get the selected code.
    let id = makeID();
    // let fullCode = state.doc.toJSON();
    let fullCode = state.doc.toString();
    // let { from, to } = getCleanRange(view.state, state.selection.main);
    // let selection = state.doc.slice(from, to).toString();

    let { selection, context, selectionPosition, relativeSelectionPosition } =
      getSelectionAndContext(view.state, state.selection.main);

    // console.log({ selection, context, relativeSelectionPosition, fullCode, id });

    // Tell the React component about the new code anchor.
    let handleCodeAnchor = state.facet(handleNewCodeAnchor);
    handleCodeAnchor &&
      handleCodeAnchor({
        selection,
        context,
        selectionPosition,
        relativeSelectionPosition,
        fullCode,
        id,
      });

    // Start highlighting the code
    // view.dispatch({
    //   effects: addCodeAnchor.of({ from, to, id }),
    // });
  };
  div.addEventListener("click", onClick);
  return div;
}

// TODO: move this to CSS?
export const codeAnchorTooltipBaseTheme = EditorView.baseTheme({
  ".cm-tooltip.cm-tooltip-add-note": {
    backgroundColor: "#66b",
    color: "white",
    border: "none",
    padding: "2px 7px",
    borderRadius: "4px",
    cursor: "pointer",
    "& .cm-tooltip-arrow:before": {
      borderTopColor: "#66b",
    },
    "& .cm-tooltip-arrow:after": {
      borderTopColor: "transparent",
    },
  },
});

////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Following instructor's cursor!
////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const setInstructorSelection = StateEffect.define();

export const instructorHighlightField = StateField.define({
  create() {
    return Decoration.none;
  },
  update(highlight, tr) {
    highlight = highlight.map(tr.changes); // Just in case lol
    for (let e of tr.effects) {
      if (!e.is(setInstructorSelection)) continue;
      let { anchor, head } = e.value;
      let [from, to] = [anchor, head];
      if (from > to) {
        [from, to] = [to, from];
      }
      highlight = Decoration.none;
      if (from !== to) {
        highlight = highlight.update({
          add: [instructorHighlightMark.range(from, to)],
        });
      }
    }
    return highlight;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const instructorHighlightMark = Decoration.mark({
  class: "cm-highlight",
});

export const instructorCursorField = StateField.define({
  create() {
    return Decoration.none;
  },
  update(cursor, tr) {
    cursor = cursor.map(tr.changes);
    for (let e of tr.effects) {
      if (!e.is(setInstructorSelection)) continue;
      let { head } = e.value;
      cursor = Decoration.none.update({
        add: [instructorCursorWidget.range(head, head)],
      });
    }
    return cursor;
  },
  provide: (f) => EditorView.decorations.from(f),
});

class CursorWidget extends WidgetType {
  constructor() {
    super();
  }

  toDOM() {
    let res = document.createElement("span");
    res.className = "cm-instructor-cursor";
    return res;
  }

  ignoreEvent() {
    return false;
  }
}

const instructorCursorWidget = Decoration.widget({
  widget: new CursorWidget(),
});

////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Export related extensions in groups
////////////////////////////////////////////////////////////////////////////////////////////////////////////
export const basicExtensions = [
  basicSetup,
  python(),
  indentUnit.of("    "),
];

export const followInstructorExtensions = [
  instructorHighlightField,
  instructorCursorField,
];

export let codeSnapshotFields = (onNewSnapshot) => [
  handleNewCodeAnchor.of(onNewSnapshot),
  codeAnchorTooltipField,
  codeAnchorTooltipBaseTheme,
];

export const capLength = [
  EditorState.changeFilter.of((tr) => tr.newDoc.length < MAX_DOC_LENGTH),
];

export function reviewEditorExtensions({ isEditable = false, showLineNumbers = false }) {
  return [
    minimalSetup,
    python(),
    indentUnit.of("    "),
    ...(showLineNumbers ? [lineNumbers()] : []),
    ...(isEditable ? [highlightActiveLine()] : []),
  ];
}
