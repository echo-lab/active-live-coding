import { InstructorCodeEditor, StudentCodeEditor } from "./code-editors.js";
import { versionBlocksField } from "./cm-version-widget.js";
import { FileTabBar } from "./file-tabs.js";
import { FileTreeView } from "./file-tree.js";
import { INSTRUCTOR_AWARENESS, getFollowOffscreenMode, setFollowOffscreenMode } from "./instructor-awareness-config.js";
import { instructorAwareness, instructorActivityEffect, refreshAwarenessEffect } from "./cm-instructor-awareness.js";
import { recordEvent } from "./shared-interactions.js";
import { EVENT_TYPES, SOCKET_MESSAGE_TYPE, getMainFile, pathBasename, pathDirname } from "../shared-constants.js";

// MARK: Workspace
// Controller for a lecture's files on one page: owns the file model (LectureFileSystem), the file
// tree, the tab bar, and one code editor per file (each in its own container, only the active one
// shown). Everything else on the page talks to "the editor" through this -- e.g. activeEditor, or
// editorForExercise(ex) for whichever file an exercise lives in.
//
// Events:
//   "viewchange"   {detail: {openIds, activeId, source}} -- tabs opened/closed/switched. `source` is
//                  "user" (tree/tab click), "exercise" (revealing an exercise's file), or "program".
//   "activechange" {detail: {editor}} -- the active editor changed (incl. to null: no tab open).
export class Workspace extends EventTarget {
  constructor({ fs, containersHostEl, tabsEl, treePanelEl, editableTree = false, sessionNumber, activitiesManager, versionBlocks = [] }) {
    super();
    this.fs = fs;
    this.host = containersHostEl;
    this.sessionNumber = sessionNumber;
    this.activitiesManager = activitiesManager;
    this.editors = new Map(); // fileId -> editor
    this.containers = new Map(); // fileId -> container element
    this.openIds = [];
    this.activeId = null;
    // Version blocks from the join payload, consumed when each file's editor is built.
    this._initialBlocks = versionBlocks;

    this.emptyEl = document.createElement("div");
    this.emptyEl.className = "workspace-empty";
    this.emptyEl.textContent = "No file open. Pick one from the file list.";
    this.host.append(this.emptyEl);

    this.tabs = new FileTabBar({
      containerEl: tabsEl,
      getLabel: (id) => this._tabLabel(id),
      onActivate: (id) => this.openFile(id, { source: "user" }),
      onClose: (id) => this.closeTab(id, { source: "user" }),
    });

    this.tree = new FileTreeView({
      panelEl: treePanelEl,
      fs,
      editable: editableTree,
      onOpenFile: (id) => this.openFile(id, { source: "user" }),
      ...this._treeCallbacks(),
    });

    fs.addEventListener("changed", ({ detail: { kind, ids } }) => this._onFilesChanged(kind, ids));

    // What the Run button runs: the active file as __main__, with every file available to import.
    const workspace = this;
    this.runTarget = {
      currentCode: () => workspace.activeEditor?.currentCode() ?? null,
      get fileName() {
        return workspace.activeEditor?.fileName ?? null;
      },
      // [{path, content}] for every file. currentCode() resolves version blocks to the code shown
      // (the instructor's selected variant, or the student's own answer).
      getProjectFiles: () =>
        workspace.fs.allFiles().map((f) => ({ path: f.name, content: workspace.editorFor(f.id)?.currentCode() ?? (f.doc ?? []).join("\n") })),
    };
  }

  // Builds every file's editor, then opens `view` ({openFileIds, activeFileId}) if it's usable,
  // else just the main file. Separate from the constructor so subclasses finish setting up first.
  _start(view) {
    for (const file of this.fs.allFiles()) this.getOrCreateEditor(file.id);
    this._setView(this._usableView(view), { source: "program" });
    this._bindActivitiesManager(this.activitiesManager);
  }

  // `view` ({openFileIds, activeFileId}) as a tab state, or just the main file if none of its
  // files exist.
  _usableView(view) {
    if (view && view.openFileIds?.some((id) => this.fs.getFile(id))) {
      return { openIds: view.openFileIds, activeId: view.activeFileId };
    }
    const main = getMainFile(this.fs.allFiles());
    return { openIds: main ? [main.id] : [], activeId: main?.id ?? null };
  }

