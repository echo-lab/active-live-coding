import { ANONYMOUS_STUDENT_MODE, SOCKET_MESSAGE_TYPE } from "../shared-constants.js";

export const JSON_HEADERS = { "Content-Type": "application/json" };
export const GET_JSON_REQUEST = { method: "GET", headers: JSON_HEADERS };
export const POST_JSON_REQUEST = { method: "POST", headers: JSON_HEADERS };
export const PATCH_JSON_REQUEST = { method: "PATCH", headers: JSON_HEADERS };
export const PUT_JSON_REQUEST = { method: "PUT", headers: JSON_HEADERS };

export function getEmail() {
  if (ANONYMOUS_STUDENT_MODE) return null;
  let email = localStorage.getItem("user_email");
  if (email && email !== "null") return email;
  email = prompt("Please enter your email");
  localStorage.setItem("user_email", email);
  return email;
}

export function clearEmail() {
  localStorage.removeItem("user_email");
}

export function getUserID() {
  let userId = localStorage.getItem("user_id");
  if (userId) return userId;
  userId = crypto.randomUUID();
  localStorage.setItem("user_id", userId);
  return userId;
}

// Stand-in for a socket.io connection, for classes (StudentCodeEditor, StudentActivitiesManager)
// that unconditionally wire up socket.on(...) listeners but are used in a context with no live
// connection, e.g. the static review-lecture page.
export function createNoopSocket() {
  return { on() {}, off() {}, emit() {} };
}

// Joins this socket to the lecture's broadcast room, and keeps it there across reconnects.
//
// A short blip (wifi drop, laptop sleep < 2 min) is handled entirely by Socket.IO's connection
// state recovery (enabled server-side in main.js): the socket comes back with its rooms intact and
// every broadcast it missed is replayed in order, so `socket.recovered` is true and nothing else is
// needed. If recovery wasn't possible (longer outage, server restart), the socket is a brand-new
// one: we re-join the room so live updates resume, but anything sent during the gap (new
// exercises, version blocks, files, ...) was missed -- so we ask the user to reload. We don't
// reload for them: a student could be mid-way through typing an answer.
export function joinLectureRoom(socket, sessionNumber) {
  socket.emit(SOCKET_MESSAGE_TYPE.JOIN_SESSION, sessionNumber);
  if (socket.__lectureRoomJoined) return; // initialize() called twice -- don't stack handlers
  socket.__lectureRoomJoined = true;

  let wasDisconnected = false;
  socket.on("disconnect", () => {
    wasDisconnected = true;
  });
  socket.on("connect", () => {
    socket.emit(SOCKET_MESSAGE_TYPE.JOIN_SESSION, sessionNumber);
    if (wasDisconnected && !socket.recovered) showReconnectedBanner();
    wasDisconnected = false;
  });
}

function showReconnectedBanner() {
  if (document.querySelector(".reconnected-banner")) return;
  const banner = document.createElement("div");
  banner.className = "reconnected-banner";
  banner.setAttribute("role", "alert");
  const text = document.createElement("span");
  text.textContent = "Your connection was interrupted, so you may have missed some updates.";
  const reload = document.createElement("button");
  reload.textContent = "Reload to catch up";
  reload.addEventListener("click", () => location.reload());
  const dismiss = document.createElement("button");
  dismiss.className = "reconnected-banner-dismiss";
  dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", () => banner.remove());
  banner.append(text, reload, dismiss);
  document.body.append(banner);
}

// MARK: Rejoin after reload
// "?lecture=<name>" makes the instructor/student page join that lecture on load, skipping the
// join modal -- so the Reload button on a locked tab drops you straight back into the lecture.
const LECTURE_URL_PARAM = "lecture";

// Reloads this page, rejoining `sessionName` (the name typed into the join modal) automatically.
export function reloadIntoLecture(sessionName) {
  if (!sessionName) return location.reload();
  const url = new URL(location.href);
  url.searchParams.set(LECTURE_URL_PARAM, sessionName);
  location.replace(url);
}

