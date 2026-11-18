import "./style.css";
import "./style-student-page.css";

import { getEmail, getUserID, joinLectureRoom, POST_JSON_REQUEST, showStaleTabOverlay, takeLectureFromUrl } from "./utils.js";

import { io } from "socket.io-client";
import { setVersionBlockReadOnly } from "./cm-version-widget.js";
import { PythonCodeRunner } from "./code-runner.js";
import {
  Console,
  initEventLogging,
  makeActivitiesPanelResizable,
  makeConsoleResizable,
  RunInteractions,
  setUpChangeEmail,
  setUpConsentModal,
  setUpSurveyModal,
  setupDropdownMenu,
  setupJoinLectureModalV2,
} from "./shared-interactions.js";
import { SOCKET_MESSAGE_TYPE } from "../shared-constants.js";
import { LectureFileSystem } from "./file-system.js";
import { StudentWorkspace } from "./workspace.js";
import { StudentActivitiesPanel } from "./activities-panel.js";
import { StudentActivitiesManager } from "./activities-manager.js";
import { StudentActivePollPopover } from "./poll-active-popover.js";
import { StudentPollCompletePopover } from "./poll-complete-popover.js";
import { PollPopoverCoordinator } from "./poll-popover-coordinator.js";
import { createHistoricalViewController } from "./historical-view-controller.js";

const codeContainersHost = document.querySelector("#code-containers");
const fileTabsEl = document.querySelector("#file-tabs");
const runButtonEl = document.querySelector("#run-button");
const codeOutputsEl = document.querySelector("#all-code-outputs");
const codeOutputsContainer = document.querySelector("#output-container");
const consoleResizer = document.querySelector("#resize-console");
makeConsoleResizable(codeOutputsContainer, consoleResizer);
setupDropdownMenu(document.querySelector("#settings-menu-btn"), document.querySelector("#settings-menu"));

const activitiesResizer = document.querySelector("#resize-activities");
const activitiesContainer = document.querySelector("#activities-container");
const { openPanel: openActivitiesPanel, closePanel: closeActivitiesPanel } = makeActivitiesPanelResizable(
  document.querySelector(".parent-container"),
  activitiesResizer,
  activitiesContainer,
  document.querySelector("#open-activities-panel"),
  /*gutterWidth=*/ 5,
  /*minCodeWidth=*/ 400,
  /*minActivitiesWidth=*/ 300,
  /*initiallyCollapsed*/true
);

document.querySelector("#open-activities-panel").addEventListener("click", openActivitiesPanel);
document.querySelector("#student-activities-list-close").addEventListener("click", () => {
  historicalController.returnToLive();
  closeActivitiesPanel();
});

// Handle the email stuff.
const email = getEmail();
const userId = getUserID();
const studentDetailsContainer = document.querySelector("#student-email");
const changeEmailLink = document.querySelector("#change-email");
if (email) {
  studentDetailsContainer.textContent = email;
  setUpChangeEmail(changeEmailLink);
}

setUpConsentModal({ userId });

let currentSessionNumber = null;
setUpSurveyModal({ userId, getSessionNumber: () => currentSessionNumber });

const historicalController = createHistoricalViewController({
  // The whole file-tab strip acts as the "live" tab: clicking any file tab leaves the historical view.
  liveTabEl: fileTabsEl,
  historicalTabEl: document.querySelector("#historical-code-tab"),
  historicalTabTextEl: document.querySelector("#historical-code-tab-text"),
  historicalTabCloseBtn: document.querySelector("#historical-code-tab .historical-code-tab-close"),
  liveContainerEl: codeContainersHost,
  historicalContainerEl: document.querySelector("#historical-code-container"),
  historicalMountEl: document.querySelector("#historical-code-container .historical-editor-mount"),
  returnToLiveBtn: document.querySelector("#return-to-live-btn"),
  createActivePopover: (args) => new StudentActivePollPopover({ ...args, student_id: userId }),
  createCompletePopover: (args) => new StudentPollCompletePopover({ ...args, student_id: userId }),
  studentId: userId,
});