  // Throws away every editor and rebuilds from a complete snapshot ({files, versionBlocks}) -- the
  // admin replay does this on every scrub. Opens `view` if given, else keeps whichever open tabs
  // still exist (falling back to the main file).
  load({ files, versionBlocks = [], activitiesManager = this.activitiesManager, view = null }) {
    for (const id of [...this.editors.keys()]) this._destroyEditor(id);
    this.activitiesManager = activitiesManager;
    this._initialBlocks = versionBlocks;
    this.fs.replaceAll(files);
    for (const file of this.fs.allFiles()) this.getOrCreateEditor(file.id);

    const kept = { openFileIds: this.openIds, activeFileId: this.activeId };
    // Every editor is new, even where the tab ids are the same -- reset so _setView re-renders
    // and announces the new active editor.
    this.openIds = [];
    this.activeId = null;
    this._setView(this._usableView(view ?? kept), { source: "program" });
    this._bindActivitiesManager(activitiesManager);
  }

  // Overridden by subclasses that let the user edit the tree.
  _treeCallbacks() {
    return {};
  }

  // MARK: Editors

  // Subclasses build the right kind of editor for `file` inside `node`.
  _createEditor(/* file, node, versionBlocks */) {
    throw new Error("not implemented");
  }

  // The single place editors get built. Today every file's editor is built up front; this is the
  // seam for building (and loading) them lazily on first open instead.
  getOrCreateEditor(fileId) {
    if (this.editors.has(fileId)) return this.editors.get(fileId);
    const file = this.fs.getFile(fileId);
    if (!file) return null;
    const node = document.createElement("div");
    node.className = "code-container file-editor";
    node.hidden = true;
    this.host.append(node);
    const blocks = this._initialBlocks.filter((b) => b.fileId === fileId);
    const editor = this._createEditor(file, node, blocks);
    this.containers.set(fileId, node);
    this.editors.set(fileId, editor);
    return editor;
  }

  editorFor(fileId) {
    return this.editors.get(fileId) ?? null;
  }

  get activeEditor() {
    return this.activeId != null ? this.editorFor(this.activeId) : null;
  }

  allEditors() {
    return [...this.editors.values()];
  }

  // The editor holding the given (live) version block, if any.
  editorForVersionBlock(versionBlockId) {
    return this.allEditors().find((e) => e.getVersionBlock(versionBlockId)) ?? null;
  }

  // MARK: Tabs

  _tabLabel(id) {
    const file = this.fs.getFile(id);
    if (!file) return { label: "?", title: "" };
    const base = pathBasename(file.name);
    const dir = pathDirname(file.name);
    const clash = this.openIds.some((other) => other !== id && pathBasename(this.fs.getFile(other)?.name ?? "") === base);
    return { label: clash && dir ? `${base} — ${dir}` : base, title: file.name };
  }

  // Opens `fileId` in a tab (or switches to its existing tab).
  openFile(fileId, { source = "program" } = {}) {
    if (!this.fs.getFile(fileId)) return;
    const openIds = this.openIds.includes(fileId) ? this.openIds : [...this.openIds, fileId];
    this._setView({ openIds, activeId: fileId }, { source });
  }

  closeTab(fileId, { source = "program" } = {}) {
    const index = this.openIds.indexOf(fileId);
    if (index < 0) return;
    const openIds = this.openIds.filter((id) => id !== fileId);
    let activeId = this.activeId;
    if (activeId === fileId) activeId = openIds[Math.min(index, openIds.length - 1)] ?? null;
    this._setView({ openIds, activeId }, { source });
  }

  // Applies a whole tab state at once, dropping ids that aren't (or are no longer) files.
  _setView({ openIds, activeId }, { source = "program" } = {}) {
    openIds = [...new Set(openIds)].filter((id) => this.fs.getFile(id));
    if (!openIds.includes(activeId)) activeId = openIds[0] ?? null;
    const sameTabs = openIds.length === this.openIds.length && openIds.every((id, i) => id === this.openIds[i]);
    const prevActive = this.activeId;
    if (sameTabs && activeId === prevActive) return;

    this.openIds = openIds;
    this.activeId = activeId;
    this._render();
    this.dispatchEvent(new CustomEvent("viewchange", { detail: { openIds, activeId, source } }));
    if (activeId !== prevActive) {
      this.dispatchEvent(new CustomEvent("activechange", { detail: { editor: this.activeEditor } }));
    }
  }

