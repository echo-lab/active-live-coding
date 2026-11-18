import "./style.css";

import { io } from "socket.io-client";
import { POST_JSON_REQUEST, getUserID, joinLectureRoom, setupSimulateResponsesCheckbox, showStaleTabOverlay, takeLectureFromUrl } from "./utils.js";

import { PythonCodeRunner } from "./code-runner.js";
import {
  Console,
  RunInteractions,
  initEventLogging,
  makeActivitiesPanelResizable,
  makeConsoleResizable,
  recordEvent,
  setupDropdownMenu,
} from "./shared-interactions.js";
import { EVENT_TYPES, SOCKET_MESSAGE_TYPE } from "../shared-constants.js";
import { LectureFileSystem } from "./file-system.js";
import { InstructorWorkspace } from "./workspace.js";
import { InstructorActivitiesPanel } from "./activities-panel.js";
import { InstructorActivitiesManager } from "./activities-manager.js";
import { fillInBlankExtensions } from "./cm-fill-in-the-blank.js";
import { PollCreatePopover } from "./poll-create-popover.js";
import { InstructorActivePollPopover } from "./poll-active-popover.js";
import { InstructorPollCompletePopover } from "./poll-complete-popover.js";
import { PollPopoverCoordinator } from "./poll-popover-coordinator.js";
import { createHistoricalViewController } from "./historical-view-controller.js";

const codeContainersHost = document.querySelector("#code-containers");
// Assigned once initialize() runs (session start) -- declared up here so the historicalController
// below can reach it via closure, since it's constructed before any session exists.
let activitiesPanel;
const historicalController = createHistoricalViewController({
  // The whole file-tab strip acts as the "live" tab: clicking any file tab leaves the historical view.
  liveTabEl: document.querySelector("#file-tabs"),
  historicalTabEl: document.querySelector("#historical-code-tab"),
  historicalTabTextEl: document.querySelector("#historical-code-tab-text"),
  historicalTabCloseBtn: document.querySelector("#historical-code-tab .historical-code-tab-close"),
  liveContainerEl: codeContainersHost,
  historicalContainerEl: document.querySelector("#historical-code-container"),
  historicalMountEl: document.querySelector("#historical-code-container .historical-editor-mount"),
  returnToLiveBtn: document.querySelector("#return-to-live-btn"),
  createActivePopover: (args) => new InstructorActivePollPopover(args),
  createCompletePopover: (args) => new InstructorPollCompletePopover(args),
  onClose: (exerciseId) => activitiesPanel?.notifyHistoricalViewClosed(exerciseId),
});
const endButton = document.querySelector("#end-session-butt");
const sessionDetails = document.querySelector("#session-details");
const sessionEndedWarning = document.querySelector("#session-ended-warning");
const runButtonEl = document.querySelector("#run-button");
const outputCodeContainer = document.querySelector("#all-code-outputs");
const consoleResizer = document.querySelector("#resize-console");
const codeOutputsContainer = document.querySelector("#output-container");
setupSimulateResponsesCheckbox("#simulate-responses-checkbox");

makeConsoleResizable(codeOutputsContainer, consoleResizer);
setupDropdownMenu(document.querySelector("#settings-menu-btn"), document.querySelector("#settings-menu"));
const { openPanel: openActivitiesPanel, closePanel: closeActivitiesPanel } = makeActivitiesPanelResizable(
  document.querySelector(".parent-container"),
  document.querySelector("#resize-activities"),
  document.querySelector("#activities-container"),
  document.querySelector("#open-activities-panel"),
  /*gutterWidth=*/ 5,
  /*minCodeWidth=*/ 400,
  /*minActivitiesWidth=*/ 300,
  /*initiallyCollapsed=*/ true,
);

const userId = getUserID();

// The server only accepts instructor messages (edits, exercises, ...) from a socket whose handshake
// names the lecture's instructor -- see asInstructor in main.js. Handshake auth (rather than a
// field on JOIN_SESSION) is resent on every reconnect *before* any buffered emits are flushed.
const socket = io({ auth: { userId } });
// Change ID X gets you to doc version X+1

///////////////////////////////
// Initialize w/ the Server
///////////////////////////////

const modal = document.querySelector("#start-session-modal");
const sessionNameInput = document.querySelector("#session-name-input");
const startModalBtn = document.querySelector("#start-session-modal-btn");
const sessionError = document.querySelector("#start-session-error");

sessionNameInput.focus();

async function getOrCreateSession(sessionName) {
  const response = await fetch("/lecture-session", {
    body: JSON.stringify({ sessionName, userId }),
    ...POST_JSON_REQUEST,
  });
  let res = await response.json();
  if (res.error) {
    return null;
  }
  modal.style.display = "none";
  document.querySelector("#session-name-display").innerText =
    `Lecture ID: ${sessionName}`;
  setUpCopyReviewLink(res.uuid);
  initialize({ ...res, sessionName });
  return res.sessionNumber;
}

