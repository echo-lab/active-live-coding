import { pathBasename, pathDirname, validateFilePath } from "../shared-constants.js";
import { GlowTracker, makeExerciseBadge, makeInstructorBadge } from "./instructor-awareness-config.js";

const COLLAPSED_STORAGE_KEY = "file_tree_collapsed";
const WIDTH_STORAGE_KEY = "file_tree_width";
export const DEFAULT_TREE_WIDTH = 190;
export const MIN_TREE_WIDTH = 140;
export const MAX_TREE_WIDTH = 360;

function readPref(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Storage unavailable (e.g. private mode) -- just don't remember it.
  }
}

function clampTreeWidth(width) {
  return Math.round(Math.min(MAX_TREE_WIDTH, Math.max(MIN_TREE_WIDTH, width)));
}

// MARK: FileTreeView
// Renders a LectureFileSystem as a collapsible tree in the left-hand panel. DOM only: every action
// is handed back to the controller through callbacks. With `editable` (instructor), the panel also
// offers new file/folder buttons, a right-click menu (new file, new folder, rename, delete), and
// inline name inputs.
//
// Callbacks:
//   onOpenFile(id)
//   onCreateFile(path) / onCreateDir(path) / onRename(from, to, isDirectory) -- each may return
//     (a promise of) an error message, which keeps the inline input open and shows it
//   onDelete(path, isDirectory)
export class FileTreeView {
  constructor({ panelEl, fs, editable = false, onOpenFile, onCreateFile, onCreateDir, onRename, onDelete }) {
    this.panelEl = panelEl;
    this.fs = fs;
    this.editable = editable;
    this.callbacks = { onOpenFile, onCreateFile, onCreateDir, onRename, onDelete };
    this.activeFileId = null;
    // Student awareness cues: the instructor's file (tint + badge) and files they're typing in (glow).
    this.instructorFileId = null;
    this._glow = new GlowTracker();
    // Files with an active exercise (red "?" badge).
    this.exerciseFileIds = new Set();
    this.collapsedDirs = new Set();
    this.locked = false;
    this._menuEl = null;

    panelEl.classList.add("file-tree-panel");
    panelEl.innerHTML = "";

    const header = document.createElement("div");
    header.className = "file-tree-header";

    this.toggleBtn = document.createElement("button");
    this.toggleBtn.className = "file-tree-toggle";
    this.toggleBtn.addEventListener("click", () => this.setCollapsed(!this.panelEl.classList.contains("collapsed")));
    header.append(this.toggleBtn);

    const title = document.createElement("span");
    title.className = "file-tree-title";
    title.textContent = "Files";
    header.append(title);

    if (editable) {
      const actions = document.createElement("span");
      actions.className = "file-tree-actions";
      actions.append(
        this._iconButton("New file", NEW_FILE_ICON, () => this.startCreate(this._defaultCreateDir(), false)),
        this._iconButton("New folder", NEW_FOLDER_ICON, () => this.startCreate(this._defaultCreateDir(), true)),
      );
      header.append(actions);
      this.actionsEl = actions;
    }
    panelEl.append(header);

    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "file-tree-body";
    panelEl.append(this.bodyEl);

    if (editable) {
      this.bodyEl.addEventListener("contextmenu", (e) => {
        if (e.target.closest(".file-tree-row")) return; // rows handle their own
        e.preventDefault();
        this._openMenu(e, { path: "", isDirectory: true, isRoot: true });
      });
    }

    this._setUpResizer();
    this.setCollapsed(readPref(COLLAPSED_STORAGE_KEY) === "true", { remember: false });
    fs.addEventListener("changed", () => this.render());
    this.render();
  }