  _render() {
    this.tabs.setState({ openIds: this.openIds, activeId: this.activeId });
    for (const [id, node] of this.containers) {
      const show = id === this.activeId;
      if (node.hidden === !show) continue;
      node.hidden = !show;
      // CodeMirror can't measure while hidden -- remeasure now that it's visible.
      if (show) this.editors.get(id)?.view?.requestMeasure();
    }
    this.emptyEl.hidden = this.activeId != null;
    this.tree.setActiveFile(this.activeId);
  }

  // MARK: File model changes

  _onFilesChanged(kind, ids) {
    if (kind === "created") {
      for (const id of ids) this.getOrCreateEditor(id);
    } else if (kind === "renamed") {
      for (const id of ids) {
        const editor = this.editorFor(id);
        if (editor) editor.fileName = this.fs.getFile(id)?.name ?? editor.fileName;
      }
      this.tabs.refreshLabels();
    } else if (kind === "deleted") {
      for (const id of ids) this._destroyEditor(id);
      this._setView({ openIds: this.openIds, activeId: this.activeId }, { source: "program" });
    }
    this._updateExerciseMarkers();
  }

  _destroyEditor(fileId) {
    this.editors.get(fileId)?.destroy();
    this.containers.get(fileId)?.remove();
    this.editors.delete(fileId);
    this.containers.delete(fileId);
  }

  // Applies a deletion ({fileIds, versionBlockIds, finishedExerciseIds}) -- from our own request or
  // a socket broadcast. Idempotent: a deletion whose files are already gone is ignored.
  applyFilesDeleted({ fileIds = [], versionBlockIds = [], finishedExerciseIds = [] }) {
    const present = fileIds.filter((id) => this.fs.getFile(id));
    if (present.length === 0) return;
    const deleted = new Set(present);
    // Any exercise anchored in those files loses its anchor; the historical view takes over.
    for (const id of versionBlockIds) this.activitiesManager?.markVersionBlockDeleted(id);
    for (const ex of this.activitiesManager?.getExercises() ?? []) {
      if ((ex.type === "POLL" || ex.type === "POLL_MCQ") && deleted.has(ex.DocumentId)) {
        this.activitiesManager.markPollAnchorDeleted(ex.id);
      }
    }
    for (const id of finishedExerciseIds) this.activitiesManager?.markExerciseFinishedSilently?.(id);
    this.fs.removeFiles(present);
    this.dispatchEvent(new CustomEvent("filesdeleted", { detail: { fileIds: present } }));
  }

  // MARK: Exercises

  // Listens to `manager` (dropping the previous one's listener -- load() can swap managers) so the
  // active-exercise badges in the tree and tabs stay current.
  _bindActivitiesManager(manager) {
    if (this._boundManager !== manager) {
      this._onExercisesChanged ??= () => this._updateExerciseMarkers();
      for (const type of ["exerciseCreated", "exerciseFinished", "exerciseUpdated"]) {
        this._boundManager?.removeEventListener(type, this._onExercisesChanged);
        manager?.addEventListener(type, this._onExercisesChanged);
      }
      this._boundManager = manager;
    }
    this._updateExerciseMarkers();
  }

  // Badges every file holding an active exercise (whose code is still somewhere in a file).
  _updateExerciseMarkers() {
    const ids = new Set();
    for (const ex of this.activitiesManager?.getActiveExercises() ?? []) {
      if (ex.VersionBlock?.deleted) continue;
      const fileId = this.fileIdForExercise(ex);
      if (fileId != null) ids.add(fileId);
    }
    this.tree.setExerciseFiles(ids);
    this.tabs.setExerciseFiles(ids);
  }

  // The file an exercise's code lives in: a code exercise's version block's file, or a poll's
  // anchor file. Null if unknown (e.g. a standalone poll, or its version block was dissolved).
  fileIdForExercise(ex) {
    if (ex.type === "CODE_VARIANT") return this.editorForVersionBlock(ex.VersionBlockId)?.fileId ?? null;
    if (ex.DocumentId != null) return this.fs.getFile(ex.DocumentId) ? ex.DocumentId : null;
    return null;
  }

  editorForExercise(ex) {
    const fileId = this.fileIdForExercise(ex);
    return fileId != null ? this.editorFor(fileId) : null;
  }