function setUpCopyReviewLink(uuid) {
  if (!uuid) return;
  const btn = document.querySelector("#copy-review-link-btn");
  const label = btn.querySelector(".review-link-text");
  btn.hidden = false;
  btn.addEventListener("click", async () => {
    const url = `${location.origin}/pages/review-lecture.html?id=${uuid}`;
    await navigator.clipboard.writeText(url);
    const original = label.textContent;
    label.textContent = "Copied!";
    setTimeout(() => { label.textContent = original; }, 1500);
  });
}

const tryStartSession = async () => {
  const sessionName = sessionNameInput.value.trim();
  if (!sessionName) {
    sessionError.textContent = "Please enter a valid session name.";
    return;
  }
  startModalBtn.disabled = true;
  const sessionNumber = await getOrCreateSession(sessionName);
  if (!sessionNumber) {
    sessionError.textContent = "Could not start session -- the name you chose is already taken.";
    sessionError.style.color = "red";
    startModalBtn.disabled = false;
  }
};

startModalBtn.addEventListener("click", tryStartSession);
sessionNameInput.addEventListener("keypress", (ev) => {
  ev.key === "Enter" && tryStartSession();
});

// Arrived via a locked tab's Reload button (?lecture=...): rejoin that lecture directly.
const lectureFromUrl = takeLectureFromUrl();
if (lectureFromUrl) {
  sessionNameInput.value = lectureFromUrl;
  tryStartSession();
}