// Returns the lecture name from "?lecture=" (or null), and strips it from the address bar so it
// doesn't linger in bookmarks/copied links or re-trigger on a later manual refresh.
export function takeLectureFromUrl() {
  const url = new URL(location.href);
  const name = url.searchParams.get(LECTURE_URL_PARAM)?.trim();
  if (url.searchParams.has(LECTURE_URL_PARAM)) {
    url.searchParams.delete(LECTURE_URL_PARAM);
    history.replaceState(history.state, "", url);
  }
  return name || null;
}

// Blocks the whole page with a non-dismissable notice + Reload button. Used when this tab must stop
// interacting -- e.g. it's a stale duplicate of a lecture being edited in another tab/window. The
// caller is responsible for actually making the page read-only; this is just the notice (which
// also swallows clicks/keys aimed at the page underneath). Idempotent. Pass `sessionName` so Reload
// rejoins that lecture automatically.
export function showStaleTabOverlay({ title, message, sessionName = null }) {
  if (document.querySelector(".stale-tab-overlay")) return;
  document.querySelector(".reconnected-banner")?.remove(); // superseded
  const overlay = document.createElement("div");
  overlay.className = "stale-tab-overlay";
  const dialog = document.createElement("div");
  dialog.className = "stale-tab-dialog";
  dialog.setAttribute("role", "alertdialog");
  dialog.setAttribute("aria-modal", "true");
  const heading = document.createElement("h2");
  heading.textContent = title;
  const text = document.createElement("p");
  text.textContent = message;
  const reload = document.createElement("button");
  reload.textContent = "Reload";
  reload.addEventListener("click", () => reloadIntoLecture(sessionName));
  dialog.append(heading, text, reload);
  overlay.append(dialog);
  document.body.append(overlay);
  // Pull focus out of any editor so keystrokes can't land there.
  document.activeElement?.blur?.();
  reload.focus();
}

// Returns true/false once the student has answered the consent form, or null
// if they haven't been asked yet (or their answer hasn't been recorded).
export function getConsentChoice() {
  let val = localStorage.getItem("consent_choice");
  if (val === "true") return true;
  if (val === "false") return false;
  return null;
}

export function setConsentChoice(consented) {
  localStorage.setItem("consent_choice", String(consented));
}

const SURVEY_RESPONSE_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8 hours

// Returns the student's last-submitted survey answers, or null if they
// haven't submitted the survey yet (or it's more than 8 hours old).
export function getSurveyResponse() {
  const val = localStorage.getItem("survey_response");
  if (!val) return null;
  let timestamp, answers;
  try {
    ({ timestamp, answers } = JSON.parse(val));
  } catch {
    return null;
  }
  if (Date.now() - timestamp > SURVEY_RESPONSE_MAX_AGE_MS) return null;
  return answers;
}

export function setSurveyResponse(answers) {
  localStorage.setItem(
    "survey_response",
    JSON.stringify({ timestamp: Date.now(), answers })
  );
}

export function shouldSimulateResponses() {
  return localStorage.getItem("should_simulate_responses") === "true";
}

window.toggleSimulateResponses = () => {
  localStorage.setItem("should_simulate_responses", !shouldSimulateResponses());
  console.log(`should_simulate_response: ${shouldSimulateResponses()}`);
};

export function setupSimulateResponsesCheckbox(cls) {
  const checkbox = document.querySelector(cls);
  checkbox.checked = shouldSimulateResponses();
  checkbox.addEventListener("change", () =>
    localStorage.setItem("should_simulate_responses", checkbox.checked)
  );
}

export const EXAMPLE_CODE = `# Here is some example code

# Slow version
def fibonacci(i):
  if i == 0 or i == 1:
    return 1
  
  return fibonacci(i-1) + fibonacci(i-2)
    

# Faster version
def fibonacci(n):
  fibs = []
  for i in range(n):
    if i <= 1:
      fibs.append(1)
      continue
    fibs.append(fibs[i-1]+fibs[i-2])
  return fibs[-1]
`;