  // Switches to the exercise's file (if it has one) and scrolls its code into view.
  scrollToExercise(ex) {
    const fileId = this.fileIdForExercise(ex);
    if (fileId == null) return;
    this.openFile(fileId, { source: "exercise" });
    const editor = this.editorFor(fileId);
    if (ex.type === "CODE_VARIANT") editor.scrollToVersionBlock(ex.VersionBlockId);
    else editor.scrollToPollMarker(ex.id);
  }

  // Switches to a code exercise's file and scrolls its version block into view only if it isn't
  // already visible -- for actions that change the block from elsewhere (e.g. adding a variant
  // from the sidebar), so the instructor sees the effect without an unnecessary jump.
  revealExercise(ex) {
    const fileId = this.fileIdForExercise(ex);
    if (fileId == null) return;
    this.openFile(fileId, { source: "exercise" });
    if (ex.type === "CODE_VARIANT") this.editorFor(fileId).revealVersionBlock(ex.VersionBlockId);
    else this.editorFor(fileId).scrollToPollMarker(ex.id);
  }

  // Where to anchor an exercise's popover: on its code if that's in the visible file, else a fixed
  // point near the top-right of the code pane.
  anchorForExercise(ex) {
    const editor = this.editorForExercise(ex);
    if (editor && editor === this.activeEditor && ex.code_anchor_from != null && ex.code_anchor_to != null) {
      const at = editor.getPollAnchorPosition(ex.id);
      if (at != null) return { kind: "code", at, getRange: () => editor.getPollAnchorRange(ex.id) };
    }
    const paneRect = this.host.getBoundingClientRect();
    return {
      kind: "standalone",
      rect: { top: paneRect.top + 8, bottom: paneRect.top + 8, left: paneRect.right - 8, right: paneRect.right - 8, width: 0, height: 0 },
    };
  }

  // Popovers are mounted in the visible editor (callers reveal the right file first); hiding is
  // idempotent, so it's sent to every editor.
  showPollPopover(args) {
    this.activeEditor?.showPollPopover(args);
  }

  hidePollPopover(key) {
    for (const editor of this.editors.values()) editor.hidePollPopover(key);
  }

  setPollHighlightOpen(id) {
    for (const editor of this.editors.values()) editor.setPollHighlightOpen(id);
  }
}

// MARK: InstructorWorkspace
export class InstructorWorkspace extends Workspace {
  static FOREIGN_MUTATION_TYPES = [
    SOCKET_MESSAGE_TYPE.INSTRUCTOR_EDIT,
    SOCKET_MESSAGE_TYPE.VARIANT_EDIT,
    SOCKET_MESSAGE_TYPE.VERSION_BLOCK_CREATED,
    SOCKET_MESSAGE_TYPE.VERSION_BLOCK_DELETED,
    SOCKET_MESSAGE_TYPE.VARIANT_ADDED,
    SOCKET_MESSAGE_TYPE.VARIANT_RENAMED,
    SOCKET_MESSAGE_TYPE.VARIANT_DELETED,
    SOCKET_MESSAGE_TYPE.EXERCISE_CREATED,
    SOCKET_MESSAGE_TYPE.EXERCISE_FINISHED,
  ];

  constructor({ socket, instructorView = null, onCreatePollRequested, onOpenPollMarker, ...rest }) {
    super({ ...rest, editableTree: true });
    this.socket = socket;
    this.onCreatePollRequested = onCreatePollRequested;
    this.onOpenPollMarker = onOpenPollMarker;
    this.ended = false;

    // Tell students (and the server, for late joiners) which tabs are open, and log it for replay.
    this.addEventListener("viewchange", () => this._broadcastView());

    socket.on(SOCKET_MESSAGE_TYPE.FILE_CREATED, ({ file }) => this.fs.upsertFile(file));
    socket.on(SOCKET_MESSAGE_TYPE.FILES_RENAMED, ({ renames }) => this.fs.applyRenames(renames));
    socket.on(SOCKET_MESSAGE_TYPE.FILES_DELETED, (msg) => this.applyFilesDeleted(msg));
    // After a reconnect, re-announce our tabs (the server's copy may be stale).
    socket.on("connect", () => this._broadcastView());

    // The server relays instructor mutations to everyone EXCEPT their sender, and only relays edits
    // it accepted. So if we receive one, another tab/window is editing this lecture and our copy is
    // now stale -- fire "stale" so the page can lock itself (instructor.js). Cursors and view state
    // are deliberately excluded: a freshly opened tab announces its view on load, and that alone
    // shouldn't lock the older tab before anyone actually edits.
    for (const type of InstructorWorkspace.FOREIGN_MUTATION_TYPES) {
      socket.on(type, (msg) => {
        if (Number(msg?.sessionId ?? msg?.sessionNumber) !== Number(this.sessionNumber)) return;
        this.dispatchEvent(new CustomEvent("stale", { detail: { type } }));
      });
    }

    this._start(instructorView);
    this._broadcastView();
  }

