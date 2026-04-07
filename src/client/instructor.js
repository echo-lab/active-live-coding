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

class InstructorActivitiesPanel {
  constructor({ sessionNumber, exercises, socket, activitiesPanel, openPanel }) {
    console.log("Exercises: ", exercises);
    this.sessionNumber = sessionNumber;
    this.exercises = exercises.map((ex) => ({
      ...ex,
      ExerciseResponses: ex.ExerciseResponses ?? [],
    }));
    this.socket = socket;
    this.activitiesPanel = activitiesPanel;
    this.openPanel = openPanel;
    this.activeExerciseId = null;
    this.timerInterval = null;

    // DOM refs
    this.listEl = document.querySelector("#activities-list");
    this.listItemsEl = document.querySelector("#activities-list-items");
    this.createEl = document.querySelector("#activities-create");
    this.activeEl = document.querySelector("#activities-active");
    this.summaryEl = document.querySelector("#activities-summary");
    this.pollButton = document.querySelector("#poll-button");

    document.querySelector("#activities-back").addEventListener("click", () => this._showView("list"));
    document.querySelector("#activities-active-back").addEventListener("click", () => this._showView("list"));
    document.querySelector("#activities-summary-back").addEventListener("click", () => this._showView("list"));
    document.querySelector("#activity-submit-create").addEventListener("click", () => this._createExercise());
    document.querySelector("#activity-finish").addEventListener("click", () => this._finishExercise());
    this.pollButton.addEventListener("click", () => {
      this.openPanel();
      this._showView("create");
      document.querySelector("#activity-instructions").value = "";
    });

    socket.on(SOCKET_MESSAGE_TYPE.STUDENT_SUBMITTED, (msg) => {
      if (msg.sessionNumber !== sessionNumber) return;
      if (msg.exerciseId !== this.activeExerciseId) return;
      let ex = this.exercises.find((e) => e.id === msg.exerciseId);
      if (ex) {
        // Update or add response in local list
        let idx = ex.ExerciseResponses.findIndex((r) => r.student_id === msg.student_id);
        if (idx >= 0) {
          ex.ExerciseResponses[idx].answer = msg.answer;
        } else {
          ex.ExerciseResponses.push({ student_id: msg.student_id, student_identifier: msg.student_identifier, answer: msg.answer });
        }
      }
      const countEl = document.querySelector("#activity-response-count");
      let count = ex ? ex.ExerciseResponses.length : 0;
      countEl.textContent = `${count} response${count !== 1 ? "s" : ""}`;
    });

    // Check for any already-active exercise on load
    let active = this.exercises.find((ex) => ex.end_ts == null);
    if (active) {
      this.activeExerciseId = active.id;
      this.openPanel();
      this._showActiveView(active);
    } else {
      this._showView("list");
    }
    this._renderList();
  }

  _showView(name) {
    console.log("CHANGING TO: ", name);
    this.listEl.hidden = name !== "list";
    this.createEl.hidden = name !== "create";
    this.activeEl.hidden = name !== "active";
    this.summaryEl.hidden = name !== "summary";
    this.activitiesPanel.classList.toggle("has-content", true);
  }

  _renderList() {
    this.listItemsEl.innerHTML = "";
    [...this.exercises].reverse().forEach((ex) => {
      let item = document.createElement("div");
      item.className = "activity-list-item";
      let isActive = ex.end_ts == null;
      let badge = isActive ? "Active" : "Done";
      let preview = ex.instructions ? ex.instructions.slice(0, 60) : "(no instructions)";
      item.innerHTML = `<span class="activity-item-preview">${preview}</span><span class="activity-item-badge ${isActive ? "badge-active" : "badge-done"}">${badge}</span>`;
      item.addEventListener("click", () => {
        if (isActive) {
          this._showActiveView(ex);
        } else {
          this._showSummaryView(ex);
        }
      });
      this.listItemsEl.appendChild(item);
    });
  }

