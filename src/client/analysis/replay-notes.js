import "../style.css";
import "../style-notes.css";
import "../style-replay.css";

import { ReviewCodeEditor } from "../code-editors.js";
import { PythonCodeRunner } from "../code-runner.js";
import { Text } from "@codemirror/state";
import {
  Console,
  makeConsoleResizable,
  RunInteractions,
} from "../shared-interactions.js";
import { CLIENT_TYPE } from "../../shared-constants.js";
import { NotesEditor } from "../notes-editor.js";
import { GET_JSON_REQUEST } from "../utils.js";
import { setupTimeline } from "./timeline.js";

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

const NOTES_CONTAINER_ID = "#notes-document";
const notesContainer = document.querySelector(NOTES_CONTAINER_ID);

// Handle the email stuff.
const studentDetailsContainer = document.querySelector("#student-email");
// studentDetailsContainer.textContent = email;

const INSTRUCTOR_TAB = "instructor.py";
const PLAYGROUND_TAB = "playground.py";

async function initialize({ sessionNumber, email, actions, changes }) {
  studentDetailsContainer.textContent = email;

  let notesEditor = new NotesEditor({
    nodeId: NOTES_CONTAINER_ID,
    deltas: [],
    sessionNumber,
    email,
    readOnly: true,
  });

  let instructorEditor = new ReviewCodeEditor({
    node: instructorCodeContainer,
    doc: Text.empty.toJSON(),
    isEditable: false,
  });

  let playgroundEditor = new ReviewCodeEditor({
    node: playgroundCodeContainer,
    doc: Text.empty.toJSON(),
    isEditable: false,
  });

  playgroundCodeContainer.style.display = "none"; // Not sure why we have to do this again...

  // Set up the run button for the playground tab.
  let codeRunner = new PythonCodeRunner();
  let consoleOutput = new Console(codeOutputsEl);
  let runInteractions = new RunInteractions({
    runButtonEl,
    codeEditor: playgroundEditor,
    codeRunner,
    consoleOutput,
    sessionNumber,
    logRuns: false,
    source: CLIENT_TYPE.NOTES,
    email,
  });
  // runInteractions.setEditor(playgroundEditor);

  // Set up the tabs to work.
  let selectTab = (tab) => {
    let [open, closed] = [instructorCodeTab, playgroundCodeTab];
    if (tab === PLAYGROUND_TAB) [open, closed] = [closed, open];
    open.classList.add("selected");
    closed.classList.remove("selected");

    [open, closed] = [instructorCodeContainer, playgroundCodeContainer];
    if (tab === PLAYGROUND_TAB) [open, closed] = [closed, open];
    open.style.display = "grid";
    closed.style.display = "none";
  };

  instructorCodeTab.addEventListener("click", () => selectTab(INSTRUCTOR_TAB));
  playgroundCodeTab.addEventListener("click", () => selectTab(PLAYGROUND_TAB));

  // If you click "Open in playground" it should switch to the playground tab and flash.
  [playgroundCodeTab, playgroundCodeContainer].forEach((el) =>
    el.addEventListener("animationend", () =>
      el.classList.remove("just-changed-tab")
    )
  );

  let codeEditors = {
    ["playground.py"]: playgroundEditor,
    ["instructor.py"]: instructorEditor,
  };

  // TODO: setupTimeline()
  setupTimeline({
    actions,
    changes,
    codeEditors,
    initialTab: "instructor.py",
    notesEditor,
    switchTabFn: selectTab,
  });
}

async function fetchData() {
  const urlParams = new URLSearchParams(window.location.search);
  const id = urlParams.get("id");

  let url = `/notes-session-events?${new URLSearchParams({ id })}`;
  let response = await fetch(url, GET_JSON_REQUEST);
  let res = await response.json();
  console.log(res);
  initialize(res);
}

fetchData();
