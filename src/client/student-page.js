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

const instructorCodeContainer = document.querySelector(
  "#instructor-code-container"
);
const playgroundCodeContainer = document.querySelector(
  "#playground-code-container"
);
const instructorCodeTab = document.querySelector("#instructor-code-tab");
const playgroundCodeTab = document.querySelector("#playground-code-tab");
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

// TODO: change the tabs system :)
const INSTRUCTOR_TAB = 0;
const PLAYGROUND_TAB = 1;

// TODO: move this to a new file?
class StudentActivitiesPanel {
  constructor({ sessionNumber, exercises, student_id, socket }) {
    console.log("EXERCISES:", exercises);
    this.sessionNumber = sessionNumber;
    this.exercises = exercises.map((ex) => ({
      ...ex,
      ExerciseResponses: ex.ExerciseResponses ?? [],
    }));
    this.student_id = student_id;
    this.socket = socket;
    this.currentExerciseId = null;

    // DOM refs
    this.listEl = document.querySelector("#student-activities-list");
    this.listItemsEl = document.querySelector("#student-activities-list-items");
    this.placeholderEl = document.querySelector("#student-activities-placeholder");
    this.exerciseEl = document.querySelector("#student-activity");
    this.instructionsEl = document.querySelector("#student-activity-instructions");
    this.answerDisplayEl = document.querySelector("#student-answer-display");
    this.answerInputEl = document.querySelector("#student-answer-input");
    this.submitBtn = document.querySelector("#student-submit-btn");

    document.querySelector("#student-activity-back").addEventListener("click", () => this._showList());
    this.submitBtn.addEventListener("click", () => this._submitAnswer());

    socket.on(SOCKET_MESSAGE_TYPE.EXERCISE_CREATED, (msg) => {
      if (msg.sessionNumber !== sessionNumber) return;
      let ex = { ...msg.exercise, end_ts: null, ExerciseResponses: [] };
      this.exercises.push(ex);
      this._renderList();
      openActivitiesPanel();
      this._showExercise(ex);
    });

    socket.on(SOCKET_MESSAGE_TYPE.EXERCISE_FINISHED, (msg) => {
      if (msg.sessionNumber !== sessionNumber) return;
      let ex = this.exercises.find((e) => e.id === msg.exerciseId);
      if (ex) ex.end_ts = Date.now();
      if (this.currentExerciseId === msg.exerciseId) {
        this.submitBtn.hidden = true;
        this.answerInputEl.hidden = true;
      }
      this._renderList();
    });

    // If there's an active exercise on load, open it
    let active = this.exercises.find((ex) => ex.end_ts == null);
    if (active) {
      openActivitiesPanel();
      this._showExercise(active);
    } else {
      this._showList();
    }
    this._renderList();
  }

  _showList() {
    this.currentExerciseId = null;
    this.exerciseEl.hidden = true;
    this.listEl.hidden = false;
  }

  _renderList() {
    this.listItemsEl.innerHTML = "";
    let hasItems = this.exercises.length > 0;
    this.placeholderEl.hidden = hasItems;
    [...this.exercises].reverse().forEach((ex) => {
      let myResponse = ex.ExerciseResponses.find((r) => r.student_id === this.student_id);
      let isActive = ex.end_ts == null;
      let item = document.createElement("div");
      item.className = "activity-list-item";
      let badge = isActive ? "Active" : "Done";
      let preview = ex.instructions ? ex.instructions.slice(0, 60) : "(no instructions)";
      let answerSnippet = myResponse ? ` — "${myResponse.answer.slice(0, 30)}"` : " — no answer";
      item.innerHTML = `<span class="activity-item-preview">${preview}</span><span class="activity-item-badge ${isActive ? "badge-active" : "badge-done"}">${badge}</span><span class="activity-item-answer">${answerSnippet}</span>`;
      item.addEventListener("click", () => this._showExercise(ex));
      this.listItemsEl.appendChild(item);
    });
  }

  _showExercise(ex) {
    this.currentExerciseId = ex.id;
    let myResponse = ex.ExerciseResponses.find((r) => r.student_id === this.student_id);
    let isActive = ex.end_ts == null;

    this.instructionsEl.textContent = ex.instructions ?? "";

    if (myResponse) {
      this.answerDisplayEl.textContent = `Your answer: ${myResponse.answer}`;
      this.answerDisplayEl.hidden = false;
      this.answerInputEl.value = myResponse.answer;
    } else {
      this.answerDisplayEl.hidden = true;
      this.answerInputEl.value = "";
    }

    this.answerInputEl.hidden = !isActive;
    this.submitBtn.hidden = !isActive;
    this.submitBtn.textContent = myResponse ? "Resubmit" : "Submit";

    this.listEl.hidden = true;
    this.exerciseEl.hidden = false;
  }

  async _submitAnswer() {
    let answer = this.answerInputEl.value.trim();
    if (!answer) return;
    let exerciseId = this.currentExerciseId;
    let res = await fetch("/exercise/response", {
      body: JSON.stringify({ exerciseId, student_id: this.student_id, answer }),
      ...POST_JSON_REQUEST,
    }).then((r) => r.json());
    if (res.error) { alert(res.error); return; }

    let ex = this.exercises.find((e) => e.id === exerciseId);
    if (ex) {
      let idx = ex.ExerciseResponses.findIndex((r) => r.student_id === this.student_id);
      if (idx >= 0) {
        ex.ExerciseResponses[idx].answer = answer;
      } else {
        ex.ExerciseResponses.push({ student_id: this.student_id, answer });
      }
    }

    this.answerDisplayEl.textContent = `Your answer: ${answer}`;
    this.answerDisplayEl.hidden = false;
    this.submitBtn.textContent = "Resubmit";
    this._renderList();

    this.socket.emit(SOCKET_MESSAGE_TYPE.STUDENT_SUBMITTED, {
      sessionNumber: this.sessionNumber,
      exerciseId,
      student_id: this.student_id,
      student_identifier: email,
      answer,
    });
  }
}

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
  playgroundCodeInfo = {doc: [''], docVersion: 0}; // Clobber for now!

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

  new StudentActivitiesPanel({
    sessionNumber,
    exercises,
    student_id: userId,
    socket,
  });
}

setupJoinLectureModalV2({
  url: "/current-session-student",
  buildBody: (sessionName) => ({ student_id: userId, student_identifier: email, sessionName }),
  onSuccess: initialize,
});

