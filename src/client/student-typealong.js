import "./style.css";

import { io } from "socket.io-client";
import { getEmail, clearEmail, POST_JSON_REQUEST } from "./utils.js";

import { StudentCodeEditor } from "./code-editors.js";
import { PythonCodeRunner } from "./code-runner.js";
import { Text } from "@codemirror/state";
import {
  Console,
  makeConsoleResizable,
  RunInteractions,
  setUpChangeEmail,
  setupJoinLectureModal,
} from "./shared-interactions.js";
import {
  CLIENT_TYPE,
  SOCKET_MESSAGE_TYPE,
  USER_ACTIONS,
} from "../shared-constants.js";

const TAB_NAMES = ["notes.py", "notes2.py", "notes3.py"];
const codeContainers = ["", "2", "3"].map((n) =>
  document.querySelector(`#code-container${n}`)
);
const codeTabButtons = ["#tab1", "#tab2", "#tab3"].map((s) =>
  document.querySelector(s)
);
const addTabButton = document.querySelector("#add-tab");
let highestTabIdx = 0;
let curTab = 0;

const studentDetailsContainer = document.querySelector("#student-email");
const changeEmailLink = document.querySelector("#change-email");
const runButtonEl = document.querySelector("#run-button");
const outputCodeContainer = document.querySelector("#all-code-outputs");
const consoleResizer = document.querySelector("#resize-console");
const codeOutputsContainer = document.querySelector("#output-container");
makeConsoleResizable(codeOutputsContainer, consoleResizer);

const socket = io();

const email = getEmail();
studentDetailsContainer.textContent = email;
setUpChangeEmail(changeEmailLink);

// Wait to join a session.
async function initialize({ docs, sessionNumber, typealongSessionId }) {
  let currentTab = 0;
  let codeEditors = TAB_NAMES.map((fileName, idx) => {
    let { doc, docVersion } = docs[fileName] || {
      doc: Text.empty.toJSON(),
      docVersion: 0,
    };

    return new StudentCodeEditor({
      node: codeContainers[idx],
      doc,
      docVersion,
      sessionNumber,
      email,
      fileName,
      flushUrl: "/record-typealong-changes",
    });
  });

  let codeRunner = new PythonCodeRunner();
  let consoleOutput = new Console(outputCodeContainer);

  let runButtonInteractions = new RunInteractions({
    runButtonEl,
    codeEditor: codeEditors[currentTab],
    codeRunner,
    consoleOutput,
    sessionNumber,
    source: CLIENT_TYPE.TYPEALONG,
    email,
  });

  // A bunch of logic for handling the tabs.
  // It ain't pretty, but it works :) [probably]

  // Only present tabs should show up.
  if (docs[TAB_NAMES[1]]) {
    codeTabButtons[1].style.display = "";
    highestTabIdx = 1;
  }
  if (docs[TAB_NAMES[2]]) {
    codeTabButtons[1].style.display = ""; // Ensure tab[1] is present
    codeTabButtons[2].style.display = "";
    highestTabIdx = 2;
  }

  let switchToTab = (idx) => {
    if (idx === curTab) return;
    curTab = idx;

    runButtonInteractions.setEditor(codeEditors[idx]);
    codeContainers.forEach((el, i) => {
      el.style.display = i == idx ? "" : "none";
    });
    codeTabButtons.forEach((el, i) => {
      i === idx
        ? el.classList.add("selected")
        : el.classList.remove("selected");
    });

    let payload = {
      ts: Date.now(),
      actionType: USER_ACTIONS.SWITCH_TAB,
      sessionNumber,
      source: CLIENT_TYPE.TYPEALONG,
      email,
      details: TAB_NAMES[idx],
    };
    fetch("/record-user-action", {
      body: JSON.stringify(payload),
      ...POST_JSON_REQUEST,
    });
  };

  codeTabButtons.forEach((el, idx) => {
    el.addEventListener("click", () => switchToTab(idx));
  });

  if (highestTabIdx == 2) {
    addTabButton.style.display = "none";
  } else {
    addTabButton.addEventListener("click", () => {
      // Just need to show the newest tab.
      // Actually, should switch to that tab, too.
      highestTabIdx++;
      codeTabButtons[highestTabIdx].style.display = "";
      switchToTab(highestTabIdx);
      if (highestTabIdx == 2) {
        addTabButton.style.display = "none";
      }
    });
  }

  socket.on(SOCKET_MESSAGE_TYPE.INSTRUCTOR_END_SESSION, () => {
    console.log("SESSION IS ENDED!");
    codeEditors.forEach((editor) => editor.endSession());
  });

  window.addEventListener("beforeunload", (event) => {
    codeEditors.forEach((editor) => editor.flushChanges());
  });
}

setupJoinLectureModal({
  url: "/current-session-typealong",
  email,
  onSuccess: initialize,
});