  _broadcastView() {
    if (this.ended) return;
    const view = { openFileIds: this.openIds, activeFileId: this.activeId };
    this.socket.emit(SOCKET_MESSAGE_TYPE.INSTRUCTOR_VIEW_STATE, { sessionId: this.sessionNumber, ...view });
    recordEvent(EVENT_TYPES.INSTRUCTOR_VIEW_FILES, view);
  }

  _createEditor(file, node, versionBlocks) {
    return new InstructorCodeEditor({
      node,
      socket: this.socket,
      doc: file.doc,
      startVersion: file.docVersion,
      persistedVersion: file.persistedVersion,
      fileId: file.id,
      fileName: file.name,
      sessionNumber: this.sessionNumber,
      versionBlocks,
      activitiesManager: this.activitiesManager,
      onCreatePollRequested: this.onCreatePollRequested,
      onOpenPollMarker: this.onOpenPollMarker,
    });
  }

  _treeCallbacks() {
    return {
      onCreateFile: async (path) => {
        const error = await this.fs.createFile(path);
        if (!error) this.openFile(this.fs.getFileByName(path).id, { source: "user" });
        return error;
      },
      onCreateDir: (path) => this.fs.createDir(path),
      onRename: (from, to, isDirectory) => this.fs.rename(from, to, { isDirectory }),
      onDelete: async (path, isDirectory) => {
        const what = isDirectory ? `the folder "${path}" and every file in it` : `"${path}"`;
        const ok = confirm(`Delete ${what}? Students will no longer see it, and any exercise in it will end.`);
        if (!ok) return;
        const result = await this.fs.delete(path, { isDirectory });
        if (result.error) {
          alert(`Couldn't delete ${path}: ${result.error}`);
          return;
        }
        this.applyFilesDeleted(result);
      },
    };
  }

  endSession() {
    this.ended = true;
    for (const editor of this.editors.values()) editor.endSession();
    this.tree.lock();
  }
}

// MARK: StudentWorkspace
// Read-only view of the instructor's files. In "live" mode it owns all socket routing for the
// instructor's edits: each message goes to the one editor it concerns (by fileId, or by the
// version block it names). In "review" mode (socket: null) it's static -- apart from load(), which
// swaps in a whole new snapshot (the admin replay).
//
// Following: by default the student's tabs mirror the instructor's (INSTRUCTOR_VIEW_STATE). The
// student stops following as soon as they pick a file or tab themselves, open an exercise in a file
// the instructor isn't showing, or the instructor switches away from a file where the student has
// started answering a still-active code exercise (typing alone never unfollows) -- from then on,
// instructor edits still stream in, but tab changes no longer move the student. setFollowing(true)
// snaps back to the instructor's current tabs. Dispatches "followchange" ({detail: {following}}).
//
// Awareness cues (live mode; see instructor-awareness-config.js): while not following, the
// instructor's file is marked in the tree and tabs, files they type in glow, and in their file,
// edge bars point at them when they're scrolled out of view. While following, what happens when
// the instructor is scrolled out of view is the student's choice (followOffscreenMode, gear menu):
// "cues" shows the same edge bars; "scroll" scrolls the editor to keep the instructor in view.
export class StudentWorkspace extends Workspace {
  constructor({ socket = null, mode = "live", instructorView = null, onOpenPollMarker, makeVersionBlockWidget = null, ...rest }) {
    super({ ...rest, editableTree: false });
    this.socket = socket;
    this.mode = mode;
    this.onOpenPollMarker = onOpenPollMarker;
    this.makeVersionBlockWidget = makeVersionBlockWidget;
    this.lastInstructorView = instructorView;
    this.following = true;
    this.answeredExerciseIds = new Set(); // exercises the student has typed an answer into
    this.followOffscreenMode = getFollowOffscreenMode();
    this.sessionEnded = false;

    this.addEventListener("viewchange", ({ detail: { source, activeId } }) => {
      if (source === "user") this.setFollowing(false);
      // Revealing an exercise only breaks away if it lands somewhere the instructor isn't.
      else if (source === "exercise" && activeId !== this.lastInstructorView?.activeFileId) this.setFollowing(false);
    });
    // A newly shown editor couldn't measure while hidden -- have it recheck its edge bars.
    this.addEventListener("activechange", ({ detail: { editor } }) => {
      editor?.view?.dispatch({ effects: refreshAwarenessEffect.of(null) });
    });

    if (socket) {
      for (const type of StudentCodeEditor.SOCKET_MESSAGE_TYPES) {
        socket.on(type, (msg) => this._routeInstructorMessage(type, msg));
      }
      socket.on(SOCKET_MESSAGE_TYPE.FILE_CREATED, ({ file }) => this.fs.upsertFile(file));
      socket.on(SOCKET_MESSAGE_TYPE.FILES_RENAMED, ({ renames }) => this.fs.applyRenames(renames));
      socket.on(SOCKET_MESSAGE_TYPE.FILES_DELETED, (msg) => this.applyFilesDeleted(msg));
      socket.on(SOCKET_MESSAGE_TYPE.INSTRUCTOR_VIEW_STATE, (msg) => this._onInstructorView(msg));
    }

    this._start(instructorView);
    this._updateInstructorMarkers();
  }

