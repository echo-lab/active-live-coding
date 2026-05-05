import { EditorState, StateEffect, StateField, Facet } from "@codemirror/state";
import { EditorView, showTooltip, keymap, WidgetType, Decoration } from "@codemirror/view";
import { minimalSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import { indentUnit } from "@codemirror/language";

// ============================================================
// MARK: Fill-in-the-blank widget (displayed in the main editor)
// ============================================================

// Module-level reference to the currently mounted widget, so external code
// can read the student's current answer via getCurrentFillInBlankCode().
let _currentWidget = null;

export function getCurrentFillInBlankCode() {
  return _currentWidget?.getVisibleCode() ?? null;
}

class FillInBlankWidget extends WidgetType {

  constructor({ prefixCode, suffixCode, currentAnswer, showButtons, onSubmit, onRun }) {
    super();
    this.prefixCode = prefixCode ?? "";
    this.suffixCode = suffixCode ?? "";
    this.currentAnswer = currentAnswer;
    this.showButtons = showButtons;
    this.onSubmit = onSubmit;
    this.onRun = onRun;
    // +1 for the '\n' separator between prefix and visible content
    this.prefixLength = prefixCode ? prefixCode.length + 1 : 0;
    this.innerView = null;
  }

  // TODO: not sure if this is necessary?
  eq(other) {
    // Only recreate the DOM if prefix context or button visibility changes.
    // defaultAnswer is only the initial content — we don't reset on re-eq.
    return this.prefixCode === other.prefixCode && this.showButtons === other.showButtons;
    // return true;
  }

  updateBorderState(container, submitBtn) {
    container.classList.remove("cm-fitb-dirty", "cm-fitb-submitted");
    let isSubmitted = false;
    if (this.submittedCode === null) {
      if (this.hasBeenEdited) container.classList.add("cm-fitb-dirty");
    } else {
      if (this.getVisibleCode() === this.submittedCode) {
        container.classList.add("cm-fitb-submitted");
        isSubmitted = true;
      } else {
        container.classList.add("cm-fitb-dirty");
      }
    }
    if (submitBtn) submitBtn.disabled = isSubmitted;
  }

  toDOM() {
    const container = document.createElement("div");
    container.className = "cm-fill-in-blank-widget";
    this.submittedCode = null;
    this.hasBeenEdited = false;
    this.submitBtn = null;

    if (this.showButtons) {
      const bar = document.createElement("div");
      bar.className = "cm-fitb-button-bar";

      const runBtn = document.createElement("button");
      runBtn.textContent = "Run";
      runBtn.className = "cm-fitb-run-btn";
      runBtn.addEventListener("click", async () => {
        if (runBtn.disabled) return;
        runBtn.disabled = true;
        runBtn.textContent = "Running...";
        let code = `${this.prefixCode}\n${this.getVisibleCode()}\n${this.suffixCode}`;
        await this.onRun?.(code);
        runBtn.disabled = false;
        runBtn.textContent = "Run";
      });

      const submitBtn = document.createElement("button");
      submitBtn.disabled = true;
      submitBtn.textContent = "Submit";
      submitBtn.className = "cm-fitb-submit-btn";
      this.submitBtn = submitBtn;
      submitBtn.addEventListener("click", async () => {
        const code = getCurrentFillInBlankCode();
        if (code == null) return;
        await this.onSubmit?.(code);
        // submitBtn.textContent = "Resubmit";  // Move the button if we want to say `resubmit'
        this.submittedCode = code;
        this.updateBorderState(container, submitBtn);
        submitBtn.blur();
      });

      container.appendChild(runBtn);
      container.appendChild(submitBtn);
    }

    const editorContainer = document.createElement("div");
    container.appendChild(editorContainer);

    // Build the inner editor document: hidden prefix + visible editable region.
    const doc = this.prefixCode
      ? this.prefixCode + "\n" + this.currentAnswer
      : this.currentAnswer;

    const prefixLength = this.prefixLength;

    // Extensions for hiding and protecting the prefix.
    const prefixExtensions = prefixLength > 0 ? [
      // Hide prefix lines with a zero-height block replacement.
      EditorView.decorations.of(
        Decoration.set([
          Decoration.replace({ block: true }).range(0, prefixLength),
        ])
      ),
      // Prevent any edits inside the hidden prefix region.
      EditorState.transactionFilter.of((tr) => {
        if (!tr.docChanged) return tr;
        let blocked = false;
        tr.changes.iterChanges((fromA) => {
          if (fromA < prefixLength) blocked = true;
        });
        return blocked ? [] : tr;
      }),
    ] : [];

    this.innerView = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [
          minimalSetup,
          python(),
          indentUnit.of("    "),
          keymap.of([indentWithTab]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            this.hasBeenEdited = true;
            this.updateBorderState(container, this.submitBtn);
          }),
          ...prefixExtensions,
        ],
      }),
      parent: editorContainer,
    });

    _currentWidget = this;
    return container;
  }

  destroy() {
    this.innerView?.destroy();
    this.innerView = null;
    if (_currentWidget === this) _currentWidget = null;
  }

  getVisibleCode() {
    if (!this.innerView) return "";
    return this.innerView.state.doc.toString().slice(this.prefixLength);
  }

  // Prevent the outer editor from consuming events inside the widget.
  ignoreEvent() {
    return true;
  }
}

// StateEffect dispatched on the outer editor to activate/deactivate a FITB widget.
// value: { exercise, showButtons } to activate, or null to deactivate.
export const activateFillInBlankEffect = StateEffect.define();

// StateField that owns the replacement decoration in the outer editor.
export const fillInBlankViewField = StateField.define({
  create: () => Decoration.none,
  update(decorations, tr) {
    for (const e of tr.effects) {
      if (!e.is(activateFillInBlankEffect)) continue;

      if (e.value === null) return Decoration.none;

      const { exercise, showButtons, currentAnswer, onSubmit, onRun } = e.value;
      const {
        instructor_code,
        default_answer,
        code_line_context_start,
        code_line_context_end,
      } = exercise;

      const allLines = instructor_code.split("\n");
      const prefixCode = allLines.slice(0, code_line_context_start - 1).join("\n");
      const suffixCode = allLines.slice(code_line_context_end).join("\n");

      const widget = new FillInBlankWidget({
        prefixCode,
        suffixCode,
        currentAnswer: currentAnswer ?? default_answer ?? "",
        showButtons,
        onSubmit,
        onRun,
      });

      const doc = tr.state.doc;
      if (code_line_context_start > doc.lines) return Decoration.none;
      const safeEnd = Math.min(code_line_context_end, doc.lines);

      const startLine = doc.line(code_line_context_start);
      const endLine = doc.line(safeEnd);

      return Decoration.set([
        Decoration.replace({ widget, block: true }).range(startLine.from, endLine.to),
      ]);
    }
    // Keep decoration in sync as doc changes (e.g. instructor typing on other lines).
    return decorations.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ============================================================
// MARK: Tooltip for instructor to create FITB exercises
// ============================================================

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
