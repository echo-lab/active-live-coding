import "./style.css";
import "./style-student-page.css";

import { getEmail, getUserID, POST_JSON_REQUEST } from "./utils.js";

import { io } from "socket.io-client";
import { CodeFollowingEditor, StudentCodeEditor } from "./code-editors.js";
import { fillInBlankViewField } from "./cm-fill-in-the-blank.js";
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
  USER_ACTIONS,
} from "../shared-constants.js";
import { StudentActivitiesPanel } from "./activities-panel.js";

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
  /*minActivitiesWidth=*/ 300
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
}) {

  let sessionActive = true;

  let instructorEditor = new CodeFollowingEditor(
    instructorCodeContainer,
    lectureDoc,
    lectureDocVersion,
    socket,
    sessionNumber,
    [fillInBlankViewField]
  );

  // Set up the run button for when we need it...
  let codeRunner = new PythonCodeRunner();
  let consoleOutput = new Console(codeOutputsEl);
  const fitbOnRun = async (code) => {
    const res = await codeRunner.asyncRun(code);
    consoleOutput.addResult({ fileName: "<exercise>", ...res });
  };
  socket.on(
    SOCKET_MESSAGE_TYPE.INSTRUCTOR_CODE_RUN,
    (msg) => sessionActive && consoleOutput.addResult(msg)
  );

  socket.on(SOCKET_MESSAGE_TYPE.INSTRUCTOR_END_SESSION, () => {
    console.log("SESSION IS ENDED!");
    // playgroundEditor.endSession();
    instructorEditor.stopFollowing();
    sessionActive = false;
  });

  let activitiesPanel = new StudentActivitiesPanel({
    sessionNumber,
    exercises,
    student_id: userId,
    socket,
    openActivitiesPanel,
    studentIdentifier: email,
    showFillInBlank: (ex, currentAnswer, onSubmit) => instructorEditor.activateFillInBlank(ex, currentAnswer, onSubmit, fitbOnRun),
    hideFillInBlank: () => instructorEditor.deactivateFillInBlank(),
  });
}

setupJoinLectureModalV2({
  url: "/current-session-student",
  buildBody: (sessionName) => ({ student_id: userId, student_identifier: email, sessionName }),
  onSuccess: initialize,
});

