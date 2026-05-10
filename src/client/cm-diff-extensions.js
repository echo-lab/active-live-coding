import { EditorView, minimalSetup } from "codemirror";
import { StateEffect, StateField, RangeSetBuilder } from "@codemirror/state";
import { python } from "@codemirror/lang-python";
import { indentUnit } from "@codemirror/language";
import { capLength } from "./cm-extensions.js";

import { GutterMarker, gutter, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { computeLineDiff, toGutterState } from "./diff-utils.js";

// TODO: I think we can get rid of this file. 

////////////////////////////////////////////////////////////////////////////////////////////////////////////
// MARK: diff gutter
////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const setExerciseBaseCode = StateEffect.define();


const diffStateField = StateField.define({
  create() {
    return { baseCode: null, status: [], deletionsBefore: new Set() };
  },
  update(state, tr) {
    let baseCode = state.baseCode;
    for (let e of tr.effects) {
      if (e.is(setExerciseBaseCode)) baseCode = e.value;
    }
    if (!tr.docChanged && baseCode === state.baseCode) return state;
    if (baseCode === null) return { baseCode: null, status: [], deletionsBefore: new Set() };
    const baseLines = baseCode.split("\n");
    const currentLines = tr.newDoc.toString().split("\n");
    const { status, deletionsBefore } = toGutterState(computeLineDiff(baseLines, currentLines));
    return { baseCode, status, deletionsBefore };
  },
});

class DiffGutterMarker extends GutterMarker {
  constructor(cls) {
    super();
    this.cls = cls;
  }
  toDOM() {
    let el = document.createElement("div");
    el.className = this.cls;
    return el;
  }
}

const addedMarker = new DiffGutterMarker("cm-diff-bar cm-diff-added");
const modifiedMarker = new DiffGutterMarker("cm-diff-bar cm-diff-modified");
const deletedMarker = new DiffGutterMarker("cm-diff-bar cm-diff-deleted");

const diffGutterColumn = gutter({
  class: "cm-diff-gutter",
  markers(view) {
    const { status, deletionsBefore, baseCode } = view.state.field(diffStateField);
    if (baseCode === null) return new RangeSetBuilder().finish();
    const builder = new RangeSetBuilder();
    const doc = view.state.doc;
    for (let lineNum = 1; lineNum <= doc.lines; lineNum++) {
      const lineIndex = lineNum - 1;
      const lineStart = doc.line(lineNum).from;
      const lineStatus = status[lineIndex];
      if (lineStatus === "added") {
        builder.add(lineStart, lineStart, addedMarker);
      } else if (lineStatus === "modified") {
        builder.add(lineStart, lineStart, modifiedMarker);
      } else if (deletionsBefore.has(lineIndex)) {
        // Deletion occurred before this unchanged line — show indicator at its bottom
        builder.add(lineStart, lineStart, deletedMarker);
      }
    }
    return builder.finish();
  },
  initialSpacer: () => addedMarker,
});

const diffGutterTheme = EditorView.baseTheme({
  ".cm-diff-gutter": { width: "4px" },
  ".cm-diff-gutter .cm-gutterElement": { padding: "0", width: "4px" },
  ".cm-diff-bar": { width: "4px", height: "100%", display: "block" },
  ".cm-diff-added": { backgroundColor: "#2ea043" },
  ".cm-diff-modified": { backgroundColor: "#e3b341" },
  ".cm-diff-deleted": {
    backgroundColor: "transparent",
    position: "relative",
  },
  ".cm-diff-deleted::after": {
    content: '""',
    position: "absolute",
    bottom: "-4px",
    left: "0",
    width: "0",
    height: "0",
    borderLeft: "4px solid #e5534b",
    borderTop: "4px solid transparent",
    borderBottom: "4px solid transparent",
  },
});

export const exerciseDiffGutter = [diffStateField, diffGutterColumn, diffGutterTheme];

export function reviewEditorExtensions({ isEditable = false, showLineNumbers = false }) {
  return [
    minimalSetup,
    python(),
    indentUnit.of("    "),
    ...(showLineNumbers ? [lineNumbers()] : []),
    ...(isEditable ? [highlightActiveLine()] : []),
  ];
}