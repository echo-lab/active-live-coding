import "./style.css";
import "./style-student-page.css";

import { getEmail, getUserID, POST_JSON_REQUEST } from "./utils.js";

import { io } from "socket.io-client";
import { StudentCodeEditor } from "./code-editors.js";
import { fillInBlankViewField } from "./cm-fill-in-the-blank.js";
import {
  versionBlocksField,
  setVersionBlockReadOnly,
} from "./cm-version-widget.js";
import { PythonCodeRunner } from "./code-runner.js";
import {
  Console,
  makeActivitiesPanelResizable,
  makeConsoleResizable,
  RunInteractions,
  setUpChangeEmail,
  setupJoinLectureModalV2,
} from "./shared-interactions.js";
import {
  CLIENT_TYPE,
  SOCKET_MESSAGE_TYPE,
} from "../shared-constants.js";
import { StudentActivitiesPanel } from "./activities-panel.js";
import { StudentActivitiesManager } from "./activities-manager.js";

const instructorCodeContainer = document.querySelector(
  "#instructor-code-container"
);
const instructorCodeTab = document.querySelector("#instructor-code-tab");
const runButtonEl = document.querySelector("#run-button");
const codeOutputsEl = document.querySelector("#all-code-outputs");
const codeOutputsContainer = document.querySelector("#output-container");
const consoleResizer = document.querySelector("#resize-console");
makeConsoleResizable(codeOutputsContainer, consoleResizer, true);
let instructorTabActive = true;

const activitiesResizer = document.querySelector("#resize-activities");
const activitiesContainer = document.querySelector("#activities-container");
const toggleActivitiesBtn = document.querySelector("#toggle-activities-panel");
const { openPanel: openActivitiesPanel } = makeActivitiesPanelResizable(
  document.querySelector(".parent-container"),
  activitiesResizer,
  activitiesContainer,
  toggleActivitiesBtn,
  /*gutterWidth=*/ 12,
  /*minCodeWidth=*/ 400,
  /*minActivitiesWidth=*/ 300,
  /*initiallyCollapsed*/true
);

// Handle the email stuff.
const email = getEmail();
const userId = getUserID();
const studentDetailsContainer = document.querySelector("#student-email");
const changeEmailLink = document.querySelector("#change-email");
studentDetailsContainer.textContent = email;
setUpChangeEmail(changeEmailLink);

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
  let consoleOutput = new Console(codeOutputsEl);
  const fitbOnRun = async (code) => {
    const res = await codeRunner.asyncRun(code);
    consoleOutput.addResult({ fileName: "<exercise>", ...res });
  };

  let runInteractions = new RunInteractions({
    runButtonEl,
    codeEditor,
    codeRunner,
    consoleOutput,
    sessionNumber,
    source: CLIENT_TYPE.STUDENT,
    userId,
  });

  function syncRunButtonVisibility() {
    runButtonEl.hidden = !activitiesManager.getActiveExercises()
      .some((ex) => ex.type === "CODE_VARIANT");
  }
  syncRunButtonVisibility();
  activitiesManager.addEventListener("exerciseCreated", syncRunButtonVisibility);
  activitiesManager.addEventListener("exerciseFinished", syncRunButtonVisibility);

  socket.on(
    SOCKET_MESSAGE_TYPE.INSTRUCTOR_CODE_RUN,
    (msg) => sessionActive && consoleOutput.addResult(msg)
  );

  socket.on(SOCKET_MESSAGE_TYPE.INSTRUCTOR_END_SESSION, () => {
    console.log("SESSION IS ENDED!");
    codeEditor.stopFollowing();
    sessionActive = false;
  });

  activitiesPanel = new StudentActivitiesPanel(activitiesManager, {
    student_id: userId,
    openActivitiesPanel,
    onPollPanelOpenChange: (id) => codeEditor.setPollHighlightOpen(id),
  });
}

setupJoinLectureModalV2({
  url: "/current-session-student",
  buildBody: (sessionName) => ({ student_id: userId, student_identifier: email, sessionName }),
  onSuccess: initialize,
});

