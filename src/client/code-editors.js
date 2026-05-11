import { EditorView, minimalSetup } from "codemirror";
import { EditorState, Text, ChangeSet, Compartment } from "@codemirror/state";
import { python } from "@codemirror/lang-python";
import { indentUnit } from "@codemirror/language";
import {
  basicExtensions,
  capLength,
  codeSnapshotFields,
  followInstructorExtensions,
  setInstructorSelection,
} from "./cm-extensions.js";
import { exerciseDiffGutter, setExerciseBaseCode, reviewEditorExtensions } from "./cm-diff-extensions.js";
import { activateFillInBlankEffect, fillInBlankViewField } from "./cm-fill-in-the-blank.js";
import { addVersionBlockEffect, VersionBlockWidget, versionBlocksField, versionWidgetExtensions } from "./cm-version-widget.js";
import { GET_JSON_REQUEST, POST_JSON_REQUEST } from "./utils.js";
import { SOCKET_MESSAGE_TYPE } from "../shared-constants.js";
import { keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";

const FLUSH_CHANGES_FREQ = /*seconds=*/ 5 * 1000;

// MARK: Follow Instructor (w/ exercises)
export class StudentCodeEditor {
  // Initialize CodeMirror and listen for instructor updates.
  constructor(node, doc, docVersion, socket, sessionId, extraExtensions = []) {
    this.docVersion = docVersion;
    this.sessionId = sessionId;
    let state = EditorState.create({
      doc: Text.of(doc),
      extensions: [
        ...basicExtensions,
        // ...codeSnapshotFields(onNewSnapshot),
        ...followInstructorExtensions,
        EditorView.editable.of(false),
        capLength,
        ...extraExtensions,
      ],
    });
    this.view = new EditorView({ state, parent: node });
    this.active = true;
    this.pendingQueue = []; // if we fall behind, buffer instructor edits.

    socket.on(
      SOCKET_MESSAGE_TYPE.INSTRUCTOR_EDIT,
      this.handleInstructorEdit.bind(this)
    );
    socket.on(
      SOCKET_MESSAGE_TYPE.INSTRUCTOR_CURSOR,
      this.handleInstructorCursorChange.bind(this)
    );
  }

  getDocVersion() {
    return this.docVersion;
  }

  handleInstructorCursorChange({ anchor, head }) {
    if (anchor > this.view.state.doc.length) return;
    if (head > this.view.state.doc.length) return;
    this.view.dispatch({
      effects: setInstructorSelection.of({ anchor, head }),
    });
  }

  async handleInstructorEdit({ changes, id }) {
    if (!this.active) return;

    // ONLY FOR TESTING!
    // if (id === 3) {
    //   return;
    // }

    if (id !== this.docVersion) {
      console.log(`Got id=${id} but on version ${this.docVersion}`);
      this.pendingQueue.push({ changes, id }); // Stash it so we don't lose it.
      if (this.catchupPending) return; // Don't hammer the server if we're already trying to catch up
      this.catchupPending = true;
      await this.catchUpOnChanges();
      this.catchupPending = false;

      if (id > this.docVersion) {
        console.warn("failed to catch up on changes! Should reload...");
        alert(
          "Error: Failed to sync with instructor. Please reload the page to sync."
        );
        this.active = false;
      }

      this.view.dispatch({
        effects: setInstructorSelection.of({ anchor: 0, head: 0 }),
      });
      this.pendingQueue.forEach(({ changes, id }) => {
        if (id !== this.docVersion) return;
        console.log("Catching up on change: ", id);
        this.docVersion++;
        this.view.dispatch({ changes: ChangeSet.fromJSON(changes) });
      });
      this.pendingQueue = [];
      return;
    }

    // console.log("Normal dispatch for change: ", id);
    // We're good now!
    changes = ChangeSet.fromJSON(changes);
    this.docVersion++;
    this.view.dispatch({ changes });
  }

  async catchUpOnChanges() {
    const response = await fetch(
      `/instructor-changes/${this.sessionId}/${this.docVersion}`,
      GET_JSON_REQUEST
    );
    // // ONLY FOR TESTING
    // let twoSeconds = new Promise((resolve) => setTimeout(resolve, 2000));
    // await twoSeconds;

    let res = await response.json();
    if (!res.changes) return;

    // IMPORTANT: reset the instructor's cursor selection or else the editor gets sad.
    this.view.dispatch({
      effects: setInstructorSelection.of({ anchor: 0, head: 0 }),
    });
    for (let { change, changeNumber } of res.changes) {
      if (changeNumber !== this.docVersion) continue;
      console.log("Catching up on change: ", changeNumber);
      this.docVersion++;
      this.view.dispatch({ changes: ChangeSet.fromJSON(change) });
    }
  }

  currentCode() {
    return this.view.state.doc.toString();
  }

  stopFollowing() {
    this.active = false;
  }

  // activateFillInBlank(exercise, currentAnswer, onSubmit, onRun) {
  //   const { code_line_context_start } = exercise;
  //   const effects = [activateFillInBlankEffect.of({ exercise, showButtons: true, currentAnswer, onSubmit, onRun })];
  //   if (code_line_context_start >= 1 && code_line_context_start <= this.view.state.doc.lines) {
  //     const line = this.view.state.doc.line(code_line_context_start);
  //     effects.push(EditorView.scrollIntoView(line.from, { y: "nearest" }));
  //   }
  //   this.view.scrollDOM.style.scrollBehavior = "smooth";
  //   this.view.dispatch({ effects });
  //   requestAnimationFrame(() => { this.view.scrollDOM.style.scrollBehavior = ""; });
  // }

  // deactivateFillInBlank() {
  //   this.view.dispatch({ effects: activateFillInBlankEffect.of(null) });
  // }

  addVersionBlock(from, to, versionBlockId, variants) {
    this.view.dispatch({ effects: addVersionBlockEffect.of({ from, to, versionBlockId, variants }) });
  }
}

// MARK: Instructor Editor
export class InstructorCodeEditor {
  constructor({
    node,
    socket,
    doc,
    startVersion,
    sessionNumber,
    versionBlocks,
    // extraExtensions = [],
  }) {
    this.docVersion = startVersion;
    this.socket = socket;
    this.sessionNumber = sessionNumber;
    this.versionBlocks = {};


    let state = EditorState.create({
      doc: Text.of(doc),
      extensions: [
        ...basicExtensions,
        keymap.of([indentWithTab]),
        EditorView.updateListener.of(
          this.broadcastInstructorChanges.bind(this)
        ),
        capLength,
        fillInBlankViewField,
        ...versionWidgetExtensions(this.createNewVersionBlock.bind(this)),
      ],
    });

    this.view = new EditorView({ state, parent: node });
    this.active = true;

    // Reconstruct any existing version blocks from the server.
    for (const block of versionBlocks) {
      const widget = new VersionBlockWidget({versionBlockId: block.id, variants: block.variants, socket: this.socket, sessionNumber: this.sessionNumber});
      this.versionBlocks[block.id] = widget;
      this.view.dispatch({
        effects: addVersionBlockEffect.of({from: block.from, to: block.to, widget}),
      });
    }
  }

  getVersionBlock(id) {
    return this.versionBlocks[id];
  }

  getDocVersion() {
    return this.docVersion;
  }

  currentCode() {
    const state = this.view.state;
    const doc = state.doc;
    const decorations = state.field(versionBlocksField);

    let result = "";
    let pos = 0;

    decorations.between(0, doc.length, (from, to, deco) => {
      result += doc.sliceString(pos, from);
      result += deco.spec.widget.getActiveVariant().editor.currentCode();
      pos = to;
    });

    result += doc.sliceString(pos, doc.length);
    return result;
  }

  endSession() {
    this.active = false;
  }

  async createNewVersionBlock({variantCode, from, to }) {
    const currentVersion = this.getDocVersion();
    try {
      // Step 1: create on the backend.
      const state = this.view.state;
      const lineFrom = state.doc.lineAt(from).from;
      const lineTo = state.doc.lineAt(Math.min(to, state.doc.length - 1)).to;
      const currentDocVersion = this.getDocVersion();
      const res = await fetch("/version-block", {
        body: JSON.stringify({ lectureId: this.sessionNumber, anchor_pos: from, docVersion: currentDocVersion, variantCode }),
        ...POST_JSON_REQUEST,
      });
      const { versionBlockId, variantId, error } = await res.json();
      if (error) { console.error("Failed to create version block:", error); return; }

      // Step 2: Create a VersionBlockWidget w/ the default variant and add it to the UI.
      const variants = [{ id: variantId, name: "v0", code: variantCode }];
      const widget = new VersionBlockWidget({versionBlockId, variants, socket: this.socket, sessionNumber: this.sessionNumber});
      this.versionBlocks[versionBlockId] = widget;
      this.view.dispatch({
        changes: { from: lineFrom, to: lineTo, insert: "" },  // should this part be earlier?
        effects: addVersionBlockEffect.of({from: lineFrom, to: lineFrom, widget}),
      });

      // Step 3: Broadcast out to the students
      this.socket.emit(SOCKET_MESSAGE_TYPE.VERSION_BLOCK_CREATED, { sessionId: this.sessionNumber, versionBlockId, from: lineFrom, to: lineFrom, variants });
    } catch (err) {
      console.error("Failed to create version block:", err);
    }
  }

  broadcastInstructorChanges(viewUpdate) {
    if (!this.active) return;

    if (viewUpdate.docChanged) {
      viewUpdate.transactions.forEach((tr) => {
        // if (!tr.annotation(Transaction.userEvent)) return;
        // let userEvent = tr.annotation(Transaction.userEvent);
        this.socket.emit(SOCKET_MESSAGE_TYPE.INSTRUCTOR_EDIT, {
          sessionId: this.sessionNumber,
          id: this.docVersion,
          changes: tr.changes.toJSON(),
          ts: Date.now(),
        });
        this.docVersion++;
      });
    }
    // If the cursor position might have changed, send out the current one.
    if (
      viewUpdate.docChanged ||
      viewUpdate.transactions.some((tr) => tr.isUserEvent("select"))
    ) {
      let { anchor, head } = viewUpdate.state.selection.main;
      this.socket.emit(SOCKET_MESSAGE_TYPE.INSTRUCTOR_CURSOR, {
        anchor,
        head,
      });
    }
  }
}

// MARK: Variant Editor
export class VariantCodeEditor {
  constructor({ node, socket, doc, sessionNumber, versionBlockId, variantId, docVersion = 0 }) {
    this.socket = socket;
    this.sessionNumber = sessionNumber;
    this.versionBlockId = versionBlockId;
    this.variantId = variantId;
    this.docVersion = docVersion;

    const state = EditorState.create({
      doc: doc ?? "",
      extensions: [
        minimalSetup,
        python(),
        indentUnit.of("    "),
        keymap.of([indentWithTab]),
        EditorView.lineWrapping,
        EditorView.updateListener.of(this.broadcastVariantChanges.bind(this)),
      ],
    });

    this.view = new EditorView({ state, parent: node });
  }

  broadcastVariantChanges(viewUpdate) {
    if (viewUpdate.docChanged) {
      viewUpdate.transactions.forEach((tr) => {
        this.socket.emit(SOCKET_MESSAGE_TYPE.VARIANT_EDIT, {
          sessionId: this.sessionNumber,
          versionBlockId: this.versionBlockId,
          variantId: this.variantId,
          id: this.docVersion,
          changes: tr.changes.toJSON(),
          ts: Date.now(),
        });
        this.docVersion++;
      });
    }

    if (viewUpdate.docChanged || viewUpdate.transactions.some((tr) => tr.isUserEvent("select"))) {
      const { anchor, head } = viewUpdate.state.selection.main;
      this.socket.emit(SOCKET_MESSAGE_TYPE.VARIANT_CURSOR, {
        versionBlockId: this.versionBlockId,
        variantId: this.variantId,
        anchor,
        head,
      });
    }
  }

  currentCode() {
    return this.view.state.doc.toString();
  }

  // destroy() {
  //   clearTimeout(this._saveTimer);
  //   this.view.destroy();
  // }
}

// MARK: Review Editor
// Note: we don't use it right now, but can show diffs if we suppliy baseDoc, I think.
export class ReviewCodeEditor {
  constructor({ node, doc, isEditable = false, showLineNumbers = false, baseDoc = null }) {
    let state = EditorState.create({
      doc: Text.of(doc),
      extensions: [
        ...reviewEditorExtensions({ isEditable, showLineNumbers }),
        ...(isEditable ? [keymap.of([indentWithTab])] : []),
        EditorView.editable.of(isEditable),
        capLength,
        ...(baseDoc !== null ? exerciseDiffGutter : []),
      ],
    });

    this.view = new EditorView({ state, parent: node });

    if (baseDoc !== null) {
      this.view.dispatch({ effects: setExerciseBaseCode.of(baseDoc.join("\n")) });
    }
  }

  scrollToLine(lineNum) {
    if (lineNum < 1 || lineNum > this.view.state.doc.lines) return;
    const line = this.view.state.doc.line(lineNum);
    this.view.dispatch({
      effects: EditorView.scrollIntoView(line.from, { y: "start", yMargin: 20 }),
    });
  }

  applyChanges(changes) {
    this.view.dispatch({ changes });
  }

  reset() {
    this.view.dispatch({
      changes: {
        from: 0,
        to: this.view.state.doc.length,
        insert: Text.empty.toString(),
      },
    });
  }

  currentCode() {
    return this.view.state.doc.toString();
  }

  replaceContents(newCode) {
    this.view.dispatch({
      changes: {
        from: 0,
        to: this.view.state.doc.length,
        insert: newCode,
      },
    });
  }
}
