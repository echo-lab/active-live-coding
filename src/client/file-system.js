import { GET_JSON_REQUEST, POST_JSON_REQUEST } from "./utils.js";
import { isPathUnder, pathBasename, pathDirname } from "../shared-constants.js";

// MARK: LectureFileSystem
// Client-side model of a lecture's files. Files are stored flat by path ("dir/name.py"), exactly
// like the backend; directories are implied by those paths. Directories with no files in them
// (`emptyDirs`) only exist on this client -- the backend never stores them.
//
// Each file: {id, name, doc (array of lines, or null if not loaded yet), docVersion, persistedVersion}.
//
// Dispatches "changed" ({detail: {kind, ids}}) after every mutation, where kind is one of
// "created" | "renamed" | "deleted" | "dirs".
export class LectureFileSystem extends EventTarget {
  constructor({ files = [], sessionNumber = null, userId = null } = {}) {
    super();
    this.sessionNumber = sessionNumber;
    this.userId = userId;
    this.files = new Map();
    this.emptyDirs = new Set();
    for (const f of files) this.files.set(f.id, { ...f });
  }

  // MARK: Reads

  getFile(id) {
    return this.files.get(id) ?? null;
  }

  getFileByName(name) {
    for (const f of this.files.values()) if (f.name === name) return f;
    return null;
  }

  allFiles() {
    return [...this.files.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  filesUnder(dir) {
    return this.allFiles().filter((f) => isPathUnder(f.name, dir));
  }

  // True if `path` names a directory: implied by some file's path, or a local empty directory.
  dirExists(path) {
    if (this.emptyDirs.has(path)) return true;
    for (const f of this.files.values()) if (f.name.startsWith(path + "/")) return true;
    for (const d of this.emptyDirs) if (d.startsWith(path + "/")) return true;
    return false;
  }

  // True if anything (file or directory) already lives at `path`.
  pathTaken(path) {
    return this.getFileByName(path) != null || this.dirExists(path);
  }

  // Nested tree for rendering: {name, path, dirs: [node...], files: [file...]}, each level sorted
  // by name (directories first, as is conventional).
  buildTree() {
    const root = { name: "", path: "", dirs: new Map(), files: [] };
    const dirNode = (path) => {
      let node = root;
      if (path === "") return node;
      let soFar = "";
      for (const segment of path.split("/")) {
        soFar = soFar ? `${soFar}/${segment}` : segment;
        if (!node.dirs.has(segment)) node.dirs.set(segment, { name: segment, path: soFar, dirs: new Map(), files: [] });
        node = node.dirs.get(segment);
      }
      return node;
    };
    for (const dir of this.emptyDirs) dirNode(dir);
    for (const f of this.files.values()) dirNode(pathDirname(f.name)).files.push(f);

    const finalize = (node) => ({
      name: node.name,
      path: node.path,
      dirs: [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name)).map(finalize),
      files: node.files.sort((a, b) => pathBasename(a.name).localeCompare(pathBasename(b.name))),
    });
    return finalize(root);
  }

  // Resolves to the file's content (array of lines). Lazy-load seam: today every file's content
  // arrives with the join payload so this resolves immediately, but a later version could send
  // only names up front and fetch each file the first time it's opened.
  async ensureLoaded(id) {
    const file = this.files.get(id);
    if (!file) throw new Error(`Unknown file #${id}`);
    if (file.doc != null) return file;
    const res = await fetch(`/doc/${id}`, GET_JSON_REQUEST).then((r) => r.json());
    if (res.error) throw new Error(res.error);
    Object.assign(file, { doc: res.doc, docVersion: res.docVersion, persistedVersion: res.persistedVersion });
    return file;
  }

  // MARK: Local mutations (applied from API responses and socket broadcasts -- idempotent)

  _emit(kind, ids = []) {
    this.dispatchEvent(new CustomEvent("changed", { detail: { kind, ids } }));
  }

  upsertFile(file) {
    const existed = this.files.has(file.id);
    this.files.set(file.id, { ...this.files.get(file.id), ...file });
    // Its ancestors aren't empty any more.
    for (const d of [...this.emptyDirs]) if (isPathUnder(file.name, d)) this.emptyDirs.delete(d);
    if (!existed) this._emit("created", [file.id]);
  }

  applyRenames(renames) {
    const changed = [];
    for (const { id, name } of renames) {
      const f = this.files.get(id);
      if (!f || f.name === name) continue;
      f.name = name;
      changed.push(id);
    }
    if (changed.length > 0) this._emit("renamed", changed);
  }

  removeFiles(ids) {
    const removed = ids.filter((id) => this.files.delete(id));
    if (removed.length > 0) this._emit("deleted", removed);
  }

  addEmptyDir(path) {
    if (this.dirExists(path)) return;
    this.emptyDirs.add(path);
    this._emit("dirs");
  }

  // Renames/removes local empty directories under `from` (used alongside the server-side
  // rename/delete of the files under it).
  _renameEmptyDirs(from, to) {
    let any = false;
    for (const d of [...this.emptyDirs]) {
      if (!isPathUnder(d, from)) continue;
      this.emptyDirs.delete(d);
      if (to != null) this.emptyDirs.add(to + d.slice(from.length));
      any = true;
    }
    if (any) this._emit("dirs");
  }

  // MARK: Instructor API
  // Each resolves to null on success, or an error message. On success the server also broadcasts
  // the change to the lecture room; applying it here right away (rather than waiting for our own
  // echo) keeps the UI snappy, and the echo is then a no-op.

  async _post(url, body) {
    try {
      const res = await fetch(url, {
        body: JSON.stringify({ lectureId: this.sessionNumber, userId: this.userId, ...body }),
        ...POST_JSON_REQUEST,
      });
      return await res.json();
    } catch (err) {
      return { error: err.message };
    }
  }

  async createFile(path) {
    if (this.pathTaken(path)) return `${path} already exists`;
    const res = await this._post("/file", { path });
    if (res.error) return res.error;
    this.upsertFile(res.file);
    return null;
  }

  createDir(path) {
    if (this.pathTaken(path)) return `${path} already exists`;
    this.addEmptyDir(path);
    return null;
  }

  async rename(from, to, { isDirectory = false } = {}) {
    if (from === to) return null;
    if (this.pathTaken(to)) return `${to} already exists`;
    const hasFiles = isDirectory ? this.filesUnder(from).length > 0 : true;
    if (hasFiles) {
      const res = await this._post("/files/rename", { from, to, isDirectory });
      if (res.error) return res.error;
      this.applyRenames(res.renames);
    }
    if (isDirectory) this._renameEmptyDirs(from, to);
    return null;
  }

  // Resolves to {error} or the server's {fileIds, versionBlockIds, finishedExerciseIds} (all
  // empty when only local empty directories were removed). Doesn't remove the files from this
  // model itself: the caller does (via removeFiles) after its own cleanup, since it needs to see
  // the files' exercises before they go.
  async delete(path, { isDirectory = false } = {}) {
    const hasFiles = isDirectory ? this.filesUnder(path).length > 0 : true;
    let result = { fileIds: [], versionBlockIds: [], finishedExerciseIds: [] };
    if (hasFiles) {
      result = await this._post("/files/delete", { path, isDirectory });
      if (result.error) return result;
    }
    if (isDirectory) this._renameEmptyDirs(path, null);
    return result;
  }
}