// Start up the editor and hook up the end session button.
function initialize({
  files = [],
  sessionNumber = null,
  sessionName = null,
  exercises = [],
  versionBlocks = [],
  instructorView = null,
}) {
  endButton.disabled = false;
  sessionDetails.textContent = `Session: ${sessionNumber}`;

  // Joins the lecture room and keeps this socket in it across reconnects (see utils.js).
  joinLectureRoom(socket, sessionNumber);

  initEventLogging(/*isStudent=*/ false, userId, sessionNumber);

  const activitiesManager = new InstructorActivitiesManager({
    sessionNumber,
    exercises,
    socket,
    userId,
  });

  const workspace = new InstructorWorkspace({
    fs: new LectureFileSystem({ files, sessionNumber, userId }),
    containersHostEl: codeContainersHost,
    tabsEl: document.querySelector("#file-tabs"),
    treePanelEl: document.querySelector("#file-tree-panel"),
    sessionNumber,
    activitiesManager,
    versionBlocks,
    instructorView,
    socket,
    onCreatePollRequested: ({ from, to, code }) => {
      tryOpenCreatePopover({ from, to, code });
    },
    onOpenPollMarker: (exerciseId) => {
      const ex = activitiesManager.getExercise(exerciseId);
      if (ex) activitiesPanel?.openExercise(ex);
    },
  });
  // Opening a file tab leaves the historical view.
  workspace.addEventListener("viewchange", ({ detail: { source } }) => {
    if (source === "user") historicalController.returnToLive();
  });

  const pollPopoverCoordinator = new PollPopoverCoordinator();

  // The editor the current poll draft lives in -- the draft stays tied to it even if the
  // instructor switches tabs while writing the question.
  let draftEditor = null;

  const pollCreatePopover = new PollCreatePopover({
    manager: activitiesManager,
    getCurrentCode: () => (draftEditor ?? workspace.activeEditor)?.currentCode() ?? "",
    onAbandonDraft: () => draftEditor?.abandonPollDraft(),
    getPollDraftAnchor: () => draftEditor?.getPollDraftAnchor() ?? null,
    onHighlightChange: (highlighted) => draftEditor?.setPollDraftHighlighted(highlighted),
    showPollPopover: (args) => (draftEditor ?? workspace.activeEditor)?.showPollPopover(args),
    hidePollPopover: (key) => workspace.hidePollPopover(key),
    coordinator: pollPopoverCoordinator,
  });

  // A draft can't outlive its file.
  workspace.addEventListener("filesdeleted", ({ detail: { fileIds } }) => {
    if (draftEditor && fileIds.includes(draftEditor.fileId)) {
      pollCreatePopover.close();
      draftEditor = null;
    }
  });

  const instructorActivePollPopover = new InstructorActivePollPopover({
    manager: activitiesManager,
    showPollPopover: (args) => workspace.showPollPopover(args),
    hidePollPopover: (key) => workspace.hidePollPopover(key),
    coordinator: pollPopoverCoordinator,
    onClose: () => activitiesPanel?.notifyActivePopoverClosed(),
  });

  const instructorCompletePollPopover = new InstructorPollCompletePopover({
    showPollPopover: (args) => workspace.showPollPopover(args),
    hidePollPopover: (key) => workspace.hidePollPopover(key),
    coordinator: pollPopoverCoordinator,
    onClose: () => activitiesPanel?.notifyCompletePopoverClosed(),
  });

  // The only poll-creation entry point (right-click "Create Poll" in the editor).
  function tryOpenCreatePopover({ from, to, code = "" }) {
    recordEvent(EVENT_TYPES.INSTRUCTOR_START_POLL_CREATION);
    pollCreatePopover.close(); // tear down any still-open draft popover (and its marker) before starting a new one
    draftEditor = workspace.activeEditor;
    if (!draftEditor) return;
    draftEditor.startPollDraft({ from, to });
    const at = draftEditor.getPollDraftAnchor()?.from;
    pollCreatePopover.openForSelection({ code, at });
  }

  let codeRunner = new PythonCodeRunner();
  let consoleOutput = new Console(outputCodeContainer);

  let runInteractions = new RunInteractions({
    runButtonEl,
    codeEditor: workspace.runTarget,
    codeRunner,
    consoleOutput,
    broadcastResult: (msg) =>
      socket.emit(SOCKET_MESSAGE_TYPE.INSTRUCTOR_CODE_RUN, { ...msg, sessionId: sessionNumber }),
  });

  endButton.addEventListener("click", async () => {
    const confirmed = confirm(
      'Are you sure you want to end the lecture? If you just meant to stop an exercise, click the "finish" button in the exercise panel to the right of the code editor'
    );
    if (!confirmed) return;
    endButton.disabled = true;
    sessionDetails.textContent += " (Terminated)";
    sessionEndedWarning.hidden = false;
    workspace.endSession();
    activitiesManager.endSession();
    socket.emit(SOCKET_MESSAGE_TYPE.INSTRUCTOR_END_SESSION, { sessionNumber });
  });

  // MARK: Stale tab lock
  // Freezes this tab for good: same read-only state as after "End lecture" (editors, version blocks,
  // file tree, exercises), then drops the socket so nothing else (cursor, view state, code runs)
  // goes out. The server has usually fenced us already; this is the client half.
  let locked = false;
  function lockAsStale({ title, message }) {
    if (locked) return;
    locked = true;
    workspace.endSession();
    activitiesManager.endSession();
    endButton.disabled = true;
    runButtonEl.disabled = true;
    socket.disconnect();
    showStaleTabOverlay({ title, message, sessionName });
  }
  const OTHER_TAB_NOTICE = {
    title: "This lecture was changed in another tab or window",
    message:
      "To avoid conflicting edits, this tab is now read-only. Close it and keep using the other one, " +
      "or reload to continue here with the latest version.",
  };
  const OUT_OF_SYNC_NOTICE = {
    title: "This tab is out of sync",
    message:
      "This tab's copy of the lecture no longer matches the server, so it's now read-only. " +
      "Reload to continue with the latest version. (Is the lecture open in another tab or window?)",
  };

  // Another tab's change reached us -- our copy is behind.
  workspace.addEventListener("stale", () => lockAsStale(OTHER_TAB_NOTICE));
  // The server rejected one of our edits (and now ignores this socket).
  socket.on(SOCKET_MESSAGE_TYPE.EDIT_REJECTED, ({ sessionId, reason }) => {
    if (Number(sessionId) !== sessionNumber) return;
    lockAsStale(reason === "stale" ? OTHER_TAB_NOTICE : OUT_OF_SYNC_NOTICE);
  });
  // Room-wide notice that the server's copy hit a gap/apply error. If it was our edit, we also got
  // EDIT_REJECTED; either way this tab can't safely keep editing.
  socket.on(SOCKET_MESSAGE_TYPE.INSTRUCTOR_OUT_OF_SYNC, ({ sessionId: problemSesh, error }) => {
    if (parseInt(problemSesh) !== sessionNumber) return;
    console.warn("Server reported out of sync:", error);
    lockAsStale(OUT_OF_SYNC_NOTICE);
  });

  // Once a poll draft is actually submitted, swap its draft marker for a persisted one.
  activitiesManager.addEventListener("exerciseCreated", ({ detail: { exercise } }) => {
    if (exercise.type === "POLL" || exercise.type === "POLL_MCQ") {
      draftEditor?.finalizePollDraft(exercise.id);
    }
  });

  activitiesPanel = new InstructorActivitiesPanel(activitiesManager, {
    activitiesPanelEl: document.querySelector("#activities-container"),
    openPanel: openActivitiesPanel,
    closePanel: closeActivitiesPanel,
    onPollPanelOpenChange: (id) => workspace.setPollHighlightOpen(id),
    activePopover: instructorActivePollPopover,
    completePopover: instructorCompletePollPopover,
    // A poll's code anchor can still be nulled out post-creation if the anchored code is later
    // entirely deleted (see LectureSession._resolvePollAnchors) -- the workspace then pins the
    // popover to a fixed point near the code editor pane, same pattern as the student side.
    getAnchor: (ex) => workspace.anchorForExercise(ex),
    scrollToExercise: (ex) => {
      historicalController.returnToLive();
      workspace.scrollToExercise(ex);
    },
    openHistoricalView: (ex) => historicalController.open(ex, activitiesManager),
    closeHistoricalView: () => historicalController.returnToLive(),
    // Reveal the block first (switching files if needed) so the new variant's flash is visible.
    addResponseAsVariant: (ex, code, label) => {
      historicalController.returnToLive();
      workspace.revealExercise(ex);
      return workspace.editorForVersionBlock(ex.VersionBlockId)?.getVersionBlock(ex.VersionBlockId)?.addVariantFromCode(code, label);
    },
  });

  document.querySelector("#open-activities-panel").addEventListener("click", () => activitiesPanel.openToList());
}