  _routeInstructorMessage(type, msg) {
    switch (type) {
      case SOCKET_MESSAGE_TYPE.INSTRUCTOR_EDIT:
        if (msg.fileId != null) this._onInstructorActivity(msg.fileId);
      // falls through
      case SOCKET_MESSAGE_TYPE.INSTRUCTOR_CURSOR:
        if (msg.fileId == null) return;
        return this.editorFor(msg.fileId)?.handleSocketMessage(type, msg);
      case SOCKET_MESSAGE_TYPE.VERSION_BLOCK_CREATED:
        if (msg.fileId == null) return;
        this.editorFor(msg.fileId)?.handleSocketMessage(type, msg);
        // A code exercise's file is found through its version block.
        return this._updateExerciseMarkers();
      default: {
        // Variant messages and VERSION_BLOCK_DELETED name a version block, not a file.
        const editor = this.editorForVersionBlock(msg.versionBlockId);
        if (type === SOCKET_MESSAGE_TYPE.VARIANT_EDIT && editor) this._onInstructorActivity(editor.fileId, editor, msg.versionBlockId);
        editor?.handleSocketMessage(type, msg);
        if (type === SOCKET_MESSAGE_TYPE.VERSION_BLOCK_DELETED) this._updateExerciseMarkers();
        return;
      }
    }
  }

  // MARK: Awareness cues

  _awarenessActive() {
    return (
      INSTRUCTOR_AWARENESS.enabled &&
      this.mode === "live" &&
      !this.sessionEnded &&
      (!this.following || !INSTRUCTOR_AWARENESS.onlyWhenNotFollowing)
    );
  }

  // The editor's off-screen edge bars: always when not following; while following, only if the
  // student chose cues over auto-scroll (or onlyWhenNotFollowing is off).
  _edgeBarsActive() {
    return (
      INSTRUCTOR_AWARENESS.enabled &&
      this.mode === "live" &&
      !this.sessionEnded &&
      (!this.following || this.followOffscreenMode === "cues" || !INSTRUCTOR_AWARENESS.onlyWhenNotFollowing)
    );
  }

  // While following in "scroll" mode, the instructor's file keeps them in view.
  _autoScrollActive() {
    return this.mode === "live" && !this.sessionEnded && this.following && this.followOffscreenMode === "scroll";
  }

  setFollowOffscreenMode(mode) {
    if (this.followOffscreenMode === mode) return;
    this.followOffscreenMode = mode;
    setFollowOffscreenMode(mode);
    this._updateInstructorMarkers();
  }

