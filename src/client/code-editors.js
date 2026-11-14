import { EditorView, minimalSetup } from "codemirror";
import { EditorState, Text, ChangeSet, Compartment, StateEffect } from "@codemirror/state";
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
import { addVersionBlockEffect, removeVersionBlockEffect, VersionBlockWidget, versionBlocksField, versionBlockExtensions, StudentVersionBlockWidget } from "./cm-version-widget.js";
import { versionWidgetTooltipExtensions } from "./cm-tooltip.js";
import {
  DRAFT_POLL_ID,
  addPollMarkerEffect,
  removePollMarkerEffect,
  getPollMarkerPosition,
  pollMarkerExtensions,
  setPollPanelOpen,
  clearPollPanelOpen,
  setPollHover,
  clearPollHover,
} from "./cm-poll-marker.js";
import { showPollPopoverEffect, hidePollPopoverEffect, pollPopoverExtensions } from "./cm-poll-popover.js";
import { GET_JSON_REQUEST, POST_JSON_REQUEST } from "./utils.js";
import { SOCKET_MESSAGE_TYPE } from "../shared-constants.js";
import { keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";

const FLUSH_CHANGES_FREQ = /*seconds=*/ 5 * 1000;

// Scrolls a document position into view, centered in the viewport. Dispatches twice: once
// immediately, to pull the target (possibly still off-screen, e.g. past a Version Block widget)
// into CodeMirror's rendered viewport, and once more on the next animation frame -- only by then
// has CodeMirror actually measured that content's height, so the second dispatch is what lands
// accurately. A single dispatch can under/overshoot since CodeMirror's height estimate for
// content it hasn't rendered yet is often wrong. `getFrom` is re-invoked before each dispatch so
// the target tracks a live position; no-op if it returns null.
export function scrollIntoViewAccurate(view, getFrom) {
  const from = getFrom();
  if (from == null) return;
  const scroller = view.scrollDOM;
  scroller.classList.add("cm-smooth-scroll");
  view.dispatch({ effects: EditorView.scrollIntoView(from, { y: "center" }) });
  requestAnimationFrame(() => {
    const liveFrom = getFrom();
    if (liveFrom != null) {
      view.dispatch({ effects: EditorView.scrollIntoView(liveFrom, { y: "center" }) });
    }
  });
  setTimeout(() => scroller.classList.remove("cm-smooth-scroll"), 600);
}

function scrollPollMarkerIntoView(view, id) {
  scrollIntoViewAccurate(view, () => getPollMarkerPosition(view.state, id).from);
}

// MARK: Student Editor
export class StudentCodeEditor {
  // Initialize CodeMirror and (if `socket` is given) listen for instructor updates. Pages with
  // several files pass no socket and instead route each message to the right file's editor via
  // handleSocketMessage (see workspace.js).
  constructor({node, doc, docVersion, fileId, fileName = null, socket = null, sessionId, extraExtensions = [], versionBlocks, activitiesManager = null, onOpenPollMarker, reviewMode = false, makeVersionBlockWidget = null, onAnswerEdit = null}) {
    this.docVersion = docVersion;
    this._onAnswerEdit = onAnswerEdit;
    this.fileId = fileId;
    this.fileName = fileName;
    this.sessionId = sessionId;
    this.activitiesManager = activitiesManager;
    this._reviewMode = reviewMode;
    // Overrides how addVersionBlock builds a widget -- e.g. the admin lecture-replay page uses
    // this to mount a read-only VersionBlockWidget (with every student's response as a browsable
    // pseudo-variant) instead of the default single-student StudentVersionBlockWidget. Defaults to
    // null, which preserves existing behavior everywhere else.
    this._makeVersionBlockWidget = makeVersionBlockWidget;
    let state = EditorState.create({
      doc: Text.of(doc),
      extensions: [
        ...basicExtensions,
        // ...codeSnapshotFields(onNewSnapshot),
        ...followInstructorExtensions,
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
        capLength,
        ...pollMarkerExtensions(onOpenPollMarker, (id) => this.activitiesManager?.markPollAnchorDeleted(id)),
        ...pollPopoverExtensions(),
        ...extraExtensions,
      ],
    });
    this.view = new EditorView({ state, parent: node });
    this.active = true;
    this.pendingQueue = []; // if we fall behind, buffer instructor edits.
    this.versionBlocks = [];
    versionBlocks.forEach(v => this.addVersionBlock({...v, versionBlockId: v.id}));

    // Reconstruct any existing poll markers (persisted, position already resolved server-side).
    this._managerListeners = [];
    if (activitiesManager) {
      activitiesManager.getExercises().forEach((ex) => this._maybeAddPollMarker(ex));
      const onExercise = ({ detail: { exercise } }) => this._maybeAddPollMarker(exercise);
      for (const type of ["exerciseCreated", "exerciseFinished"]) {
        activitiesManager.addEventListener(type, onExercise);
        this._managerListeners.push([type, onExercise]);
      }
    }

    this._socket = null;
    this._socketHandlers = [];
    if (socket) this.attachSocket(socket);
  }

  // Subscribes this editor directly to every instructor message it handles. Only for single-file
  // pages (e.g. the review page's no-op socket); multi-file pages route messages themselves.
  attachSocket(socket) {
    this._socket = socket;
    for (const type of StudentCodeEditor.SOCKET_MESSAGE_TYPES) {
      const handler = (msg) => this.handleSocketMessage(type, msg);
      socket.on(type, handler);
      this._socketHandlers.push([type, handler]);
    }
  }

  static SOCKET_MESSAGE_TYPES = [
    SOCKET_MESSAGE_TYPE.INSTRUCTOR_EDIT,
    SOCKET_MESSAGE_TYPE.INSTRUCTOR_CURSOR,
    SOCKET_MESSAGE_TYPE.VERSION_BLOCK_CREATED,
    SOCKET_MESSAGE_TYPE.VARIANT_ADDED,
    SOCKET_MESSAGE_TYPE.VARIANT_RENAMED,
    SOCKET_MESSAGE_TYPE.VARIANT_DELETED,
    SOCKET_MESSAGE_TYPE.VERSION_BLOCK_DELETED,
    SOCKET_MESSAGE_TYPE.VARIANT_EDIT,
    SOCKET_MESSAGE_TYPE.VARIANT_CURSOR,
  ];

  // Applies one instructor socket message. Messages carrying a fileId for another file, or naming
  // a version block this editor doesn't hold, are ignored.
  handleSocketMessage(type, msg) {
    switch (type) {
      case SOCKET_MESSAGE_TYPE.INSTRUCTOR_EDIT:
        return this.handleInstructorEdit(msg);
      case SOCKET_MESSAGE_TYPE.INSTRUCTOR_CURSOR:
        if (msg.fileId != null && msg.fileId !== this.fileId) return;
        return this.handleInstructorCursorChange(msg);
      case SOCKET_MESSAGE_TYPE.VERSION_BLOCK_CREATED: {
        const { versionBlockId, from, to, variants, fileId } = msg;
        if (fileId != null && fileId !== this.fileId) return;
        return this.addVersionBlock({ from, to, versionBlockId, variants });
      }
      case SOCKET_MESSAGE_TYPE.VARIANT_ADDED:
        return this.getVersionBlock(msg.versionBlockId)?.addVariant(msg.variant);
      case SOCKET_MESSAGE_TYPE.VARIANT_RENAMED:
        return this.getVersionBlock(msg.versionBlockId)?.renameVariant(msg.variantId, msg.name);
      case SOCKET_MESSAGE_TYPE.VARIANT_DELETED:
        return this.getVersionBlock(msg.versionBlockId)?.removeVariant(msg.variantId);
      case SOCKET_MESSAGE_TYPE.VERSION_BLOCK_DELETED:
        if (!this.getVersionBlock(msg.versionBlockId)) return;
        this.removeVersionBlock(msg.versionBlockId);
        this.activitiesManager?.markVersionBlockDeleted(msg.versionBlockId);
        return;
      // TODO: this is not right
      case SOCKET_MESSAGE_TYPE.VARIANT_EDIT:
        return this.getVersionBlock(msg.versionBlockId)?.getVariantEditor(msg.variantId)?.handleInstructorEdit({ changes: msg.changes, id: msg.id });
      case SOCKET_MESSAGE_TYPE.VARIANT_CURSOR:
        return this.getVersionBlock(msg.versionBlockId)?.getVariantEditor(msg.variantId)?.handleInstructorCursorChange({ anchor: msg.anchor, head: msg.head });
    }
  }

  // Tears the editor down for good (e.g. its file was deleted).
  destroy() {
    this.active = false;
    for (const [type, handler] of this._socketHandlers) this._socket?.off(type, handler);
    this._socketHandlers = [];
    for (const [type, handler] of this._managerListeners) this.activitiesManager?.removeEventListener(type, handler);
    this._managerListeners = [];
    for (const widget of this.versionBlocks) {
      for (const { editor } of widget.variants ?? []) editor?.view?.destroy();
    }
    this.view.destroy();
  }

  getDocVersion() {
    return this.docVersion;
  }

  addVersionBlock({from, to, versionBlockId, variants}) {
    // console.log("adding version block: ", {from, to, versionBlockId, variants});
    const widget = this._makeVersionBlockWidget
      ? this._makeVersionBlockWidget({ versionBlockId, variants, view: this.view })
      : new StudentVersionBlockWidget({versionBlockId, variants, activitiesManager: this.activitiesManager, outerView: this.view, reviewMode: this._reviewMode, onAnswerEdit: this._onAnswerEdit});
    this.versionBlocks.push(widget);
    this.view.dispatch({
      effects: addVersionBlockEffect.of({from, to, widget}),
    })
  }

  getVersionBlock(id) {
    return this.versionBlocks.find(v => v.versionBlockId === id);
  }

  _maybeAddPollMarker(ex) {
    if (ex.type !== "POLL" && ex.type !== "POLL_MCQ") return;
    if (ex.DocumentId != null && ex.DocumentId !== this.fileId) return; // anchored in another file
    if (ex.code_anchor_from == null || ex.code_anchor_to == null) return;
    if (ex.code_anchor_to <= ex.code_anchor_from) return;
    this.view.dispatch({
      effects: addPollMarkerEffect.of({
        id: ex.id,
        from: ex.code_anchor_from,
        to: ex.code_anchor_to,
        isDraft: false,
        isOpen: ex.end_ts == null,
      }),
    });
  }

  // Toggles the "lightly highlighted" state for the poll whose sidebar view is currently open.
  setPollHighlightOpen(id) {
    this.view.dispatch({
      effects: id != null ? setPollPanelOpen.of(id) : clearPollPanelOpen.of(null),
    });
  }

  // Live doc position of an already-created poll's marker, looked up by id. Returns null if the
  // poll has no marker (e.g. a poll whose anchored code was later entirely deleted).
  getPollAnchorPosition(id) {
    const { from } = getPollMarkerPosition(this.view.state, id);
    return from;
  }

  // Live [from, to) span of an already-created poll's marker, looked up by id -- used to fit the
  // active-poll popover beside the widest line of the anchored code. Returns null if the poll has
  // no marker.
  getPollAnchorRange(id) {
    const { from, to } = getPollMarkerPosition(this.view.state, id);
    return from == null ? null : { from, to };
  }

  // Scrolls a poll's anchored code into view -- used before opening the active-poll popover so
  // the code is on-screen (e.g. on page load, before the editor's viewport has ever been near
  // the anchor, or when a poll is created live while the viewer is already looking elsewhere).
  scrollToPollMarker(id) {
    scrollPollMarkerIntoView(this.view, id);
  }

  // Scrolls a version block's anchored code into view -- used when it's selected from the
  // activities sidebar, mirroring InstructorCodeEditor.scrollToVersionBlock.
  scrollToVersionBlock(versionBlockId) {
    const widget = this.getVersionBlock(versionBlockId);
    if (!widget) return;
    scrollIntoViewAccurate(this.view, () => widget.getPosition(this.view.state));
  }

  // Mounts a popover panel as a CodeMirror decoration anchored to doc position `at`, keyed by
  // `key` (replacing any existing popover under the same key). `getRange()` (optional) returns
  // the live `{from, to}` span the popover should fit itself beside, re-read on every
  // reposition. `mount(anchorEl, view)` appends the panel's DOM into `anchorEl`;
  // `unmount(anchorEl)` is called when the popover is hidden or its anchor is torn down (e.g.
  // scrolled far out of view).
  showPollPopover({ key, at, getRange, mount, unmount }) {
    this.view.dispatch({ effects: showPollPopoverEffect.of({ key, at, getRange, mount, unmount }) });
  }

  hidePollPopover(key) {
    this.view.dispatch({ effects: hidePollPopoverEffect.of({ key }) });
  }

  removeVersionBlock(versionBlockId) {
    const widget = this.getVersionBlock(versionBlockId);
    if (!widget) return;
    for (const { editor } of widget.variants) { editor?.view?.destroy(); }  // Maybe this should be somewhere else?
    this.view.dispatch({
      effects: removeVersionBlockEffect.of({ versionBlockId }),
    });
    const idx = this.versionBlocks.findIndex(v => v.versionBlockId === versionBlockId);
    if (idx >= 0) this.versionBlocks.splice(idx, 1);
  }

  handleInstructorCursorChange({ anchor, head }) {
    if (anchor > this.view.state.doc.length) return;
    if (head > this.view.state.doc.length) return;
    this.view.dispatch({
      effects: setInstructorSelection.of({ anchor, head }),
    });
  }

  async handleInstructorEdit({ changes, id, fileId }) {
    if (!this.active) return;
    if (fileId !== this.fileId) return; // an edit to a different file

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

  // Re-syncs with the server's latest copy of this file. The server doesn't serve individual past
  // changes -- instead we replace the region that differs (trimming the prefix/suffix both
  // versions share, so version-block widgets and poll markers outside it stay put), then move any
  // version blocks the server says have drifted.
  async catchUpOnChanges() {
    const res = await fetch(`/doc/${this.fileId}`, GET_JSON_REQUEST).then((r) => r.json());
    if (res.error || res.docVersion == null) {
      console.warn("Failed to catch up:", res.error);
      return;
    }
    if (res.docVersion < this.docVersion) return; // we're somehow ahead -- nothing to do

    // IMPORTANT: reset the instructor's cursor selection or else the editor gets sad.
    this.view.dispatch({
      effects: setInstructorSelection.of({ anchor: 0, head: 0 }),
    });

    const current = this.view.state.doc.toString();
    const latest = Text.of(res.doc).toString();
    if (current !== latest) {
      let start = 0;
      const maxPrefix = Math.min(current.length, latest.length);
      while (start < maxPrefix && current.charCodeAt(start) === latest.charCodeAt(start)) start++;
      let endCur = current.length;
      let endNew = latest.length;
      while (endCur > start && endNew > start && current.charCodeAt(endCur - 1) === latest.charCodeAt(endNew - 1)) {
        endCur--;
        endNew--;
      }
      this.view.dispatch({ changes: { from: start, to: endCur, insert: latest.slice(start, endNew) } });
    }
    console.log(`Caught up from version ${this.docVersion} to ${res.docVersion}`);
    this.docVersion = res.docVersion;

    // Correct any version block whose position drifted.
    for (const { id, from } of res.versionBlocks ?? []) {
      const widget = this.getVersionBlock(id);
      if (!widget) continue;
      const pos = widget.getPosition(this.view.state);
      const currentFrom = pos?.from ?? pos;
      if (currentFrom === from) continue;
      this.view.dispatch({ effects: removeVersionBlockEffect.of({ versionBlockId: id }) });
      this.view.dispatch({ effects: addVersionBlockEffect.of({ from, to: from, widget }) });
    }
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

  stopFollowing() {
    this.active = false;
  }
}

// MARK: Instructor Editor
export class InstructorCodeEditor {
  constructor({
    node,
    socket,
    doc,
    startVersion,
    persistedVersion = startVersion,
    fileId,
    sessionNumber,
    versionBlocks,
    activitiesManager,
    onCreatePollRequested,
    onOpenPollMarker,
    fileName = null,
  }) {
    this.docVersion = startVersion;
    this.fileId = fileId;
    this.fileName = fileName;
    // Every change before this version has been durably written by the server.
    this.persistedVersion = persistedVersion;
    this.socket = socket;
    this.sessionNumber = sessionNumber;
    this.activitiesManager = activitiesManager;
    this.versionBlocks = {};
    this.onCreatePollRequested = onCreatePollRequested;

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
        ...versionBlockExtensions(),
        ...versionWidgetTooltipExtensions(this.createNewVersionBlock.bind(this), this.requestCreatePoll.bind(this)),
        ...pollMarkerExtensions(onOpenPollMarker, (id) => this.activitiesManager?.markPollAnchorDeleted(id)),
        ...pollPopoverExtensions(),
      ],
    });

    this.view = new EditorView({ state, parent: node });
    this.active = true;

    this._onPersisted = ({ docId, version }) => {
      if (docId === this.fileId) this.persistedVersion = Math.max(this.persistedVersion, version);
    };
    socket.on(SOCKET_MESSAGE_TYPE.DOC_PERSISTED, this._onPersisted);

    // Reconstruct any existing version blocks from the server.
    for (const block of versionBlocks) {
      const widget = new VersionBlockWidget({
        versionBlockId: block.id,
        variants: block.variants,
        socket: this.socket,
        sessionNumber: this.sessionNumber,
        activitiesManager: this.activitiesManager,
        getInstructorCode: () => this.codeWithVariantAsPlaceholder(block.id),
        view: this.view,
        onDissolve: () => this.dissolveVersionBlock(block.id),
      });
      this.versionBlocks[block.id] = widget;
      this.view.dispatch({
        effects: addVersionBlockEffect.of({from: block.from, to: block.to, widget}),
      });
    }

    // Reconstruct any existing poll markers (persisted, position already resolved server-side).
    for (const ex of activitiesManager.getExercises()) {
      this._maybeAddPollMarker(ex);
    }
    // Refresh the marker (e.g. drop the "live" flash) once a poll is finished, whether by this
    // instructor or reflected in from another client.
    this._onExerciseFinished = ({ detail: { exercise } }) => this._maybeAddPollMarker(exercise);
    activitiesManager.addEventListener("exerciseFinished", this._onExerciseFinished);
  }

  // Tears the editor down for good (e.g. its file was deleted). Stops broadcasting first, so the
  // teardown itself never emits edits.
  destroy() {
    this.active = false;
    this.socket.off(SOCKET_MESSAGE_TYPE.DOC_PERSISTED, this._onPersisted);
    this.activitiesManager?.removeEventListener("exerciseFinished", this._onExerciseFinished);
    for (const widget of Object.values(this.versionBlocks)) widget.disposeVariantEditors();
    this.versionBlocks = {};
    this.view.destroy();
  }

  _maybeAddPollMarker(ex) {
    if (ex.type !== "POLL" && ex.type !== "POLL_MCQ") return;
    if (ex.DocumentId != null && ex.DocumentId !== this.fileId) return; // anchored in another file
    if (ex.code_anchor_from == null || ex.code_anchor_to == null) return;
    if (ex.code_anchor_to <= ex.code_anchor_from) return;
    this.view.dispatch({
      effects: addPollMarkerEffect.of({
        id: ex.id,
        from: ex.code_anchor_from,
        to: ex.code_anchor_to,
        isDraft: false,
        isOpen: ex.end_ts == null,
      }),
    });
  }

  // Snaps the selection (or, if none, the cursor's whole line) into a poll anchor, then forwards
  // to the caller-supplied handler w/ the final {from, to, code}. Silently no-ops if the range
  // overlaps an existing version block (not supported), or if there's truly nothing in the
  // document to anchor to.
  requestCreatePoll({ from, to }) {
    if (!this.active) return;
    // Trim leading/trailing whitespace so the anchor tightly bounds real code -- this keeps
    // boundary-adjacent edits from landing inside the range, and lets it fully collapse (rather
    // than leaving a whitespace-only remainder) if the code is later deleted. If the selection is
    // entirely whitespace (e.g. a blank line), skip trimming instead of collapsing to empty --
    // an all-whitespace anchor is fine.
    const doc = this.view.state.doc;
    const raw = doc.sliceString(from, to);
    const lead = raw.match(/^\s*/)[0].length;
    const trail = raw.match(/\s*$/)[0].length;
    const trimmedFrom = from + lead;
    const trimmedTo = Math.max(trimmedFrom, to - trail);
    if (trimmedFrom < trimmedTo) {
      from = trimmedFrom;
      to = trimmedTo;
    }

    // Mark decorations can't be zero-width -- widen a fully empty anchor (cursor on a blank
    // line) by a character, preferring the following line break, then the preceding one.
    if (from === to) {
      if (to < doc.length) to += 1;
      else if (from > 0) from -= 1;
      else return; // Nothing in the document at all -- nowhere to anchor.
    }

    const decorations = this.view.state.field(versionBlocksField);
    let overlapsVersionBlock = false;
    decorations.between(from, to, () => { overlapsVersionBlock = true; return false; });
    if (overlapsVersionBlock) return;

    const code = doc.sliceString(from, to);
    this.onCreatePollRequested?.({ from, to, code });
  }

  startPollDraft({ from, to }) {
    this.abandonPollDraft(); // Guard against a second right-click before the first draft resolves.
    this.view.dispatch({
      effects: addPollMarkerEffect.of({ id: DRAFT_POLL_ID, from, to, isDraft: true }),
    });
  }

  abandonPollDraft() {
    this.view.dispatch({
      effects: removePollMarkerEffect.of({ id: DRAFT_POLL_ID }),
    });
  }

  finalizePollDraft(exerciseId) {
    const { from, to } = getPollMarkerPosition(this.view.state, DRAFT_POLL_ID);
    if (from == null) return; // No draft was pending (e.g., poll created w/o a code selection).
    this.view.dispatch({ effects: removePollMarkerEffect.of({ id: DRAFT_POLL_ID }) });
    this.view.dispatch({ effects: addPollMarkerEffect.of({ id: exerciseId, from, to, isDraft: false, isOpen: true }) });
  }

  // Reads the draft's CURRENT anchor at submit time, reflecting any edits made while the
  // create panel was open.
  getPollDraftAnchor() {
    const { from, to } = getPollMarkerPosition(this.view.state, DRAFT_POLL_ID);
    if (from == null) return null;
    // `doc` (the file's text these positions refer to) is stored with the poll so its historical
    // view can be shown later without replaying any history.
    return { from, to, docVersion: this.getDocVersion(), fileId: this.fileId, doc: this.view.state.doc.toString() };
  }

  // Live doc position of an already-created poll's marker, looked up by id (so it reflects any
  // edits made since the poll was created). Returns null if the poll has no marker (e.g. a
  // poll whose anchored code was later entirely deleted).
  getPollAnchorPosition(id) {
    const { from } = getPollMarkerPosition(this.view.state, id);
    return from;
  }

  // Live [from, to) span of an already-created poll's marker, looked up by id -- used to fit the
  // active-poll popover beside the widest line of the anchored code. Returns null if the poll has
  // no marker.
  getPollAnchorRange(id) {
    const { from, to } = getPollMarkerPosition(this.view.state, id);
    return from == null ? null : { from, to };
  }

  // Scrolls a poll's anchored code into view -- used before opening the active-poll popover so
  // the code is on-screen (e.g. on page load, before the editor's viewport has ever been near
  // the anchor, or when a poll is created live while the viewer is already looking elsewhere).
  scrollToPollMarker(id) {
    scrollPollMarkerIntoView(this.view, id);
  }

  // Mounts a popover panel as a CodeMirror decoration anchored to doc position `at`, keyed by
  // `key` (replacing any existing popover under the same key). `getRange()` (optional) returns
  // the live `{from, to}` span the popover should fit itself beside, re-read on every
  // reposition. `mount(anchorEl, view)` appends the panel's DOM into `anchorEl`;
  // `unmount(anchorEl)` is called when the popover is hidden or its anchor is torn down (e.g.
  // scrolled far out of view).
  showPollPopover({ key, at, getRange, mount, unmount }) {
    this.view.dispatch({ effects: showPollPopoverEffect.of({ key, at, getRange, mount, unmount }) });
  }

  hidePollPopover(key) {
    this.view.dispatch({ effects: hidePollPopoverEffect.of({ key }) });
  }

  // Highlights the draft's code range the same way hovering its gutter "?" icon does --
  // used while the poll-create popover is open for a code-anchored draft.
  setPollDraftHighlighted(highlighted) {
    this.view.dispatch({
      effects: highlighted ? setPollHover.of(DRAFT_POLL_ID) : clearPollHover.of(null),
    });
  }

  // Toggles the "lightly highlighted" state for the poll whose sidebar view is currently open.
  setPollHighlightOpen(id) {
    this.view.dispatch({
      effects: id != null ? setPollPanelOpen.of(id) : clearPollPanelOpen.of(null),
    });
  }

  getVersionBlock(id) {
    return this.versionBlocks[id];
  }

  // Scrolls a version block's anchored code into view -- used when it's selected from the
  // activities sidebar, mirroring scrollToPollMarker for polls.
  scrollToVersionBlock(versionBlockId) {
    const widget = this.versionBlocks[versionBlockId];
    if (!widget) return;
    scrollIntoViewAccurate(this.view, () => widget.getPosition(this.view.state).from);
  }

  getDocVersion() {
    return this.docVersion;
  }

  async dissolveVersionBlock(versionBlockId) {
    if (!this.active) return;
    const widget = this.versionBlocks[versionBlockId];
    // Snapshot the file + the widget's position BEFORE anything changes, for the historical view.
    const before = {
      doc: this.view.state.doc.toString(),
      pos: widget?.getPosition(this.view.state)?.from ?? null,
      docVersion: this.getDocVersion(),
    };
    const finishedExerciseId = await this._destroyVersionBlockBackend(versionBlockId, before);
    this.activitiesManager?.markVersionBlockDeleted(versionBlockId);
    if (finishedExerciseId != null) {
      this.activitiesManager?.markExerciseFinishedSilently(finishedExerciseId);
    }

    delete this.versionBlocks[versionBlockId];

    let {from, to} = widget.getPosition(this.view.state);
    if (from == null) {
      console.log("Version block deleted, but not present in editor:", widget);
      return;
    }
    const code = widget?.getActiveVariant()?.editor?.currentCode() ?? "";

    // Need to do this in two separate transactions, for some reason!
    this.view.dispatch({
      effects: removeVersionBlockEffect.of({ versionBlockId }),
    });
    this.view.dispatch({
      changes: { from, to, insert: code },
    });
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

  getSelectedCode() {
    const state = this.view.state;
    const doc = state.doc;
    let { from, to } = state.selection.main;
    if (from === to) return "";

    // Select the whole lines
    from = doc.lineAt(from).from;
    to = doc.lineAt(to).from == to ? to - 1 : doc.lineAt(to).to;

    const decorations = state.field(versionBlocksField);
    let result = "";
    let pos = from;

    decorations.between(from, to, (dFrom, dTo, deco) => {
      result += doc.sliceString(pos, Math.max(pos, dFrom));
      result += deco.spec.widget.getActiveVariant().editor.currentCode();
      pos = dTo;
    });

    result += doc.sliceString(pos, to);
    return result;
  }

  codeWithVariantAsPlaceholder(targetVersionBlockId) {
    const state = this.view.state;
    const doc = state.doc;
    const decorations = state.field(versionBlocksField);

    let result = "";
    let pos = 0;

    decorations.between(0, doc.length, (from, to, deco) => {
      result += doc.sliceString(pos, from);
      result += deco.spec.widget.versionBlockId === targetVersionBlockId
        ? "{{ANSWER}}"
        : deco.spec.widget.getActiveVariant().editor.currentCode();
      pos = to;
    });

    result += doc.sliceString(pos, doc.length);
    return result;
  }

  endSession() {
    this.active = false;
    this.view.dispatch({
      effects: StateEffect.appendConfig.of([EditorView.editable.of(false), EditorState.readOnly.of(true)]),
    });
    for (const widget of Object.values(this.versionBlocks)) {
      widget.lock();
    }
  }

  async createNewVersionBlock({ variantCode, from, to, autoStartExercise = false }) {
    if (!this.active) return;
    // Step 0: Make sure we're not creating nested version blocks!
    const decorations = this.view.state.field(versionBlocksField);
    let containsExistingBlock = false;
    decorations.between(from, to, () => { containsExistingBlock = true; return false; });
    if (containsExistingBlock) {
      console.warn("Cannot create version block: selection contains an existing version block.");
      window.alert("Cannot create a nested version block!");
      return;
    }

    const currentVersion = this.getDocVersion();
    try {
      // Step 1: create on the backend.
      const state = this.view.state;
      const lineFrom = state.doc.lineAt(from).from;
      const lineTo = state.doc.lineAt(Math.min(to, state.doc.length - 1)).to;
      const currentDocVersion = this.getDocVersion();
      const res = await fetch("/version-block", {
        body: JSON.stringify({ lectureId: this.sessionNumber, fileId: this.fileId, anchor_pos: from, docVersion: currentDocVersion, variantCode }),
        ...POST_JSON_REQUEST,
      });
      const { versionBlockId, variantId, error } = await res.json();
      if (error) { console.error("Failed to create version block:", error); return; }

      // Step 2: Create a VersionBlockWidget w/ the default variant and add it to the UI.
      const variants = [{ id: variantId, name: "v0", code: variantCode, docVersion: 1 }];
      const widget = new VersionBlockWidget({
          versionBlockId,
          variants,
          socket: this.socket,
          sessionNumber: this.sessionNumber,
          activitiesManager: this.activitiesManager,
          getInstructorCode: () => this.codeWithVariantAsPlaceholder(versionBlockId),
          view: this.view,
          onDissolve: () => this.dissolveVersionBlock(versionBlockId),
        });
      this.versionBlocks[versionBlockId] = widget;
      const isAtDocEnd = lineTo >= state.doc.length;
      this.view.dispatch({
        changes: { from: lineFrom, to: lineTo, insert: isAtDocEnd ? "\n" : "" },
        effects: addVersionBlockEffect.of({from: lineFrom, to: lineFrom, widget}),
      });

      // Step 3: Broadcast out to the students
      this.socket.emit(SOCKET_MESSAGE_TYPE.VERSION_BLOCK_CREATED, { sessionId: this.sessionNumber, fileId: this.fileId, versionBlockId, from: lineFrom, to: lineFrom, variants });

      if (autoStartExercise) widget._askStudents();
    } catch (err) {
      console.error("Failed to create version block:", err);
    }
  }

  // `before`: {doc, pos, docVersion} -- the file as it looked right before dissolving.
  async _destroyVersionBlockBackend(versionBlockId, before) {
    let finishedExerciseId = null;
    try {
      const res = await fetch(`/version-block/${versionBlockId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(before ?? {}),
      });
      const { ok, error, finishedExerciseId: id } = await res.json();
      if (!ok || error) { console.error("Failed to dissolve version block:", error); return null; }
      finishedExerciseId = id ?? null;
    } catch (err) {
      console.error("Failed to dissolve version block:", err); return null;
    }

    this.socket.emit(SOCKET_MESSAGE_TYPE.VERSION_BLOCK_DELETED, {
      sessionId: this.sessionNumber,
      versionBlockId,
    });
    return finishedExerciseId;
  }


  broadcastInstructorChanges(viewUpdate) {
    if (!this.active) return;

    if (viewUpdate.docChanged) {
      viewUpdate.transactions.forEach((tr) => {
        // if (!tr.annotation(Transaction.userEvent)) return;
        // let userEvent = tr.annotation(Transaction.userEvent);
        this.socket.emit(SOCKET_MESSAGE_TYPE.INSTRUCTOR_EDIT, {
          sessionId: this.sessionNumber,
          fileId: this.fileId,
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
        sessionId: this.sessionNumber,
        fileId: this.fileId,
        anchor,
        head,
      });
    }

    if (viewUpdate.focusChanged && !viewUpdate.view.hasFocus) {
      this.socket.emit(SOCKET_MESSAGE_TYPE.INSTRUCTOR_CURSOR, {
        sessionId: this.sessionNumber,
        fileId: this.fileId,
        anchor: -1,
        head: -1,
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
    // Every change before this version has been durably written by the server.
    this.persistedVersion = docVersion;
    this._onPersisted = ({ variantId: persistedVariantId, version }) => {
      if (persistedVariantId === this.variantId) this.persistedVersion = Math.max(this.persistedVersion, version);
    };
    socket.on(SOCKET_MESSAGE_TYPE.DOC_PERSISTED, this._onPersisted);

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
    this.active = true;
  }

  lock() {
    this.active = false;
    this.view.dispatch({
      effects: StateEffect.appendConfig.of([EditorView.editable.of(false), EditorState.readOnly.of(true)]),
    });
  }

  broadcastVariantChanges(viewUpdate) {
    if (!this.active) return;

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
        sessionId: this.sessionNumber,
        versionBlockId: this.versionBlockId,
        variantId: this.variantId,
        anchor,
        head,
      });
    }

    if (viewUpdate.focusChanged && !viewUpdate.view.hasFocus) {
      this.socket.emit(SOCKET_MESSAGE_TYPE.VARIANT_CURSOR, {
        sessionId: this.sessionNumber,
        versionBlockId: this.versionBlockId,
        variantId: this.variantId,
        anchor: -1,
        head: -1,
      });
    }
  }

  currentCode() {
    return this.view.state.doc.toString();
  }

  destroy() {
    clearTimeout(this._saveTimer);
    this.socket.off(SOCKET_MESSAGE_TYPE.DOC_PERSISTED, this._onPersisted);
    this.view.destroy();
  }
}


// MARK: Variant Following Editor
export class VariantCodeFollowingEditor {
  constructor({ node, doc, variantId, docVersion = 0 }) {
    this.variantId = variantId;
    this.docVersion = docVersion;

    const state = EditorState.create({
      doc: doc ?? "",
      extensions: [
        minimalSetup,
        python(),
        indentUnit.of("    "),
        keymap.of([indentWithTab]),
        ...followInstructorExtensions,
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
        EditorView.lineWrapping,
      ],
    });

    this.view = new EditorView({ state, parent: node });
  }

  currentCode() {
    return this.view?.state?.doc?.toString();
  }

  handleInstructorEdit({changes, id}) {
    if (id !== this.docVersion) {
      alert("Error: out of sync. Please reload the page");
    }
    // console.log("Normal dispatch for change: ", id);
    // We're good now!
    changes = ChangeSet.fromJSON(changes);
    this.docVersion++;
    this.view.dispatch({ changes });
  }

  handleInstructorCursorChange({anchor, head}) {
    if (anchor > this.view.state.doc.length) return;
    if (head > this.view.state.doc.length) return;
    this.view.dispatch({ effects: setInstructorSelection.of({ anchor, head }) });
  }
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
        EditorState.readOnly.of(!isEditable),
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
