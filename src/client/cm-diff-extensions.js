import { EditorView, minimalSetup } from "codemirror";
import { EditorState, StateEffect, StateField, RangeSetBuilder, Text } from "@codemirror/state";
import { python } from "@codemirror/lang-python";
import { indentUnit } from "@codemirror/language";
import { capLength } from "./cm-extensions.js";

import { Decoration, WidgetType, gutter, GutterMarker, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { stripTrailingWhitespace, computeLineDiff, toGutterState, buildDiffSegments } from "./diff-utils.js";


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


////////////////////////////////////////////////////////////////////////////////////////////////////////////
// MARK: Diff Summary Display
////////////////////////////////////////////////////////////////////////////////////////////////////////////

// NOTE: these are all essentially helpers for createForkDisplay(), which is exported below :)
const setForkDecorations = StateEffect.define();
const forkDecorationsField = StateField.define({
  create: () => Decoration.none,
  update(decs, tr) {
    for (const e of tr.effects) if (e.is(setForkDecorations)) return e.value;
    return decs.map(tr.changes);
  },
  provide: f => EditorView.decorations.from(f),
});

class RemovedLinesWidget extends WidgetType {
  constructor(lines) {
    super();
    this.lines = lines;
  }
  toDOM() {
    const div = document.createElement("div");
    div.className = "cm-fork-removed-block";
    for (const line of this.lines) {
      const row = document.createElement("div");
      row.className = "cm-fork-removed-line";
      row.textContent = `- ${line}`;
      div.appendChild(row);
    }
    return div;
  }
  eq(other) {
    return this.lines.length === other.lines.length &&
      this.lines.every((l, i) => l === other.lines[i]);
  }
}

class CollapsedBarWidget extends WidgetType {
  constructor(gapId, onExpand) {
    super();
    this.gapId = gapId;
    this.onExpand = onExpand;
  }
  toDOM() {
    const bar = document.createElement("div");
    bar.className = "cm-fork-collapsed-bar";
    bar.textContent = "• • •";
    bar.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.onExpand(this.gapId);
    });
    return bar;
  }
  eq(other) {
    return this.gapId === other.gapId;
  }
}

function buildForkDecorations(doc, segments, collapsedGaps, onExpand) {
  const decs = [];

  for (const seg of segments) {
    if (seg.type === "removed") {
      const pos = seg.beforeNewLine <= doc.lines
        ? doc.line(seg.beforeNewLine).from
        : doc.length;
      decs.push({ from: pos, to: pos, priority: 0,
        dec: Decoration.widget({ widget: new RemovedLinesWidget(seg.lines), block: true, side: -1 }) });
    } else if (seg.type === "added") {
      const lineFrom = doc.line(seg.newLine).from;
      decs.push({ from: lineFrom, to: lineFrom, priority: 1,
        dec: Decoration.line({ class: "cm-fork-added" }) });
    } else if (seg.type === "gap" && collapsedGaps.has(seg.id)) {
      const from = doc.line(seg.newLineStart).from;
      const to = seg.newLineEnd < doc.lines
        ? doc.line(seg.newLineEnd + 1).from
        : doc.line(seg.newLineEnd).to;
      decs.push({ from, to, priority: 2,
        dec: Decoration.replace({ widget: new CollapsedBarWidget(seg.id, onExpand), block: true }) });
    }
  }

  decs.sort((a, b) => a.from - b.from || a.to - b.to || a.priority - b.priority);

  const builder = new RangeSetBuilder();
  for (const { from, to, dec } of decs) {
    builder.add(from, to, dec);
  }
  return builder.finish();
}

function buildDiffControls() {
  const el = document.createElement("span");
  el.className = "fork-diff-controls";

  const collapseLink = document.createElement("a");
  collapseLink.className = "fork-diff-link";
  collapseLink.textContent = "collapse all";

  const sep = document.createElement("span");
  sep.className = "fork-diff-sep";
  sep.textContent = " | ";

  const expandLink = document.createElement("a");
  expandLink.className = "fork-diff-link";
  expandLink.textContent = "expand all";

  el.append(collapseLink, sep, expandLink);
  return { el, collapseLink, expandLink };
}

function updateControlLinks(controls, collapsedGaps, gapCount) {
  controls.collapseLink.classList.toggle("disabled", collapsedGaps.size === gapCount);
  controls.expandLink.classList.toggle("disabled", collapsedGaps.size === 0);
}

export function reviewEditorExtensions({ isEditable = false, showLineNumbers = false }) {
  return [
    minimalSetup,
    python(),
    indentUnit.of("    "),
    ...(showLineNumbers ? [lineNumbers()] : []),
    ...(isEditable ? [highlightActiveLine()] : []),
  ];
}

export function createForkDisplay(code, originalCode, { label = "Your submission:" } = {}) {
  const cleanCode = stripTrailingWhitespace(code);
  const cleanOrig = stripTrailingWhitespace(originalCode);
  const diff = computeLineDiff(cleanOrig.split("\n"), cleanCode.split("\n"));
  const { segments, gapCount, hasChanges } = buildDiffSegments(diff);
  const collapsedGaps = new Set(segments.filter(s => s.type === "gap").map(s => s.id));

  const wrapper = document.createElement("div");
  wrapper.className = "answer-display-collapsible";

  const header = document.createElement("div");
  header.className = "answer-display-header";

  const caret = document.createElement("span");
  caret.className = "answer-display-caret";
  caret.textContent = "▼";

  const labelEl = document.createElement("span");
  labelEl.className = "answer-display-label";
  labelEl.textContent = label;

  const controls = buildDiffControls();
  header.append(caret, labelEl, controls.el);

  const content = document.createElement("div");
  content.className = "answer-display-content";

  if (!hasChanges) {
    const msg = document.createElement("div");
    msg.className = "fork-no-changes";
    msg.textContent = "(no changes from original)";
    content.appendChild(msg);
    controls.el.hidden = true;
  } else {
    const editorContainer = document.createElement("div");
    const view = new EditorView({
      state: EditorState.create({
        doc: Text.of(cleanCode.split("\n")),
        extensions: [
          ...reviewEditorExtensions({ isEditable: false }),
          forkDecorationsField,
          EditorView.editable.of(false),
          capLength,
        ],
      }),
      parent: editorContainer,
    });
    content.appendChild(editorContainer);

    const redecorate = () => {
      const decs = buildForkDecorations(view.state.doc, segments, collapsedGaps, expand);
      view.dispatch({ effects: setForkDecorations.of(decs) });
      updateControlLinks(controls, collapsedGaps, gapCount);
    };

    const expand = (gapId) => { collapsedGaps.delete(gapId); redecorate(); };
    controls.collapseLink.addEventListener("click", () => {
      segments.filter(s => s.type === "gap").forEach(s => collapsedGaps.add(s.id));
      redecorate();
    });
    controls.expandLink.addEventListener("click", () => {
      collapsedGaps.clear();
      redecorate();
    });

    requestAnimationFrame(redecorate);
  }

  header.addEventListener("click", (e) => {
    if (e.target.closest(".fork-diff-controls")) return;
    const isExpanded = !content.hidden;
    content.hidden = isExpanded;
    caret.textContent = isExpanded ? "▶" : "▼";
  });

  wrapper.append(header, content);
  return wrapper;
}