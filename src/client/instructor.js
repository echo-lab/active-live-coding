import "./style.css";

import { io } from "socket.io-client";
import { POST_JSON_REQUEST, getUserID } from "./utils.js";

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
import { fillInBlankExtensions } from "./cm-fill-in-the-blank.js";

const codeContainer = document.querySelector("#code-container");
const startButton = document.querySelector("#start-session-butt");
const endButton = document.querySelector("#end-session-butt");
const sessionDetails = document.querySelector("#session-details");
const runButtonEl = document.querySelector("#run-button");
const outputCodeContainer = document.querySelector("#all-code-outputs");
const consoleResizer = document.querySelector("#resize-console");
const codeOutputsContainer = document.querySelector("#output-container");

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

async function getOrCreateSession(sessionName) {
  const response = await fetch("/lecture-session", {
    body: JSON.stringify({ sessionName, userId }),
    ...POST_JSON_REQUEST,
  });
  let res = await response.json();
  if (res.error) {
    alert(res.error);
    return null;
  }
  document.querySelector("#session-name-display").innerText =
    `Lecture ID: ${sessionName}`;
  initialize(res);
  return res.sessionNumber;
}

// If it's not disabled already, start button should create a new session
startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  let sessionName = prompt("Session name: ");
  if (!sessionName) {
    alert("Please enter a valid session name");
    startButton.disabled = false;
    return;
  }
  let sessionNumber = await getOrCreateSession(sessionName);
  if (!sessionNumber) {
    startButton.disabled = false;
  }
});

// Start up the editor and hook up the end session button.
function initialize({
  doc = null,
  docVersion = null,
  sessionNumber = null,
  exercises = [],
}) {
  startButton.disabled = true;
  endButton.disabled = false;
  sessionDetails.textContent = `Session: ${sessionNumber}`;

  let activitiesPanel = null; // forward reference; assigned after panel construction

  let codeEditor = new InstructorCodeEditor({
    node: codeContainer,
    socket,
    doc,
    startVersion: docVersion,
    sessionNumber,
    extraExtensions: fillInBlankExtensions(({ instructor_code, code_line_context_start, code_line_context_end, default_answer }) => {
      activitiesPanel?.createCodeExercise({ instructor_code, code_line_context_start, code_line_context_end, default_answer });
    }),
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

  activitiesPanel = new InstructorActivitiesPanel({
    sessionNumber,
    exercises,
    socket,
    activitiesPanel: document.querySelector("#activities-container"),
    openPanel: openActivitiesPanel,
    getInstructorCode: () => codeEditor.currentCode(),
  });
}
