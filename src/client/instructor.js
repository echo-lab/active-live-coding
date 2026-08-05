import "./style.css";

import { io } from "socket.io-client";
import { POST_JSON_REQUEST, getUserID, setupSimulateResponsesCheckbox } from "./utils.js";

import { PythonCodeRunner } from "./code-runner.js";
import {
  Console,
  RunInteractions,
  makeActivitiesPanelResizable,
  makeConsoleResizable,
} from "./shared-interactions.js";
import { InstructorCodeEditor } from "./code-editors.js";
import { CLIENT_TYPE, SOCKET_MESSAGE_TYPE } from "../shared-constants.js";
import { InstructorActivitiesPanel } from "./activities-panel.js";
import { InstructorActivitiesManager } from "./activities-manager.js";
import { fillInBlankExtensions } from "./cm-fill-in-the-blank.js";
import { PollCreatePopover } from "./poll-create-popover.js";
import { InstructorActivePollPopover } from "./poll-active-popover.js";
import { InstructorPollCompletePopover } from "./poll-complete-popover.js";
import { PollPopoverCoordinator } from "./poll-popover-coordinator.js";

const codeContainer = document.querySelector("#code-container");
const startButton = document.querySelector("#start-session-butt");
const endButton = document.querySelector("#end-session-butt");
const sessionDetails = document.querySelector("#session-details");
const runButtonEl = document.querySelector("#run-button");
const outputCodeContainer = document.querySelector("#all-code-outputs");
const consoleResizer = document.querySelector("#resize-console");
const codeOutputsContainer = document.querySelector("#output-container");
setupSimulateResponsesCheckbox("#simulate-responses-checkbox");

makeConsoleResizable(codeOutputsContainer, consoleResizer, true);
const { openPanel: openActivitiesPanel, closePanel: closeActivitiesPanel } = makeActivitiesPanelResizable(
  document.querySelector(".parent-container"),
  document.querySelector("#resize-activities"),
  document.querySelector("#activities-container"),
  document.querySelector("#open-activities-panel"),
  /*gutterWidth=*/ 12,
  /*minCodeWidth=*/ 400,
  /*minActivitiesWidth=*/ 300,
  /*initiallyCollapsed=*/ true,
);

const userId = getUserID();

const socket = io();
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
  initialize(res);
  return res.sessionNumber;
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