const socket = io();

//////////////////////////////////////////////////////
// OKAY: wait until a session starts to initialize
//////////////////////////////////////////////////////

async function initialize({
  sessionNumber,
  sessionName = null,
  files = [],
  playgroundCodeInfo,
  exercises = [],
  studentSessionId,
  versionBlocks = [],
  instructorView = null,
}) {
  currentSessionNumber = sessionNumber;
  // Joins the lecture room and keeps this socket in it across reconnects (see utils.js).
  joinLectureRoom(socket, sessionNumber);

  initEventLogging(/*isStudent=*/ true, userId, sessionNumber);

  let sessionActive = true;

  setVersionBlockReadOnly(true);

  const activitiesManager = new StudentActivitiesManager({
    sessionNumber,
    userId,
    studentIdentifier: email,
    socket,
    exercises,
  });

  let activitiesPanel;

  const workspace = new StudentWorkspace({
    fs: new LectureFileSystem({ files, sessionNumber, userId }),
    containersHostEl: codeContainersHost,
    tabsEl: fileTabsEl,
    treePanelEl: document.querySelector("#file-tree-panel"),
    sessionNumber,
    activitiesManager,
    versionBlocks,
    instructorView,
    socket,
    onOpenPollMarker: (exerciseId) => activitiesPanel?.showExerciseById(exerciseId),
  });
  // Opening a file tab leaves the historical view.
  workspace.addEventListener("viewchange", ({ detail: { source } }) => {
    if (source === "user") historicalController.returnToLive();
  });

  // Shown whenever the student has stopped following the instructor's tabs.
  const followBtn = document.querySelector("#follow-instructor-btn");
  workspace.addEventListener("followchange", ({ detail: { following } }) => {
    followBtn.hidden = following || !sessionActive;
  });
  followBtn.addEventListener("click", () => {
    historicalController.returnToLive();
    workspace.setFollowing(true);
  });

  // Gear menu: while following, auto-scroll to the instructor instead of showing off-screen cues.
  const autoScrollCheckbox = document.querySelector("#auto-scroll-checkbox");
  autoScrollCheckbox.checked = workspace.followOffscreenMode === "scroll";
  autoScrollCheckbox.addEventListener("change", () => {
    workspace.setFollowOffscreenMode(autoScrollCheckbox.checked ? "scroll" : "cues");
  });

  let codeRunner = new PythonCodeRunner();
  let consoleOutput = new Console(codeOutputsEl, { authorLabels: true });

  let runInteractions = new RunInteractions({
    runButtonEl,
    codeEditor: workspace.runTarget,
    codeRunner,
    consoleOutput,
  });

  function syncRunButtonVisibility() {
    runButtonEl.hidden = !activitiesManager.getActiveExercises()
      .some((ex) => ex.type === "CODE_VARIANT");
  }
  syncRunButtonVisibility();
  activitiesManager.addEventListener("exerciseCreated", syncRunButtonVisibility);
  activitiesManager.addEventListener("exerciseFinished", syncRunButtonVisibility);

  // Purely passive rendering of the instructor's broadcast run -- this client never executes
  // this code itself, it only mirrors incoming events. A msg.runId with no "start" seen yet (e.g.
  // this student joined mid-run) has no entry in consoleOutput's run map, so every method below
  // silently no-ops for it -- that's the intended way late joiners drop in-flight run events.
  socket.on(SOCKET_MESSAGE_TYPE.INSTRUCTOR_CODE_RUN, (msg) => {
    if (!sessionActive) return;
    switch (msg.phase) {
      case "start":
        consoleOutput.startRun(msg.runId, { fileName: msg.fileName, ts: msg.ts, interactive: false });
        break;
      case "output":
        consoleOutput.appendOutput(msg.runId, { stdout: msg.stdout, stderr: msg.stderr });
        break;
      case "awaiting-input":
        consoleOutput.showInputPrompt(msg.runId, {});
        break;
      case "input-text":
        consoleOutput.updateInputText(msg.runId, msg.text);
        break;
      case "input-submitted":
        consoleOutput.submitInputLine(msg.runId, msg.text);
        break;
      case "end":
        consoleOutput.finishRun(msg.runId, msg);
        break;
    }
  });

  watchForNewerTab(sessionNumber, () => {
    workspace.stopFollowing();
    sessionActive = false;
    followBtn.hidden = true;
    socket.disconnect();
    showStaleTabOverlay({
      sessionName,
      title: "This lecture is open in another tab",
      message:
        "To keep your answers in one place, please use the newer tab. " +
        "Reload this one if you'd rather continue here.",
    });
  });

  socket.on(SOCKET_MESSAGE_TYPE.INSTRUCTOR_END_SESSION, () => {
    console.log("SESSION IS ENDED!");
    workspace.stopFollowing();
    sessionActive = false;
    followBtn.hidden = true; // nothing left to follow
  });

  const pollPopoverCoordinator = new PollPopoverCoordinator();

  const studentActivePollPopover = new StudentActivePollPopover({
    manager: activitiesManager,
    student_id: userId,
    showPollPopover: (args) => workspace.showPollPopover(args),
    hidePollPopover: (key) => workspace.hidePollPopover(key),
    coordinator: pollPopoverCoordinator,
    onClose: () => activitiesPanel?.notifyActivePopoverClosed(),
  });

  const studentCompletePollPopover = new StudentPollCompletePopover({
    student_id: userId,
    manager: activitiesManager,
    showPollPopover: (args) => workspace.showPollPopover(args),
    hidePollPopover: (key) => workspace.hidePollPopover(key),
    coordinator: pollPopoverCoordinator,
    onClose: () => activitiesPanel?.notifyCompletePopoverClosed(),
  });

  activitiesPanel = new StudentActivitiesPanel(activitiesManager, {
    student_id: userId,
    onPollPanelOpenChange: (id) => workspace.setPollHighlightOpen(id),
    activePopover: studentActivePollPopover,
    completePopover: studentCompletePollPopover,
    // Standalone polls (no code anchor) have no dedicated element to anchor to on the student
    // side -- the workspace pins the popover to the editor pane's top-right corner instead.
    getAnchor: (ex) => workspace.anchorForExercise(ex),
    scrollToExercise: (ex) => {
      historicalController.returnToLive();
      workspace.scrollToExercise(ex);
    },
    openHistoricalView: (ex) => historicalController.open(ex, activitiesManager),
    closeHistoricalView: () => historicalController.returnToLive(),
  });
}

// MARK: Duplicate tabs
// Newest tab wins: when this browser opens the same lecture in another tab, that tab announces
// itself and every older one locks (otherwise an answer submitted in one tab wouldn't show in the
// other). Purely local -- BroadcastChannel is same-origin, same-browser, and never hits the network;
// the message carries no student identifiers. Best-effort: silently skipped where unsupported.
function watchForNewerTab(sessionNumber, onNewerTab) {
  try {
    const channel = new BroadcastChannel(`alc-student-lecture-${sessionNumber}`);
    channel.addEventListener("message", ({ data }) => {
      if (data?.type !== "opened") return;
      channel.close();
      onNewerTab();
    });
    channel.postMessage({ type: "opened" });
  } catch (err) {
    console.warn("Duplicate-tab detection unavailable:", err);
  }
}

setupJoinLectureModalV2({
  url: "/current-session-student",
  buildBody: (sessionName) => ({ student_id: userId, student_identifier: email, sessionName }),
  onSuccess: initialize,
  // Arrived via a locked tab's Reload button (?lecture=...): rejoin that lecture directly.
  initialSessionName: takeLectureFromUrl(),
});