  _showActiveView(ex) {
    document.querySelector("#activity-active-instructions").textContent = ex.instructions ?? "";
    let count = ex.ExerciseResponses.length;
    document.querySelector("#activity-response-count").textContent = `${count} response${count !== 1 ? "s" : ""}`;
    this._showView("active");
    this._startTimer(ex.start_ts);
  }

  _showSummaryView(ex) {
    document.querySelector("#activity-summary-instructions").textContent = ex.instructions ?? "";
    let responsesEl = document.querySelector("#activity-summary-responses");
    responsesEl.innerHTML = "";
    if (ex.ExerciseResponses.length === 0) {
      responsesEl.textContent = "No responses.";
    } else {
      ex.ExerciseResponses.forEach(({ student_id, student_identifier, StudentSession, answer }) => {
        let displayName = StudentSession?.student_identifier ?? student_identifier ?? student_id;
        let div = document.createElement("div");
        div.className = "summary-response";
        div.innerHTML = `<span class="summary-student">${displayName}</span><pre class="summary-answer">${answer}</pre>`;
        responsesEl.appendChild(div);
      });
    }
    this._showView("summary");
  }

  _startTimer(startTs) {
    if (this.timerInterval) clearInterval(this.timerInterval);
    const update = () => {
      let elapsed = Math.floor((Date.now() - startTs) / 1000);
      let m = Math.floor(elapsed / 60);
      let s = elapsed % 60;
      document.querySelector("#activity-timer").textContent = `${m}:${String(s).padStart(2, "0")}`;
    };
    update();
    this.timerInterval = setInterval(update, 1000);
  }

  async _createExercise() {
    let instructions = document.querySelector("#activity-instructions").value.trim();
    let res = await fetch("/exercise", {
      body: JSON.stringify({ lectureId: this.sessionNumber, type: "POLL", instructions }),
      ...POST_JSON_REQUEST,
    }).then((r) => r.json());
    if (res.error) { alert(res.error); return; }

    let newEx = { id: res.exerciseId, type: "POLL", instructions, start_ts: Date.now(), end_ts: null, ExerciseResponses: [] };
    this.exercises.push(newEx);
    this.activeExerciseId = newEx.id;
    this._renderList();
    this.socket.emit(SOCKET_MESSAGE_TYPE.EXERCISE_CREATED, {
      sessionNumber: this.sessionNumber,
      exercise: { id: newEx.id, instructions: newEx.instructions, start_ts: newEx.start_ts, type: newEx.type },
    });
    this._showActiveView(newEx);
  }

  async _finishExercise() {
    let ex = this.exercises.find((e) => e.id === this.activeExerciseId);
    if (!ex) return;
    let res = await fetch("/exercise/finish", {
      body: JSON.stringify({ exerciseId: ex.id }),
      ...POST_JSON_REQUEST,
    }).then((r) => r.json());
    if (res.error) { alert(res.error); return; }

    ex.end_ts = Date.now();
    this.activeExerciseId = null;
    clearInterval(this.timerInterval);
    this.timerInterval = null;
    this.socket.emit(SOCKET_MESSAGE_TYPE.EXERCISE_FINISHED, {
      sessionNumber: this.sessionNumber,
      exerciseId: ex.id,
    });
    this._renderList();
    this._showSummaryView(ex);
  }
}

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
  document.querySelector(
    "#session-name-display"
  ).innerText = `Lecture ID: ${sessionName}`;
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
function initialize({ doc = null, docVersion = null, sessionNumber = null, exercises = [] }) {
  startButton.disabled = true;
  endButton.disabled = false;
  sessionDetails.textContent = `Session: ${sessionNumber}`;

  let codeEditor = new InstructorCodeEditor({
    node: codeContainer,
    socket,
    doc,
    startVersion: docVersion,
    sessionNumber,
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
    }
  );

  new InstructorActivitiesPanel({
    sessionNumber,
    exercises,
    socket,
    activitiesPanel: document.querySelector("#activities-container"),
    openPanel: openActivitiesPanel,
  });
}
