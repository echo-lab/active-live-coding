import "./style.css";
import "./style-quiz.css";

import { getEmail, POST_JSON_REQUEST } from "./utils.js";

import { StudentCodeEditor } from "./code-editors.js";
import { Text } from "@codemirror/state";
import { setUpChangeEmail, setupJoinQuizModal } from "./shared-interactions.js";
import {
  CLIENT_TYPE,
  SOCKET_MESSAGE_TYPE,
  USER_ACTIONS,
} from "../shared-constants.js";

const codeContainer = document.querySelector("#code-container");
const studentDetailsContainer = document.querySelector("#student-email");
const changeEmailLink = document.querySelector("#change-email");
const submitButtonEl = document.querySelector("#submit-button");

const HOME_QUIZ_NAMES = [
  "home-gen-1",
  "home-gen-2",
  "home-deco-1",
  "home-deco-2",
];

const email = getEmail();
studentDetailsContainer.textContent = email;
setUpChangeEmail(changeEmailLink);

function recordUserAction({ actionType, sessionNumber, email, sessionName }) {
  let payload = {
    ts: Date.now(),
    actionType,
    sessionNumber,
    source: CLIENT_TYPE.QUIZ,
    email,
    details: sessionName,
  };
  fetch("/record-user-action", {
    body: JSON.stringify(payload),
    ...POST_JSON_REQUEST,
  });
}

// Wait to join a session.
async function initialize({
  docs,
  sessionNumber,
  typealongSessionId,
  sessionName,
}) {
  let { doc, docVersion } = docs["notes.py"] || {
    doc: Text.empty.toJSON(),
    docVersion: 0,
  };

  let codeEditor = new StudentCodeEditor({
    node: codeContainer,
    doc,
    docVersion,
    sessionNumber,
    email,
    fileName: "notes.py",
    flushUrl: "/record-typealong-changes",
  });

  // If this is the firsttime loading an at-home quiz, then make sure we include the problem statement :)
  if (!docs["notes.py"] && HOME_QUIZ_NAMES.includes(sessionName)) {
    codeEditor.replaceContents(QUIZ_TO_COMMENT[sessionName]);
  }

  submitButtonEl.addEventListener("click", () => {
    let modalContainer = document.querySelector(".modal-background");
    let modal = document.querySelector(".modal");
    console.log("SUBMITTING");

    // Change the modal message based on which quiz we're doing.
    if (HOME_QUIZ_NAMES.includes(sessionName)) {
      console.log("HERE");
      let res = `<div>
      Response recorded! Please copy your code back into the google form:
      <pre style="border:solid 1px black;padding:5px">${codeEditor.currentCode()}</pre>
      </div>
      `;
      modal.style.width = "auto";
      modal.innerHTML = res;
    } else {
      let url =
        sessionName == "genquiz"
          ? "https://forms.gle/j13dxnQqYe98oGQ97"
          : "https://forms.gle/zJDUVdGyufQYsMuS8";
      modal.innerHTML = `<div style="text-align:center">
    Response recorded!<br/>
    Please continue to part 2 at <a href="${url}">this link.</a> 
    </div>`;
    }
    modalContainer.style.display = "";
    recordUserAction({
      actionType: USER_ACTIONS.SUBMIT_CODE,
      sessionNumber,
      email,
      sessionName,
    });
  });

  window.addEventListener("beforeunload", (event) => {
    codeEditor.flushChanges();
  });

  recordUserAction({
    actionType: USER_ACTIONS.LOAD_PAGE,
    sessionNumber,
    email,
    sessionName,
  });
}

setupJoinQuizModal({
  url: "/current-session-typealong",
  email,
  onSuccess: initialize,
});

const HOME_DECO_1 = `# Write a decorator called 'print_time' which alters a function by
# printing out how many seconds it took to run each time the function
# is called. Your decorator only needs to work for functions with no arguments.
# 
# HINT: you can get the current time by using: time.time()

# Example Usage:
@print_time
def f():
    y = 0
    for x in range(100000000):
        y += 1

f() # might print "5.491" indicating ~5.5 seconds

# YOUR CODE HERE:


`;

const HOME_DECO_2 = `# Define a decorator called 'question(n)' which takes a parameter (n)
# and adds n question-marks to the result of a function. It only needs
# to work on functions that take no arguments and return strings.

# Example Usage:
@question(3)
def hi():
    return "hi"

print(hi()) # prints: "hi???"
  
# YOUR CODE HERE: 


`;

const HOME_GEN_1 = `# Write a generator count_by_two(n) which produces the
# infinite sequence of numbers {n, n+2, n+4, ...}

# Example usage:
g = count_by_two(5)
print(next(g))  # prints "5"
print(next(g))  # prints "7"
print(next(g))  # prints "9"

# YOUR CODE HERE:
`;

const HOME_GEN_2 = `# Write a generator cycle(n) which generates the infinite sequence {0, 1, ..., n-1, 0, 1, ... }
# For example, cycle(3) should produce the sequence {0, 1, 2, 0, 1, 2, 0, 1, 2, ... }.
# For full points, use both the 'yield from' statement and the 'range' function in your answer.

# Example usage:
c4 = cycle(4)
for x in range(5):
    print(next(c4))
# Should print: "0", "1", "2", "3", "0"


# YOUR CODE HERE:

`;

const QUIZ_TO_COMMENT = {
  ["home-gen-1"]: HOME_GEN_1,
  ["home-gen-2"]: HOME_GEN_2,
  ["home-deco-1"]: HOME_DECO_1,
  ["home-deco-2"]: HOME_DECO_2,
};
