/*
Event types to be stored in the Events Database for offline analysis.

Events are:

CODE_RUN: happens when an instructor or student runs the code. The payload
should include the complete code that was run (i.e., the contents of the editor)
and a timestamp.

STUDENT_START_EXERCISE: happens when a student first makes an edit when answering
either a poll (multiple-choice or free response) or coding exercise. May be
duplicated if the student reloads the page and makes an edit (i.e., this is the
first edit to an exercise for a given page load). Payload is a timestamp and the
exercise ID.

STUDENT_SUBMIT_EXERCISE: happens when a student submits a exercise. Even though
exercise responses are already stored elsewhere, this event gives extra information
if students submit multiple responses. The payload is a timestamp, the exercise ID,
and their answer to the exercise (either multiple-choice, free response, or code).

STUDENT_END_EXERCISE: an event to record the student's answer to an exercise as
the instructor ends it (i.e., the event fires in response to the student's client
receiving the message that the exercise has ended). The payload contains a timestamp,
the exercise ID, and the current answer to the exercise (even if it's unsubmitted).
This is primarily used to see if a student entered an answer but didn't submit it.

INSTRUCTOR_CREATE_VARIANT: an event for when an instructor creates a new variant.
The payload should have the timestamp, the variant ID, the VersionBlock ID, and an
optional flag that says whether the variant was created from the plus button or from
importing a student solution via the sidebar.

INSTRUCTOR_DESTROY_VARIANT: an event for when an instructor deletes a variant.
The payload should contain the timestamp, the variant ID, the VersionBlock ID, the
variant's name, and the content of the variant (i.e., the code).

INSTRUCTOR_START_POLL_CREATION: happens when an instructor opens the "Create poll"
popover (right after right-clicking selected code and choosing "Ask question"), i.e.
before they've written anything. The payload is just a timestamp. Since only one poll
draft can be open at a time, this can be paired with the following
INSTRUCTOR_START_EXERCISE event for the resulting poll to measure how long drafting took.

INSTRUCTOR_START_EXERCISE: happens when an instructor creates any exercise (a poll,
multiple-choice poll, or coding exercise) and it goes live for students. This fires once
the exercise is actually created (server-assigned ID and all), since that's the earliest
point an exercise ID exists. The payload is a timestamp and the exercise ID.

INSTRUCTOR_JOIN_LECTURE / STUDENT_JOIN_LECTURE: fires once per page load, the moment the
instructor's or student's client starts event logging for a lecture (i.e., right after
starting/resuming a session or joining one). The payload is just a timestamp.

INSTRUCTOR_LEAVE_LECTURE / STUDENT_LEAVE_LECTURE: fires when the instructor's or student's
tab is closed, reloaded, or navigated away from (via a `pagehide` listener). Unlike every
other event here, this is delivered immediately via `navigator.sendBeacon` instead of the
normal batched/gzipped flush, since the page may be gone before an async flush could finish --
so this row (and any other events still queued at the time) is stored uncompressed rather than
gzipped. The payload is just a timestamp.

INSTRUCTOR_VIEW_FILES: happens whenever the instructor's open tabs or active tab change (opening,
switching, or closing a file tab). The payload is a timestamp, `openFileIds` (in tab order), and
`activeFileId` (null if no tab is open). Used by the replay page to show which file the instructor
was looking at.
*/
export const EVENT_TYPES = Object.freeze({
  CODE_RUN: 0,
  STUDENT_START_EXERCISE: 1,
  STUDENT_SUBMIT_EXERCISE: 2,
  STUDENT_END_EXERCISE: 3,
  INSTRUCTOR_CREATE_VARIANT: 4,
  INSTRUCTOR_DESTROY_VARIANT: 5,
  INSTRUCTOR_START_POLL_CREATION: 6,
  INSTRUCTOR_START_EXERCISE: 7,
  INSTRUCTOR_JOIN_LECTURE: 8,
  STUDENT_JOIN_LECTURE: 9,
  INSTRUCTOR_LEAVE_LECTURE: 10,
  STUDENT_LEAVE_LECTURE: 11,
  INSTRUCTOR_VIEW_FILES: 12,
});

export const ANONYMOUS_STUDENT_MODE = true;

// Every lecture starts with this one file.
export const DEFAULT_FILE_NAME = "main.py";

// Picks a lecture's "main" file out of a `files` list -- the default tab when nothing else says
// which file to show.
export function getMainFile(files = []) {
  return files.find((f) => f.name === DEFAULT_FILE_NAME) ?? files[0] ?? null;
}

// MARK: File paths
// Files are stored flat, by path ("dir/sub/name.py"); directories are implied by those paths.
export const MAX_FILE_PATH_LENGTH = 200;
const PATH_SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;

