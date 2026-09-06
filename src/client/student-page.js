import "./style.css";
import "./style-student-page.css";

import { getEmail, getUserID, POST_JSON_REQUEST } from "./utils.js";

import { io } from "socket.io-client";
import { StudentCodeEditor } from "./code-editors.js";
import {
  versionBlocksField,
  setVersionBlockReadOnly,
} from "./cm-version-widget.js";
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
import {
  SOCKET_MESSAGE_TYPE,
} from "../shared-constants.js";
import { StudentActivitiesPanel } from "./activities-panel.js";
import { StudentActivitiesManager } from "./activities-manager.js";
import { StudentActivePollPopover } from "./poll-active-popover.js";
import { StudentPollCompletePopover } from "./poll-complete-popover.js";
import { PollPopoverCoordinator } from "./poll-popover-coordinator.js";
import { createHistoricalViewController } from "./historical-view-controller.js";

const instructorCodeContainer = document.querySelector(
  "#instructor-code-container"
);
const instructorCodeTab = document.querySelector("#instructor-code-tab");
const runButtonEl = document.querySelector("#run-button");
const codeOutputsEl = document.querySelector("#all-code-outputs");
const codeOutputsContainer = document.querySelector("#output-container");
const consoleResizer = document.querySelector("#resize-console");
makeConsoleResizable(codeOutputsContainer, consoleResizer);
setupDropdownMenu(document.querySelector("#settings-menu-btn"), document.querySelector("#settings-menu"));
let instructorTabActive = true;

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
  liveTabEl: instructorCodeTab,
  historicalTabEl: document.querySelector("#historical-code-tab"),
  historicalTabTextEl: document.querySelector("#historical-code-tab-text"),
  historicalTabCloseBtn: document.querySelector("#historical-code-tab .historical-code-tab-close"),
  liveContainerEl: instructorCodeContainer,
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
  lectureDoc,
  lectureDocVersion,
  playgroundCodeInfo,
  exercises = [],
  studentSessionId,
  versionBlocks = [],
}) {
  currentSessionNumber = sessionNumber;
  socket.emit(SOCKET_MESSAGE_TYPE.JOIN_SESSION, sessionNumber);
  // Socket.IO reconnects (e.g. a wifi blip) get a new server-side socket id that isn't
  // automatically re-joined to the lecture room -- without this, a reconnected student would
  // silently stop receiving live updates until they reload the page.
  socket.on("connect", () => socket.emit(SOCKET_MESSAGE_TYPE.JOIN_SESSION, sessionNumber));

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

  let codeEditor = new StudentCodeEditor({
    node: instructorCodeContainer,
    doc: lectureDoc,
    docVersion: lectureDocVersion,
    socket,
    sessionId: sessionNumber,
    extraExtensions: [versionBlocksField],
    versionBlocks,
    activitiesManager,
    onOpenPollMarker: (exerciseId) => activitiesPanel?.showExerciseById(exerciseId),
  });

  let codeRunner = new PythonCodeRunner();
  let consoleOutput = new Console(codeOutputsEl, { authorLabels: true });

  let runInteractions = new RunInteractions({
    runButtonEl,
    codeEditor,
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

  socket.on(SOCKET_MESSAGE_TYPE.INSTRUCTOR_END_SESSION, () => {
    console.log("SESSION IS ENDED!");
    codeEditor.stopFollowing();
    sessionActive = false;
  });

  const pollPopoverCoordinator = new PollPopoverCoordinator();

  const studentActivePollPopover = new StudentActivePollPopover({
    manager: activitiesManager,
    student_id: userId,
    showPollPopover: (args) => codeEditor.showPollPopover(args),
    hidePollPopover: (key) => codeEditor.hidePollPopover(key),
    coordinator: pollPopoverCoordinator,
    onClose: () => activitiesPanel?.notifyActivePopoverClosed(),
  });

  const studentCompletePollPopover = new StudentPollCompletePopover({
    student_id: userId,
    manager: activitiesManager,
    showPollPopover: (args) => codeEditor.showPollPopover(args),
    hidePollPopover: (key) => codeEditor.hidePollPopover(key),
    coordinator: pollPopoverCoordinator,
    onClose: () => activitiesPanel?.notifyCompletePopoverClosed(),
  });

  activitiesPanel = new StudentActivitiesPanel(activitiesManager, {
    student_id: userId,
    onPollPanelOpenChange: (id) => codeEditor.setPollHighlightOpen(id),
    activePopover: studentActivePollPopover,
    completePopover: studentCompletePollPopover,
    getAnchor: (ex) => {
      if (ex.code_anchor_from != null && ex.code_anchor_to != null) {
        const at = codeEditor.getPollAnchorPosition(ex.id);
        if (at != null) return { kind: "code", at, getRange: () => codeEditor.getPollAnchorRange(ex.id) };
      }
      // Standalone polls (no code anchor) have no dedicated element to anchor to on the
      // student side -- pin the popover to the editor pane's top-right corner instead.
      const paneRect = instructorCodeContainer.getBoundingClientRect();
      return {
        kind: "standalone",
        rect: { top: paneRect.top + 8, bottom: paneRect.top + 8, left: paneRect.right - 8, right: paneRect.right - 8, width: 0, height: 0 },
      };
    },
    scrollToExercise: (ex) => {
      historicalController.returnToLive();
      if (ex.type === "CODE_VARIANT") {
        codeEditor.scrollToVersionBlock(ex.VersionBlockId);
      } else {
        codeEditor.scrollToPollMarker(ex.id);
      }
    },
    openHistoricalView: (ex) => historicalController.open(ex, activitiesManager),
    closeHistoricalView: () => historicalController.returnToLive(),
  });
}

setupJoinLectureModalV2({
  url: "/current-session-student",
  buildBody: (sessionName) => ({ student_id: userId, student_identifier: email, sessionName }),
  onSuccess: initialize,
});

