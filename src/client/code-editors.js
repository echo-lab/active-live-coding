import { EditorView } from "codemirror";
import { EditorState, Text, ChangeSet, Compartment } from "@codemirror/state";
import {
  basicExtensions,
  capLength,
  codeSnapshotFields,
  followInstructorExtensions,
  setInstructorSelection,
} from "./cm-extensions.js";
import { exerciseDiffGutter, setExerciseBaseCode, reviewEditorExtensions } from "./cm-diff-extensions.js";
import { activateFillInBlankEffect, fillInBlankViewField } from "./cm-fill-in-the-blank.js";
import { GET_JSON_REQUEST, POST_JSON_REQUEST } from "./utils.js";
import { SOCKET_MESSAGE_TYPE } from "../shared-constants.js";
import { keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";

const FLUSH_CHANGES_FREQ = /*seconds=*/ 5 * 1000;

/*
Flushed data in format: 
{
  sessionNumber: 1,
  email: "test@test.com",
  changes: [{
    changesetJSON: ChangeSet().toJSON(),
    changeNumber: docVersion,
    ts: Date.now(),
  }, ... ]

Note: if onNewSnapshot is not null, will set up extensions for code snapshots.
*/
// A student code editor whose state is periodically saved to the server.
// MARK: Typing Along Editor
export class StudentCodeEditor {
  constructor({
    node,
    doc,
    docVersion,
    sessionNumber,
    fileName = "",
    email,
    flushUrl,
    onNewSnapshot = null,
  }) {
    this.email = email;
    this.docVersion = docVersion;
    this.sessionActive = true;
    this.queuedChanges = [];
    this.sessionNumber = sessionNumber;
    this.flushUrl = flushUrl;
    this.fileName = fileName;
    this.mostRecentSync = Date.now();

    let snapshotExtensions = onNewSnapshot
      ? codeSnapshotFields(onNewSnapshot)
      : [];

    let state = EditorState.create({
      doc: Text.of(doc),
      extensions: [
        ...basicExtensions,
        ...exerciseDiffGutter,
        EditorView.updateListener.of(this.onCodeUpdate.bind(this)),
        keymap.of([indentWithTab]),
        snapshotExtensions,
        capLength,
      ],
    });

    this.view = new EditorView({ state, parent: node });

    this.flushChangesLoop = setInterval(
      this.flushChanges.bind(this),
      FLUSH_CHANGES_FREQ
    );
  }

  getDocVersion() {
    return this.docVersion;
  }

  currentCode() {
    return this.view.state.doc.toString();
  }

  setBaseCode(code) {
    this.view.dispatch({ effects: setExerciseBaseCode.of(code) });
  }

  onCodeUpdate(viewUpdate) {
    if (!this.sessionActive) return;
    if (!viewUpdate.docChanged) return;
    if (!this.flushUrl) return;
    viewUpdate.transactions.forEach((tr) => {
      this.queuedChanges.push({
        changesetJSON: tr.changes.toJSON(),
        changeNumber: this.docVersion,
        ts: Date.now(),
        fileName: this.fileName,
      });
      this.docVersion++;
    });
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

  endSession() {
    this.sessionActive = false;
    clearInterval(this.flushChangesLoop);
    this.flushChanges();
  }

  async flushChanges() {
    if (this.queuedChanges.length === 0) {
      this.mostRecentSync = Date.now();
      return;
    }

    // Okay, we have changes to flush!
    let payload = {
      sessionNumber: this.sessionNumber,
      changes: this.queuedChanges,
      email: this.email,
    };
    let lo = this.queuedChanges.at(0).changeNumber;
    let hi = this.queuedChanges.at(-1).changeNumber;

    const response = await fetch(this.flushUrl, {
      body: JSON.stringify(payload),
      ...POST_JSON_REQUEST,
    });
    let res = await response.json();
    if (res.error) {
      console.warn("Failed to flush changes: ", res.error);
      if (
        Date.now() > this.mostRecentSync + 30 * 1000 &&
        !this.alreadyAlerted
      ) {
        this.alreadyAlerted = true;
        alert(
          "Warning: code changes not syncing with the server. \n" +
            "You may want to consider copying your code and refreshing the page."
        );
      }
      return;
    }
    // Now we know server is synced up to change X so we can delete earlier things...
    let serverDocVersion = res.committedVersion;
    console.log(`Flushed changes: (${lo}, ${hi})`);

    this.queuedChanges = this.queuedChanges.filter(
      (ch) => ch.changeNumber >= serverDocVersion
    );
    this.mostRecentSync = Date.now();
  }
}

/*
This editor just syncs w/ the instructors, including the selection and cursor.
Tries to catch up if it falls behind for whatever reason.
Doesn't log any activity -- only reads from the server.
*/
// MARK: Follow Instructor (w/ exercises)
export class CodeFollowingEditor {
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

  activateFillInBlank(exercise, currentAnswer, onSubmit, onRun) {
    this.view.dispatch({ effects: activateFillInBlankEffect.of({ exercise, showButtons: true, currentAnswer, onSubmit, onRun }) });
  }

  deactivateFillInBlank() {
    this.view.dispatch({ effects: activateFillInBlankEffect.of(null) });
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
    fileName = "instructor.py",
    extraExtensions = [],
  }) {
    this.docVersion = startVersion;
    this.socket = socket;
    this.sessionNumber = sessionNumber;
    this.fileName = fileName;
    this.editableCompartment = new Compartment();

    let state = EditorState.create({
      doc: Text.of(doc),
      extensions: [
        ...basicExtensions,
        keymap.of([indentWithTab]),
        EditorView.updateListener.of(
          this.broadcastInstructorChanges.bind(this)
        ),
        capLength,
        this.editableCompartment.of([]),
        fillInBlankViewField,
        ...extraExtensions,
      ],
    });

    this.view = new EditorView({ state, parent: node });
    this.active = true;
  }

  getDocVersion() {
    return this.docVersion;
  }

  currentCode() {
    return this.view.state.doc.toString();
  }

  endSession() {
    this.active = false;
  }

  activateFillInBlank(exercise) {
    this.view.dispatch({
      effects: [
        this.editableCompartment.reconfigure(EditorView.editable.of(false)),
        activateFillInBlankEffect.of({ exercise, showButtons: false }),
      ],
    });
  }

  deactivateFillInBlank() {
    this.view.dispatch({
      effects: [
        this.editableCompartment.reconfigure([]),
        activateFillInBlankEffect.of(null),
      ],
    });
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

// MARK: Review Editor
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