  _iconButton(label, svg, onClick) {
    const btn = document.createElement("button");
    btn.className = "file-tree-action";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.innerHTML = svg;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!this.locked) onClick();
    });
    return btn;
  }

  setCollapsed(collapsed, { remember = true } = {}) {
    this.panelEl.classList.toggle("collapsed", collapsed);
    this.toggleBtn.textContent = collapsed ? "»" : "«";
    this.toggleBtn.title = collapsed ? "Show files" : "Hide files";
    if (remember) writePref(COLLAPSED_STORAGE_KEY, collapsed);
    this._applyMarks(); // the toggle button stands in for the rows while collapsed
  }

  // The expanded panel's width, in px (clamped to [MIN_TREE_WIDTH, MAX_TREE_WIDTH]).
  setWidth(width, { remember = true } = {}) {
    const clamped = clampTreeWidth(width);
    this.panelEl.style.setProperty("--file-tree-width", `${clamped}px`);
    if (remember) writePref(WIDTH_STORAGE_KEY, clamped);
  }

  // A drag handle on the panel's right edge. Double-click resets the default width.
  _setUpResizer() {
    const saved = Number(readPref(WIDTH_STORAGE_KEY));
    this.setWidth(saved > 0 ? saved : DEFAULT_TREE_WIDTH, { remember: false });

    const handle = document.createElement("div");
    handle.className = "file-tree-resizer";
    handle.title = "Drag to resize (double-click to reset)";
    this.panelEl.append(handle);

    let startX = 0;
    let startWidth = 0;
    const onMove = (e) => this.setWidth(startWidth + (e.clientX - startX), { remember: false });
    const onUp = (e) => {
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("file-tree-resizing");
      this.setWidth(this.panelEl.getBoundingClientRect().width);
    };
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || this.panelEl.classList.contains("collapsed")) return;
      e.preventDefault();
      startX = e.clientX;
      startWidth = this.panelEl.getBoundingClientRect().width;
      handle.setPointerCapture(e.pointerId);
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
      // Keeps the resize cursor (and suppresses text selection) while dragging over other elements.
      document.body.classList.add("file-tree-resizing");
    });
    handle.addEventListener("dblclick", () => this.setWidth(DEFAULT_TREE_WIDTH));
  }

  setActiveFile(id) {
    this.activeFileId = id;
    for (const row of this.bodyEl.querySelectorAll(".file-tree-row[data-file-id]")) {
      row.classList.toggle("active", Number(row.dataset.fileId) === id);
    }
    // Make sure the active file's folders are expanded.
    const file = id != null ? this.fs.getFile(id) : null;
    if (file) {
      let dir = pathDirname(file.name);
      let expanded = false;
      while (dir) {
        if (this.collapsedDirs.delete(dir)) expanded = true;
        dir = pathDirname(dir);
      }
      if (expanded) this.render();
    }
  }

  // Disables editing (e.g. once the lecture has ended).
  lock() {
    this.locked = true;
    this.actionsEl?.remove();
    this._closeMenu();
  }

  // The folder new files go in when created from the header buttons: the active file's folder.
  _defaultCreateDir() {
    const file = this.activeFileId != null ? this.fs.getFile(this.activeFileId) : null;
    return file ? pathDirname(file.name) : "";
  }

  // MARK: Rendering

  render() {
    this.bodyEl.innerHTML = "";
    const tree = this.fs.buildTree();
    const list = this._renderLevel(tree, 0);
    this.bodyEl.append(list);
    this._applyMarks();
  }

  // MARK: Badges

  // Marks the files with an active exercise. Re-applied on every render.
  setExerciseFiles(ids) {
    this.exerciseFileIds = new Set(ids);
    this._applyMarks();
  }

  // MARK: Instructor awareness (student page)

  // Marks the instructor's file (null: none). Re-applied on every render.
  setInstructorFile(id) {
    this.instructorFileId = id;
    this._applyMarks();
  }

  // Glows the file's row while the instructor types in it (fades shortly after the last call).
  pulseFile(id) {
    this._glow.pulse(id, () => this._visibleRowFor(id));
  }

  // The row standing in for a file: its own row, or the nearest folder row above it if it's inside
  // a collapsed folder, or the panel's toggle button if the whole tree is collapsed.
  _visibleRowFor(id) {
    if (id == null) return null;
    if (this.panelEl.classList.contains("collapsed")) return this.toggleBtn;
    const row = this.bodyEl.querySelector(`.file-tree-row[data-file-id="${id}"]`);
    if (row) return row;
    const file = this.fs.getFile(id);
    let dir = file ? pathDirname(file.name) : "";
    let found = null;
    // Walk up and keep the outermost rendered folder row (inner ones aren't shown).
    while (dir) {
      const dirRow = this.bodyEl.querySelector(`.file-tree-row.is-dir[data-path="${CSS.escape(dir)}"]`);
      if (dirRow) found = dirRow;
      dir = pathDirname(dir);
    }
    return found;
  }

  // Re-applies the exercise badges, then the instructor's tint + badge (so the person comes last),
  // then any glow -- each on the row standing in for its file.
  _applyMarks() {
    for (const el of this.panelEl.querySelectorAll(".instructor-here")) el.classList.remove("instructor-here");
    for (const el of this.panelEl.querySelectorAll(".instructor-badge, .exercise-badge")) el.remove();
    const exerciseRows = new Set();
    for (const id of this.exerciseFileIds) {
      const row = this._visibleRowFor(id);
      if (row) exerciseRows.add(row);
    }
    for (const row of exerciseRows) row.append(makeExerciseBadge({ aggregate: !row.classList.contains("is-file") }));
    const el = this._visibleRowFor(this.instructorFileId);
    if (el) {
      el.classList.add("instructor-here");
      el.append(makeInstructorBadge());
    }
    for (const id of this._glow.glowingKeys()) this._visibleRowFor(id)?.classList.add(this._glow.className);
  }

  _renderLevel(node, depth) {
    const ul = document.createElement("ul");
    ul.className = "file-tree-list";
    ul.dataset.dirPath = node.path;
    for (const dir of node.dirs) {
      const li = document.createElement("li");
      const collapsed = this.collapsedDirs.has(dir.path);
      const row = this._makeRow({ label: dir.name, depth, isDirectory: true, path: dir.path, collapsed });
      row.addEventListener("click", () => {
        if (collapsed) this.collapsedDirs.delete(dir.path);
        else this.collapsedDirs.add(dir.path);
        this.render();
      });
      li.append(row);
      if (!collapsed) li.append(this._renderLevel(dir, depth + 1));
      ul.append(li);
    }
    for (const file of node.files) {
      const li = document.createElement("li");
      const row = this._makeRow({ label: pathBasename(file.name), depth, isDirectory: false, path: file.name });
      row.dataset.fileId = file.id;
      row.title = file.name;
      if (file.id === this.activeFileId) row.classList.add("active");
      row.addEventListener("click", () => this.callbacks.onOpenFile?.(file.id));
      li.append(row);
      ul.append(li);
    }
    return ul;
  }

  _makeRow({ label, depth, isDirectory, path, collapsed = false }) {
    const row = document.createElement("div");
    row.className = "file-tree-row";
    row.classList.add(isDirectory ? "is-dir" : "is-file");
    row.dataset.path = path;
    row.style.paddingLeft = `${8 + depth * 12}px`;

    const icon = document.createElement("span");
    icon.className = "file-tree-icon";
    icon.textContent = isDirectory ? (collapsed ? "▸" : "▾") : "";
    row.append(icon);

    const name = document.createElement("span");
    name.className = "file-tree-name";
    name.textContent = label;
    row.append(name);

    if (this.editable) {
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._openMenu(e, { path, isDirectory });
      });
    }
    return row;
  }

  // MARK: Context menu

  _openMenu(event, { path, isDirectory, isRoot = false }) {
    if (this.locked) return;
    this._closeMenu();
    const menu = document.createElement("div");
    menu.className = "file-tree-menu";
    const createIn = isDirectory ? path : pathDirname(path);
    const items = [
      ["New file", () => this.startCreate(createIn, false)],
      ["New folder", () => this.startCreate(createIn, true)],
    ];
    if (!isRoot) {
      items.push(["Rename", () => this.startRename(path, isDirectory)]);
      items.push(["Delete", () => this.callbacks.onDelete?.(path, isDirectory)]);
    }
    for (const [label, action] of items) {
      const item = document.createElement("button");
      item.className = "file-tree-menu-item";
      item.textContent = label;
      item.addEventListener("click", () => {
        this._closeMenu();
        action();
      });
      menu.append(item);
    }
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    document.body.append(menu);
    this._menuEl = menu;

    this._onDocPointerDown = (e) => {
      if (!menu.contains(e.target)) this._closeMenu();
    };
    this._onDocKeyDown = (e) => {
      if (e.key === "Escape") this._closeMenu();
    };
    document.addEventListener("pointerdown", this._onDocPointerDown, true);
    document.addEventListener("keydown", this._onDocKeyDown, true);
  }

  _closeMenu() {
    if (!this._menuEl) return;
    this._menuEl.remove();
    this._menuEl = null;
    document.removeEventListener("pointerdown", this._onDocPointerDown, true);
    document.removeEventListener("keydown", this._onDocKeyDown, true);
  }

  // MARK: Inline inputs

  // Shows an inline name input at the top of folder `dir` ("" = top level) for a new file/folder.
  startCreate(dir, isDirectory) {
    if (this.locked) return;
    this.setCollapsed(false);
    if (dir) {
      // Expand the target folder (and its ancestors) so the input is visible.
      for (let d = dir; d; d = pathDirname(d)) this.collapsedDirs.delete(d);
      this.render();
    }
    const list = this.bodyEl.querySelector(`ul[data-dir-path="${CSS.escape(dir)}"]`) ?? this.bodyEl.querySelector("ul");
    const li = document.createElement("li");
    const depth = dir ? dir.split("/").length : 0;
    const row = this._makeRow({ label: "", depth, isDirectory, path: "" });
    row.querySelector(".file-tree-name").remove();
    li.append(row);
    list.prepend(li);

    this._mountInput(row, {
      initial: "",
      onCommit: async (name) => {
        if (!isDirectory && !name.includes(".")) name += ".py";
        const path = dir ? `${dir}/${name}` : name;
        const invalid = validateFilePath(path, { isDirectory });
        if (invalid) return invalid;
        return isDirectory ? this.callbacks.onCreateDir?.(path) : this.callbacks.onCreateFile?.(path);
      },
      onDone: () => li.remove(),
    });
  }

  startRename(path, isDirectory) {
    if (this.locked) return;
    const row = this.bodyEl.querySelector(`.file-tree-row[data-path="${CSS.escape(path)}"]`);
    if (!row) return;
    const nameEl = row.querySelector(".file-tree-name");
    nameEl.hidden = true;
    const dir = pathDirname(path);
    this._mountInput(row, {
      initial: pathBasename(path),
      selectBeforeExtension: !isDirectory,
      onCommit: async (name) => {
        // Same convenience as when creating: "util" means "util.py".
        if (!isDirectory && !name.includes(".")) name += ".py";
        const to = dir ? `${dir}/${name}` : name;
        if (to === path) return null;
        const invalid = validateFilePath(to, { isDirectory });
        if (invalid) return invalid;
        return this.callbacks.onRename?.(path, to, isDirectory);
      },
      onDone: () => {
        nameEl.hidden = false;
      },
    });
  }

  // Enter commits (keeping the input open with the error, if any), Escape cancels, and blur
  // commits a non-empty name or cancels an empty one.
  _mountInput(row, { initial, selectBeforeExtension = false, onCommit, onDone }) {
    const input = document.createElement("input");
    input.className = "file-tree-input";
    input.value = initial;
    input.spellcheck = false;
    const error = document.createElement("div");
    error.className = "file-tree-input-error";
    error.hidden = true;
    row.append(input);
    row.after(error);

    let finished = false;
    let busy = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      input.remove();
      error.remove();
      onDone?.();
    };
    const commit = async () => {
      if (busy || finished) return;
      const name = input.value.trim();
      if (!name) return finish();
      busy = true;
      const err = await onCommit(name);
      busy = false;
      if (err) {
        error.textContent = err;
        error.hidden = false;
        input.classList.add("invalid");
        input.focus();
        return;
      }
      finish();
    };

    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") commit();
      else if (e.key === "Escape") finish();
    });
    input.addEventListener("input", () => {
      error.hidden = true;
      input.classList.remove("invalid");
    });
    input.addEventListener("blur", () => {
      // Let a click on the input's own error/row settle first.
      setTimeout(() => {
        if (finished || busy || document.activeElement === input) return;
        if (input.classList.contains("invalid") || !input.value.trim()) finish();
        else commit();
      }, 0);
    });

    input.focus();
    if (selectBeforeExtension && initial.lastIndexOf(".") > 0) input.setSelectionRange(0, initial.lastIndexOf("."));
    else input.select();
  }
}

const NEW_FILE_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="12" y1="12" x2="12" y2="18"></line><line x1="9" y1="15" x2="15" y2="15"></line></svg>`;
const NEW_FOLDER_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path><line x1="12" y1="11" x2="12" y2="17"></line><line x1="9" y1="14" x2="15" y2="14"></line></svg>`;
