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
const { openPanel: openActivitiesPanel } = makeActivitiesPanelResizable(
  document.querySelector(".parent-container"),
  document.querySelector("#resize-activities"),
  document.querySelector("#activities-container"),
  document.querySelector("#toggle-activities-panel"),
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
      tryOpenCreatePopover({ anchorEl: document.querySelector("#poll-button"), from, to, code });
    },
    onOpenPollMarker: (exerciseId) => {
      const ex = activitiesManager.getExercise(exerciseId);
      if (ex) activitiesPanel?.openExercise(ex);
    },
  });

  const pollCreatePopover = new PollCreatePopover({
    manager: activitiesManager,
    getCurrentCode: () => codeEditor.currentCode(),
    onAbandonDraft: () => codeEditor.abandonPollDraft(),
    getPollDraftAnchor: () => codeEditor.getPollDraftAnchor(),
    onHighlightChange: (highlighted) => codeEditor.setPollDraftHighlighted(highlighted),
  });

  const instructorActivePollPopover = new InstructorActivePollPopover({ manager: activitiesManager });

  // Shared by both poll-creation entry points (toolbar button and right-click-on-selection) so
  // the "only one active poll at a time" guard can't be bypassed by either one.
  function tryOpenCreatePopover({ anchorEl, from = null, to = null, code = "" }) {
    const activePoll = activitiesManager
      .getActiveExercises()
      .find((ex) => ex.type === "POLL" || ex.type === "POLL_MCQ");
    if (activePoll) {
      activitiesPanel?.openActivePoll(activePoll);
      return;
    }
    if (from == null) {
      pollCreatePopover.openStandalone({ anchorEl });
      return;
    }
    pollCreatePopover.close(); // tear down any still-open draft popover (and its marker) before starting a new one
    codeEditor.startPollDraft({ from, to });
    const anchorRect = codeEditor.coordsForPollAnchor(from, to);
    pollCreatePopover.openForSelection({ code, anchorRect });
  }

  document.querySelector("#poll-button").addEventListener("click", (e) => {
    tryOpenCreatePopover({ anchorEl: e.currentTarget });
  });

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
    onPollPanelOpenChange: (id) => codeEditor.setPollHighlightOpen(id),
    activePopover: instructorActivePollPopover,
    getAnchorRect: (ex) => {
      if (ex.code_anchor_from != null && ex.code_anchor_to != null) {
        const rect = codeEditor.coordsForPollMarker(ex.id);
        if (rect) return rect;
      }
      return document.querySelector("#poll-button").getBoundingClientRect();
    },
  });
}