// Returns null if `path` is a valid file (or, with isDirectory, directory) path, else a short
// human-readable reason it isn't. Shared by the client (inline validation) and server (enforcement).
export function validateFilePath(path, { isDirectory = false } = {}) {
  if (typeof path !== "string" || path.length === 0) return "Name can't be empty.";
  if (path.length > MAX_FILE_PATH_LENGTH) return `Path is too long (max ${MAX_FILE_PATH_LENGTH} characters).`;
  if (path.startsWith("/") || path.endsWith("/")) return "Path can't start or end with '/'.";
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return "Path has an empty, '.', or '..' segment.";
    if (!PATH_SEGMENT_RE.test(segment)) return "Names may only use letters, digits, '_', '-', and '.'.";
  }
  if (!isDirectory && !path.endsWith(".py")) return "Only .py files are supported.";
  if (!isDirectory && path.split("/").pop() === ".py") return "File name can't be empty.";
  return null;
}

export function pathBasename(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}

// "" for top-level paths.
export function pathDirname(path) {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

// True if `path` is `dir` itself or lives anywhere under it.
export function isPathUnder(path, dir) {
  return path === dir || path.startsWith(dir + "/");
}

export const SOCKET_MESSAGE_TYPE = Object.freeze({
  JOIN_SESSION: "JOIN_SESSION",
  INSTRUCTOR_EDIT: "INSTRUCTOR_EDIT",
  // {sessionId, fileId, anchor, head}
  INSTRUCTOR_CURSOR: "INSTRUCTOR_CURSOR",
  // Payload always carries {runId, sessionId, phase}, where phase is one of:
  // "start" | "output" | "awaiting-input" | "input-text" | "input-submitted" | "end".
  // One run's messages are correlated purely by runId -- the server relay is a stateless
  // pass-through, so ordering/dropping for late-joining clients is handled entirely client-side.
  INSTRUCTOR_CODE_RUN: "INSTRUCTOR_CODE_RUN",
  INSTRUCTOR_END_SESSION: "INSTRUCTOR_END_SESSION",
  STUDENT_CODE_EDIT: "STUDENT_CODE_EDIT",
  STUDENT_NOTES_EDIT: "STUDENT_NOTES_EDIT",
  INSTRUCTOR_OUT_OF_SYNC: "INSTRUCTOR_OUT_OF_SYNC",
  // Server -> ONLY the socket whose edit was rejected: {sessionId, fileId, variantId, reason}, where
  // reason is "stale" (edit built on an old version -- usually another tab is editing the same
  // lecture), "gap", or "error". The server ignores every later edit/relay from that socket.
  EDIT_REJECTED: "EDIT_REJECTED",
  // Server -> lecture room: {docId, variantId (null for files), version} -- every change to that
  // document before `version` has been durably written to the DB.
  DOC_PERSISTED: "DOC_PERSISTED",
  STUDENT_OUT_OF_SYNC: "STUDENT_OUT_OF_SYNC",
  EXERCISE_CREATED: "EXERCISE_CREATED",
  EXERCISE_FINISHED: "EXERCISE_FINISHED",
  STUDENT_SUBMITTED: "STUDENT_SUBMITTED",
  VERSION_BLOCK_CREATED: "VERSION_BLOCK_CREATED",
  VARIANT_ADDED: "VARIANT_ADDED",
  VARIANT_RENAMED: "VARIANT_RENAMED",
  VARIANT_DELETED: "VARIANT_DELETED",
  VARIANT_EDIT: "VARIANT_EDIT",
  VARIANT_CURSOR: "VARIANT_CURSOR",
  VERSION_BLOCK_DELETED: "VERSION_BLOCK_DELETED",
  // Server -> lecture room, after the corresponding HTTP request succeeds:
  //   FILE_CREATED  {file: {id, name, doc, docVersion, persistedVersion}}
  //   FILES_RENAMED {renames: [{id, name}]}
  //   FILES_DELETED {fileIds, versionBlockIds, finishedExerciseIds}
  FILE_CREATED: "FILE_CREATED",
  FILES_RENAMED: "FILES_RENAMED",
  FILES_DELETED: "FILES_DELETED",
  // Instructor -> lecture room: {sessionId, openFileIds, activeFileId}. The server also remembers
  // the latest one per lecture so late joiners start on the instructor's tabs.
  INSTRUCTOR_VIEW_STATE: "INSTRUCTOR_VIEW_STATE",
  // Server -> lecture room, after the instructor picks a new Python version: {sessionId, pythonVersion}.
  PYTHON_VERSION_CHANGED: "PYTHON_VERSION_CHANGED",
});

// MARK: Python versions
// Each Pyodide release bundles exactly one CPython version, so picking a Python version for a
// lecture just means loading the matching Pyodide build (see pyodide-webworker.js). Keys are the
// Python versions offered in the instructor's settings menu (newest first); values are Pyodide
// versions on the jsdelivr CDN.
export const PYTHON_VERSIONS = Object.freeze({
  "3.14": "314.0.8", // Python 3.14.2
  "3.13": "0.29.5", // Python 3.13.2
  "3.12": "0.27.8", // Python 3.12.7
});
export const DEFAULT_PYTHON_VERSION = "3.14";

// A lecture's stored python_version is nullable: null (or anything we no longer offer) means the default.
export function resolvePythonVersion(pythonVersion) {
  return Object.hasOwn(PYTHON_VERSIONS, pythonVersion ?? "") ? pythonVersion : DEFAULT_PYTHON_VERSION;
}