// Start up the editor and hook up the end session button.
function initialize({
  doc = null,
  docVersion = null,
  sessionNumber = null,
  exercises = [],
  versionBlocks = [],
}) {
  startButton.disabled = true;
  endButton.disabled = false;
  sessionDetails.textContent = `Session: ${sessionNumber}`;

  const activitiesManager = new InstructorActivitiesManager({
    sessionNumber,
    exercises,
    socket,
    userId,
  });

  let activitiesPanel;

  let codeEditor = new InstructorCodeEditor({
    node: codeContainer,
    socket,
    doc,
    startVersion: docVersion,
    sessionNumber,
    versionBlocks,
    activitiesManager,
    onCreatePollRequested: ({ from, to, code }) => {
      tryOpenCreatePopover({ from, to, code });
    },
    onOpenPollMarker: (exerciseId) => {
      const ex = activitiesManager.getExercise(exerciseId);
      if (ex) activitiesPanel?.openExercise(ex);
    },
  });

  const pollPopoverCoordinator = new PollPopoverCoordinator();

  const pollCreatePopover = new PollCreatePopover({
    manager: activitiesManager,
    getCurrentCode: () => codeEditor.currentCode(),
    onAbandonDraft: () => codeEditor.abandonPollDraft(),
    getPollDraftAnchor: () => codeEditor.getPollDraftAnchor(),
    onHighlightChange: (highlighted) => codeEditor.setPollDraftHighlighted(highlighted),
    showPollPopover: (args) => codeEditor.showPollPopover(args),
    hidePollPopover: (key) => codeEditor.hidePollPopover(key),
    coordinator: pollPopoverCoordinator,
  });

  const instructorActivePollPopover = new InstructorActivePollPopover({
    manager: activitiesManager,
    showPollPopover: (args) => codeEditor.showPollPopover(args),
    hidePollPopover: (key) => codeEditor.hidePollPopover(key),
    coordinator: pollPopoverCoordinator,
    onClose: () => activitiesPanel?.notifyActivePopoverClosed(),
  });

  const instructorCompletePollPopover = new InstructorPollCompletePopover({
    showPollPopover: (args) => codeEditor.showPollPopover(args),
    hidePollPopover: (key) => codeEditor.hidePollPopover(key),
    coordinator: pollPopoverCoordinator,
    onClose: () => activitiesPanel?.notifyCompletePopoverClosed(),
  });

  // The only poll-creation entry point (right-click "Create Poll" in the editor).
  function tryOpenCreatePopover({ from, to, code = "" }) {
    pollCreatePopover.close(); // tear down any still-open draft popover (and its marker) before starting a new one
    codeEditor.startPollDraft({ from, to });
    const at = codeEditor.getPollDraftAnchor()?.from;
    pollCreatePopover.openForSelection({ code, at });
  }

  let codeRunner = new PythonCodeRunner();
  let consoleOutput = new Console(outputCodeContainer);

  let runInteractions = new RunInteractions({
    runButtonEl,
    codeEditor,
    codeRunner,
    consoleOutput,
    sessionNumber,
    source: CLIENT_TYPE.INSTRUCTOR,
    userId,
    broadcastResult: (msg) =>
      socket.emit(SOCKET_MESSAGE_TYPE.INSTRUCTOR_CODE_RUN, msg),
  });

  endButton.addEventListener("click", async () => {
    const confirmed = confirm(
      'Are you sure you want to end the lecture? If you just meant to stop an exercise, click the "finish" button in the exercise panel to the right of the code editor'
    );
    if (!confirmed) return;
    // TODO: make it so you can't edit the code :)
    endButton.disabled = true;
    sessionDetails.textContent += " (Terminated)";
    codeEditor.endSession();
    socket.emit(SOCKET_MESSAGE_TYPE.INSTRUCTOR_END_SESSION, { sessionNumber });
  });

  socket.on(
    SOCKET_MESSAGE_TYPE.INSTRUCTOR_OUT_OF_SYNC,
    ({ sessionId: problemSesh, error }) => {
      if (parseInt(problemSesh) === sessionNumber) {
        alert(`Please restart: out of sync w/ server (${error})`);
      }
    },
  );

  // Once a poll draft is actually submitted, swap its draft marker for a persisted one.
  activitiesManager.addEventListener("exerciseCreated", ({ detail: { exercise } }) => {
    if (exercise.type === "POLL" || exercise.type === "POLL_MCQ") {
      codeEditor.finalizePollDraft(exercise.id);
    }
  });

  activitiesPanel = new InstructorActivitiesPanel(activitiesManager, {
    activitiesPanelEl: document.querySelector("#activities-container"),
    openPanel: openActivitiesPanel,
    closePanel: closeActivitiesPanel,
    onPollPanelOpenChange: (id) => codeEditor.setPollHighlightOpen(id),
    activePopover: instructorActivePollPopover,
    completePopover: instructorCompletePollPopover,
    getAnchor: (ex) => {
      if (ex.code_anchor_from != null && ex.code_anchor_to != null) {
        const at = codeEditor.getPollAnchorPosition(ex.id);
        if (at != null) return { kind: "code", at, getRange: () => codeEditor.getPollAnchorRange(ex.id) };
      }
      // A poll's code anchor can still be nulled out post-creation if the anchored code is later
      // entirely deleted (see LectureSession._resolvePollAnchors) -- pin the popover to a fixed
      // point near the code editor pane in that case, same pattern as the student side.
      const paneRect = codeContainer.getBoundingClientRect();
      return {
        kind: "standalone",
        rect: { top: paneRect.top + 8, bottom: paneRect.top + 8, left: paneRect.right - 8, right: paneRect.right - 8, width: 0, height: 0 },
      };
    },
    scrollToExercise: (ex) => codeEditor.scrollToPollMarker(ex.id),
  });

  document.querySelector("#open-activities-panel").addEventListener("click", () => activitiesPanel.openToList());
}