  // The instructor just edited `fileId` (in a variant of `versionBlockId`, if given): glow its tree
  // row / tab, and let the editor's edge bars / auto-scroll know. Main-doc edits reach the editor's
  // awareness plugin on their own.
  _onInstructorActivity(fileId, editor = null, versionBlockId = null) {
    if (this._awarenessActive()) {
      const shouldFlash = (mode) => mode === "always" || (mode === "other-file" && fileId !== this.activeId);
      if (shouldFlash(INSTRUCTOR_AWARENESS.flashTreeOnEdit)) this.tree.pulseFile(fileId);
      if (shouldFlash(INSTRUCTOR_AWARENESS.flashTabOnEdit)) this.tabs.pulseTab(fileId);
    }
    if (!this._edgeBarsActive() && !this._autoScrollActive()) return;
    if (editor && versionBlockId != null) {
      const pos = editor.getVersionBlock(versionBlockId)?.getPosition(editor.view.state);
      const from = pos?.from ?? pos;
      if (typeof from === "number") editor.view.dispatch({ effects: instructorActivityEffect.of(from) });
    }
  }

  // Marks (or unmarks, when the cues are off) the instructor's file, and has every editor recheck
  // its edge bars.
  _updateInstructorMarkers() {
    const id = this._awarenessActive() ? (this.lastInstructorView?.activeFileId ?? null) : null;
    this.tree.setInstructorFile(INSTRUCTOR_AWARENESS.markInstructorFile.tree ? id : null);
    this.tabs.setInstructorFile(INSTRUCTOR_AWARENESS.markInstructorFile.tab ? id : null);
    for (const editor of this.editors.values()) editor.view?.dispatch({ effects: refreshAwarenessEffect.of(null) });
  }

  _onInstructorView({ openFileIds, activeFileId }) {
    this.lastInstructorView = { openFileIds, activeFileId };
    if (this.following) {
      // Don't pull the student away from an answer they're writing: stay put and stop following.
      if (activeFileId !== this.activeId && this._hasAnswerInProgressIn(this.activeId)) this.setFollowing(false);
      else this._applyInstructorView();
    }
    this._updateInstructorMarkers();
  }

  // Whether `fileId` holds a still-active exercise the student has started answering.
  _hasAnswerInProgressIn(fileId) {
    if (fileId == null) return false;
    return (this.activitiesManager?.getActiveExercises() ?? []).some(
      (ex) => this.answeredExerciseIds.has(ex.id) && this.fileIdForExercise(ex) === fileId,
    );
  }

  _applyInstructorView() {
    const view = this.lastInstructorView;
    if (!view) return;
    this._setView({ openIds: view.openFileIds ?? [], activeId: view.activeFileId }, { source: "instructor" });
  }

  // See Workspace.load. While following, opens the instructor's tabs as of the snapshot.
  load({ instructorView = null, ...rest }) {
    this.lastInstructorView = instructorView;
    super.load({ ...rest, view: this.following ? instructorView : null });
    this._updateInstructorMarkers();
  }

  setFollowing(following) {
    if (this.following === following) return;
    this.following = following;
    if (following) this._applyInstructorView();
    this._updateInstructorMarkers();
    this.dispatchEvent(new CustomEvent("followchange", { detail: { following } }));
  }

  _createEditor(file, node, versionBlocks) {
    const live = this.mode === "live";
    if (live) node.classList.add("uneditable");
    const isInstructorFile = () => this.lastInstructorView?.activeFileId === file.id;
    const awareness = live
      ? [
          instructorAwareness({
            isActive: () => this._edgeBarsActive() && isInstructorFile(),
            shouldAutoScroll: () => this._autoScrollActive() && isInstructorFile(),
          }),
        ]
      : [];
    return new StudentCodeEditor({
      node,
      doc: file.doc,
      docVersion: file.docVersion,
      fileId: file.id,
      fileName: file.name,
      sessionId: this.sessionNumber,
      extraExtensions: [versionBlocksField, ...awareness],
      versionBlocks,
      activitiesManager: this.activitiesManager,
      onOpenPollMarker: this.onOpenPollMarker,
      reviewMode: this.mode === "review",
      makeVersionBlockWidget: this.makeVersionBlockWidget,
      onAnswerEdit: (ex) => this.answeredExerciseIds.add(ex.id),
    });
  }

  // The session ended: stop applying instructor edits.
  stopFollowing() {
    this.sessionEnded = true;
    for (const editor of this.editors.values()) editor.stopFollowing();
    this._updateInstructorMarkers();
  }
}
