import "./style.css";
import "./style-student-page.css";

import { getEmail, getUserID, POST_JSON_REQUEST } from "./utils.js";

import { io } from "socket.io-client";
import { CodeFollowingEditor, StudentCodeEditor } from "./code-editors.js";
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
const playgroundCodeContainer = document.querySelector(
  "#playground-code-container"
);
const instructorCodeTab = document.querySelector("#instructor-code-tab");
const playgroundCodeTab = document.querySelector("#playground-code-tab");
const runButtonEl = document.querySelector("#run-button");
const exerciseSubmitBtnEl = document.querySelector("#exercise-submit-btn");
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

// TODO: change the tabs system :)
const INSTRUCTOR_TAB = 0;
const PLAYGROUND_TAB = 1;

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
  playgroundCodeInfo = { doc: [''], docVersion: 0 }; // Clobber for now!

  let playgroundDoc = playgroundCodeInfo?.doc ?? null;
  let playgroundDocVersion = playgroundCodeInfo?.docVersion ?? 0;
  let sessionActive = true;

  let instructorEditor = new CodeFollowingEditor(
    instructorCodeContainer,
    lectureDoc,
    lectureDocVersion,
    socket,
    null, // no code snapshot/anchor functionality on this page
    sessionNumber
  );

  let playgroundEditor = new StudentCodeEditor({
    node: playgroundCodeContainer,
    doc: playgroundDoc,
    docVersion: playgroundDocVersion,
    sessionNumber,
    fileName: "playground.py",
    email,
    // flushUrl: "/record-playground-changes",
    flushUrl: null,  // Don't save playground changes for now.
    onNewSnapshot: null,
  });
  playgroundCodeContainer.style.display = "none";

  // Set up the run button for the playground tab.
  let codeRunner = new PythonCodeRunner();
  let consoleOutput = new Console(codeOutputsEl);
  new RunInteractions({
    runButtonEl,
    codeEditor: playgroundEditor,
    codeRunner,
    consoleOutput,
    sessionNumber,
    source: CLIENT_TYPE.NOTES,
    email,
  });
  socket.on(
    SOCKET_MESSAGE_TYPE.INSTRUCTOR_CODE_RUN,
    (msg) => sessionActive && consoleOutput.addResult(msg)
  );

  // Set up the tabs to work.
  let selectTab = (tab) => {
    if (instructorTabActive && tab === INSTRUCTOR_TAB) return;
    if (!instructorTabActive && tab === PLAYGROUND_TAB) return;

    instructorTabActive = !instructorTabActive;

    let [open, closed] = [instructorCodeTab, playgroundCodeTab];
    if (tab === PLAYGROUND_TAB) [open, closed] = [closed, open];
    open.classList.add("selected");
    closed.classList.remove("selected");

    [open, closed] = [instructorCodeContainer, playgroundCodeContainer];
    if (tab === PLAYGROUND_TAB) [open, closed] = [closed, open];
    open.style.display = "grid";
    closed.style.display = "none";

    let payload = {
      ts: Date.now(),
      codeVersion: playgroundEditor.getDocVersion(),
      actionType: USER_ACTIONS.SWITCH_TAB,
      sessionNumber,
      source: CLIENT_TYPE.NOTES,
      email,
      details: tab === INSTRUCTOR_TAB ? "instructor.py" : "playground.py",
    };
    fetch("/record-user-action", {
      body: JSON.stringify(payload),
      ...POST_JSON_REQUEST,
    });
  };
  instructorCodeTab.addEventListener("click", () => selectTab(INSTRUCTOR_TAB));
  playgroundCodeTab.addEventListener("click", () => selectTab(PLAYGROUND_TAB));

  [playgroundCodeTab, playgroundCodeContainer].forEach((el) =>
    el.addEventListener("animationend", () =>
      el.classList.remove("just-changed-tab")
    )
  );

  // If we're on the playground tab, blink the instructor tab whenever a change happens.
  socket.on(SOCKET_MESSAGE_TYPE.INSTRUCTOR_EDIT, (msg) => {
    if (!msg.changes) return;
    if (instructorCodeTab.classList.contains("selected")) return;
    instructorCodeTab.style.animation = "none";
    setTimeout(() => (instructorCodeTab.style.animation = ""), 10);
  });

  socket.on(SOCKET_MESSAGE_TYPE.INSTRUCTOR_END_SESSION, () => {
    console.log("SESSION IS ENDED!");
    playgroundEditor.endSession();
    instructorEditor.stopFollowing();
    sessionActive = false;
  });

  window.addEventListener("beforeunload", () => {
    playgroundEditor.flushChanges();
  });

  let currentForkExerciseId = null;

  function setupExerciseTab(instructorCode, exerciseId, existingCode) {
    currentForkExerciseId = exerciseId;
    playgroundCodeTab.style.display = "";
    playgroundCodeTab.querySelector(".code-tab-text").textContent = "exercise.py";
    playgroundEditor.replaceContents(existingCode ?? instructorCode ?? "");
    playgroundEditor.setBaseCode(instructorCode ?? "");
    exerciseSubmitBtnEl.style.display = "";
    exerciseSubmitBtnEl.textContent = existingCode ? "Resubmit" : "Submit";
    playgroundCodeContainer.classList.add("exercise-active");
    playgroundCodeTab.classList.add("exercise-tab-blink");
    selectTab(PLAYGROUND_TAB);
  }

  async function handleForkSubmit() {
    if (!currentForkExerciseId) return;
    let code = playgroundEditor.currentCode();
    let res = await fetch("/exercise/response", {
      body: JSON.stringify({ exerciseId: currentForkExerciseId, student_id: userId, answer: code }),
      ...POST_JSON_REQUEST,
    }).then((r) => r.json());
    if (res.error) {
      alert(res.error);
      return;
    }
    exerciseSubmitBtnEl.textContent = "Resubmit";
    activitiesPanel.onForkSubmitted(currentForkExerciseId, code);
    socket.emit(SOCKET_MESSAGE_TYPE.STUDENT_SUBMITTED, {
      sessionNumber,
      exerciseId: currentForkExerciseId,
      student_id: userId,
      student_identifier: email,
      answer: code,
    });
  }

  exerciseSubmitBtnEl.addEventListener("click", handleForkSubmit);

  function closeExerciseTab() {
    playgroundCodeTab.style.display = "none";
    exerciseSubmitBtnEl.style.display = "none";
    playgroundCodeContainer.classList.remove("exercise-active");
    playgroundCodeTab.classList.remove("exercise-tab-blink");
    currentForkExerciseId = null;
    playgroundEditor.setBaseCode(null);
    selectTab(INSTRUCTOR_TAB);
  }

  let activitiesPanel = new StudentActivitiesPanel({
    sessionNumber,
    exercises,
    student_id: userId,
    socket,
    openActivitiesPanel,
    studentIdentifier: email,
    showExerciseTab: setupExerciseTab,
    closeExerciseTab,
  });
}

setupJoinLectureModalV2({
  url: "/current-session-student",
  buildBody: (sessionName) => ({ student_id: userId, student_identifier: email, sessionName }),
  onSuccess: initialize,
});

