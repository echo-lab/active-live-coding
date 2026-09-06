import { EVENT_TYPES } from "../shared-constants";
import {
  clearEmail,
  getConsentChoice,
  setConsentChoice,
  getSurveyResponse,
  setSurveyResponse,
  POST_JSON_REQUEST,
} from "./utils";

const MAX_OUTPUT_LENGTH = 50;

// MARK: Event logging
const EVENT_FLUSH_INTERVAL_MS = 15000;
const getJitter = () => Math.random() * 5000; // staggers clients so they don't all flush at once

async function gzipCompress(str) {
  let stream = new Blob([str]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function uint8ToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Buffers {timestamp, payload} events for one (isStudent, userId, lectureId)
// context and flushes them, compressed as a single batch, on a jittered timer.
class ClientEventsBuffer {
  constructor(isStudent, userId, lectureId) {
    this.isStudent = isStudent;
    this.userId = userId;
    this.lectureId = lectureId;
    this.queue = [];

    const joinTimestamp = Date.now();
    const joinType = isStudent ? EVENT_TYPES.STUDENT_JOIN_LECTURE : EVENT_TYPES.INSTRUCTOR_JOIN_LECTURE;
    this.recordEvent(joinTimestamp, { type: joinType, timestamp: joinTimestamp });

    this._scheduleFlush();
    window.addEventListener("pagehide", () => this._flushOnLeave());
  }

  recordEvent(timestamp, payload) {
    this.queue.push({ timestamp, payload });
  }

  _scheduleFlush() {
    setTimeout(() => this.flush(), EVENT_FLUSH_INTERVAL_MS + getJitter());
  }

  async flush() {
    if (this.queue.length > 0) {
      let events = this.queue;
      this.queue = [];
      try {
        let compressed = await gzipCompress(JSON.stringify(events));
        await fetch("/api/events", {
          body: JSON.stringify({
            isStudent: this.isStudent,
            userId: this.userId,
            lectureId: this.lectureId,
            eventArray: uint8ToBase64(compressed),
          }),
          ...POST_JSON_REQUEST,
        });
      } catch (e) {
        console.error("Failed to flush events:", e); // best-effort; dropped events are not retried
      }
    }
    this._scheduleFlush();
  }

  // Fires once as the tab is closed, reloaded, or navigated away from. Can't reuse flush()
  // here since CompressionStream is async and isn't guaranteed to finish before the page is
  // torn down -- so this sends the queue uncompressed via sendBeacon, which the browser
  // guarantees to attempt even after the page is gone. sendBeacon caps payload size (~64KB);
  // if the full queue doesn't fit, fall back to just the leave event so that signal isn't
  // lost even if older buffered events are.
  _flushOnLeave() {
    const timestamp = Date.now();
    const type = this.isStudent ? EVENT_TYPES.STUDENT_LEAVE_LECTURE : EVENT_TYPES.INSTRUCTOR_LEAVE_LECTURE;
    const leaveEvent = { timestamp, payload: { type, timestamp } };
    this.queue.push(leaveEvent);
    if (!this._sendBeacon(this.queue)) {
      this._sendBeacon([leaveEvent]);
    }
    this.queue = [];
  }

  _sendBeacon(events) {
    const bytes = new TextEncoder().encode(JSON.stringify(events));
    const body = JSON.stringify({
      isStudent: this.isStudent,
      userId: this.userId,
      lectureId: this.lectureId,
      eventArray: uint8ToBase64(bytes),
    });
    return navigator.sendBeacon("/api/events", new Blob([body], { type: "application/json" }));
  }
}

// Singleton event logger for the current page load -- initEventLogging() must be called once,
// as soon as isStudent/userId/lectureId are known, before anything calls recordEvent().
let eventsBuffer = null;

export function initEventLogging(isStudent, userId, lectureId) {
  eventsBuffer = new ClientEventsBuffer(isStudent, userId, lectureId);
}

export function recordEvent(type, payload = {}) {
  const timestamp = Date.now();
  eventsBuffer.recordEvent(timestamp, { type, timestamp, ...payload });
}

// Wrapping this in an object so we can swap out the editor when we have multiple tabs.
export class RunInteractions {
  constructor({
    runButtonEl,
    codeEditor,
    codeRunner,
    consoleOutput,
    broadcastResult = () => {},
  }) {
    this.editor = codeEditor;
    this.running = false;

    this.el = runButtonEl;
    this.runner = codeRunner;
    this.console = consoleOutput;
    this.broadcastResult = broadcastResult;

    runButtonEl.addEventListener("click", this.runCode.bind(this));
  }

  setEditor(editor) {
    this.editor = editor;
  }

  async runCode() {
    if (this.running) return;
    this.running = true;
    this.el.classList.add("in-progress");
    this.el.disabled = true;
    this.el.textContent = "Running...";

    // Record the event on the server. No need to await.
    let code = this.editor.currentCode();
    recordEvent(EVENT_TYPES.CODE_RUN, { code });

    let minRunTime = new Promise((resolve) => setTimeout(resolve, 500));
    let res = await this.runner.asyncRun(code);
    await minRunTime;
    this.console.addResult({ fileName: this.editor.fileName, ...res });
    this.broadcastResult({ fileName: this.editor.fileName, ...res }); // A no-op in student interfaces.

    this.el.classList.remove("in-progress");
    this.el.disabled = false;
    this.el.textContent = "▶ ️Run";
    this.running = false;
  }
}

const MAX_HEIGHT = 400;
const MIN_HEIGHT = 40;
// Height of the #resize-console bar -- must match the CSS `grid-template-rows` for the
// "resizer" row (style.css / style-student-page.css), since the Run button now lives inside
// this bar and needs room to render.
const RESIZER_BAR_HEIGHT = 36;
export function makeConsoleResizable(outputConsole, resizeBar) {
  let isDragging = false;
  let startY = 0;
  let startHeight = 0;
  resizeBar.addEventListener("mousedown", (ev) => {
    if (ev.target.closest("button")) return; // let the Run button inside the bar be clicked, not dragged
    isDragging = true;
    startY = ev.pageY;
    let rows = getComputedStyle(outputConsole.parentElement).gridTemplateRows.split(" ");
    startHeight = parseFloat(rows[rows.length - 1]);
    resizeBar.classList.add("is-dragging");
    ev.preventDefault(); // stop the drag from turning into a text selection over the editor
  });
  document.addEventListener("mousemove", (ev) => {
    if (!isDragging) return;
    // Delta-based: whatever point on the bar was grabbed stays under the cursor.
    let height = startHeight + (startY - ev.pageY);
    height = Math.min(MAX_HEIGHT, height);
    height = Math.max(height, MIN_HEIGHT);
    outputConsole.style.height = "100%";
    outputConsole.parentElement.style.gridTemplateRows = `40px auto ${RESIZER_BAR_HEIGHT}px ${height}px`;
  });
  document.addEventListener("mouseup", (ev) => {
    isDragging = false;
    resizeBar.classList.remove("is-dragging");
  });
}

export class Console {
  constructor(innerContainer) {
    this.el = innerContainer;
  }

  addResult({
    results = null,
    error = null,
    stderr = [],
    stdout = [],
    fileName = "instructor.py",
    ts = Date.now(),
  }) {
    if (this.el.classList.contains("empty")) {
      this.el.innerText = "";
      this.el.classList.remove("empty");
    }

    if (stdout.length > MAX_OUTPUT_LENGTH) {
      stdout = [
        `[ ${stdout.length - MAX_OUTPUT_LENGTH} lines hidden ]`,
        ...stdout.slice(-MAX_OUTPUT_LENGTH),
      ];
    }

    let container = document.createElement("div");
    container.classList.add("one-code-run-output");

    let header = document.createElement("span");
    let timeString = new Date(ts).toLocaleTimeString();
    header.innerText = `${fileName} · ${timeString}`;
    header.classList.add("code-output-header");
    container.appendChild(header);

    let addOutput = (text, className) => {
      let div = document.createElement("div");
      div.classList.add(className);
      let pre = document.createElement("pre");
      pre.innerText = text;
      div.appendChild(pre);
      container.appendChild(div);
    };
    stdout.forEach((line) => addOutput(line, "stdout-line"));
    stderr.forEach((line) => addOutput(line, "stderr-line"));
    error && addOutput(error, "stderr-line");
    results && addOutput(results, "stdout-line");

    let statusBadge = document.createElement("span");
    statusBadge.classList.add("run-status-badge", error ? "failure" : "success");
    statusBadge.innerText = error ? "✗ Failed" : "✓ Succeeded";
    container.appendChild(statusBadge);

    this.el.appendChild(container);
    this.el.scrollTo(0, 1e6);
  }
}

export function setUpConsentModal({ userId }) {
  const modal = document.querySelector("#consent-modal-background");
  const submitButton = document.querySelector("#consent-submit");
  const closeButton = document.querySelector("#consent-close");
  const errorMessage = document.querySelector("#consent-error");
  const reviewLink = document.querySelector("#review-consent");
  const radios = document.querySelectorAll('input[name="consent-choice"]');

  // The X is only offered when reopening the form after already answering it
  // once -- on the very first, mandatory showing there's nothing to dismiss to.
  function show({ closable }) {
    const existing = getConsentChoice();
    if (existing !== null) {
      radios.forEach((r) => (r.checked = r.value === (existing ? "yes" : "no")));
    }
    closeButton.hidden = !closable;
    errorMessage.textContent = "";
    modal.style.display = "flex";
  }

  function close() {
    modal.style.display = "none";
  }

  async function submit() {
    const checked = document.querySelector('input[name="consent-choice"]:checked');
    if (!checked) {
      errorMessage.textContent = "Please select one of the options above.";
      return;
    }
    const consented = checked.value === "yes";
    setConsentChoice(consented);
    close();
    try {
      await fetch("/api/consent", {
        body: JSON.stringify({ student_id: userId, consented }),
        ...POST_JSON_REQUEST,
      });
    } catch (e) {
      console.error("Failed to record consent:", e);
    }
  }

  submitButton.addEventListener("click", submit);
  closeButton.addEventListener("click", close);
  reviewLink.addEventListener("click", (ev) => {
    ev.preventDefault();
    show({ closable: true });
  });

  if (getConsentChoice() === null) show({ closable: false });
}

export function setUpSurveyModal({ userId, getSessionNumber }) {
  const modal = document.querySelector("#survey-modal-background");
  const submitButton = document.querySelector("#survey-submit");
  const closeButton = document.querySelector("#survey-close");
  const errorMessage = document.querySelector("#survey-error");
  const reviewLink = document.querySelector("#review-survey");

  // Likert groups and free-response fields are discovered from the DOM
  // (rather than hardcoded by name) so that adding, removing, or reordering
  // survey questions in student-page.html never requires touching this file.
  const likertGroupNames = [
    ...new Set(
      [...modal.querySelectorAll('input[type="radio"]')].map((r) => r.name)
    ),
  ];
  const openFields = [...modal.querySelectorAll("textarea")];
  const fieldKey = (domName) => domName.replace(/^survey-/, "");

  function show() {
    const existing = getSurveyResponse();
    likertGroupNames.forEach((name) => {
      const key = fieldKey(name);
      modal.querySelectorAll(`input[name="${name}"]`).forEach((r) => {
        r.checked = existing != null && r.value === existing[key];
      });
    });
    openFields.forEach((field) => {
      field.value = existing?.[fieldKey(field.id)] ?? "";
    });
    errorMessage.textContent = "";
    modal.style.display = "flex";
  }

  function close() {
    modal.style.display = "none";
  }

  async function submit() {
    const answers = {};
    for (const name of likertGroupNames) {
      const checked = modal.querySelector(`input[name="${name}"]:checked`);
      if (!checked) {
        errorMessage.textContent = "Please answer each question above.";
        return;
      }
      answers[fieldKey(name)] = checked.value;
    }
    openFields.forEach((field) => {
      answers[fieldKey(field.id)] = field.value;
    });
    setSurveyResponse(answers);
    close();
    try {
      await fetch("/api/survey-response", {
        body: JSON.stringify({
          student_id: userId,
          lectureId: getSessionNumber(),
          ...answers,
        }),
        ...POST_JSON_REQUEST,
      });
    } catch (e) {
      console.error("Failed to record survey response:", e);
    }
  }

  submitButton.addEventListener("click", submit);
  closeButton.addEventListener("click", close);
  reviewLink.addEventListener("click", (ev) => {
    ev.preventDefault();
    show();
  });
}

export function setUpChangeEmail(el) {
  const emailMessage =
    "Are you sure you want to change your email? Progress will be lost";
  el.hidden = false;
  el.addEventListener("click", () => {
    if (!confirm(emailMessage)) return;
    clearEmail();
    window.location.reload();
  });
}

// NOTE: buildBody is a function that builds the parameters for the correct API call.
// TODO: this isn't really shared anymore -- can consider moving somewhere else?
export function setupJoinLectureModalV2({ url, buildBody, onSuccess }) {
  let sessionNameInput = document.querySelector(".modal input");
  let fetchSessionButton = document.querySelector("#fetch-session");
  let errorMessage = document.querySelector("#load-session-error");
  let modal = document.querySelector(".modal-background");
  let sessionNameDisplay = document.querySelector("#session-name-display");

  const try_connecting = async () => {
    let sessionName = sessionNameInput.value;
    const response = await fetch(url, {
      body: JSON.stringify(buildBody(sessionName)),
      ...POST_JSON_REQUEST,
    });
    let res = await response.json();
    if (!res.sessionNumber) {
      errorMessage.textContent = `Lecture with ID "${sessionName}" does not exist. Please try again.`;
    } else {
      modal.style.display = "none";
      sessionNameDisplay.innerText = `Lecture ID: ${sessionName}`;
      onSuccess({ ...res, sessionName });
    }
  };

  fetchSessionButton.addEventListener("click", try_connecting);
  sessionNameInput.addEventListener("keypress", (ev) => {
    ev.key === "Enter" && try_connecting();
  });
  sessionNameInput.focus();
}

/**
 * Makes a side panel horizontally resizable, with open/close controlled by external callers
 * (e.g. an "activities list" button and an "x" close button) via the returned handle. The
 * "activities list" button (if given) is hidden while the panel is open and shown while closed,
 * since it's the panel's only opener and is redundant once the panel is already visible.
 *
 * @param {HTMLElement} parentContainer - The grid container whose column widths are adjusted.
 * @param {HTMLElement} resizer - The gutter element used as the drag handle.
 * @param {HTMLElement} activitiesPanel - The panel to show/hide.
 * @param {HTMLElement | null} openButton - The external "open" button whose visibility tracks
 *   collapsed state, or null if there isn't one to manage.
 * @param {number} gutterWidth - Width of the gutter column in pixels.
 * @param {boolean} initiallyCollapsed - Whether the panel starts collapsed.
 */
export function makeActivitiesPanelResizable(
  parentContainer,
  resizer,
  activitiesPanel,
  openButton,
  gutterWidth = 8,
  minCodeWidth = 150,
  minActivitiesWidth = 150,
  initiallyCollapsed = false
) {
  let isDragging = false;
  let collapsed = false;
  let savedActivitiesWidth = null;

  // Cleans up after a collapse()/expand() animation settles: drops the transition-enabling
  // class and, if we ended up collapsed, applies display:none (deferred so the panel stays
  // rendered -- and thus visibly slides/fades -- for the whole animation instead of vanishing
  // instantly). Reads the live `collapsed` flag rather than being told an outcome, so rapid
  // open/close reversal mid-animation self-corrects: whichever call settles last wins.
  function settleTransition() {
    if (!parentContainer.classList.contains("panel-animating")) return;
    parentContainer.classList.remove("panel-animating");
    activitiesPanel.classList.remove("panel-animating");
    if (collapsed) activitiesPanel.style.display = "none";
  }

  parentContainer.addEventListener("transitionend", (e) => {
    if (e.target === parentContainer && e.propertyName === "grid-template-columns") {
      settleTransition();
    }
  });

  function collapse() {
    if (collapsed) return;
    collapsed = true;
    // Skip recapturing the width while an open animation is still in flight -- getComputedStyle
    // would return a mid-interpolation value, corrupting the saved width for next time.
    if (!parentContainer.classList.contains("panel-animating")) {
      let cols = getComputedStyle(parentContainer).gridTemplateColumns.split(" ");
      savedActivitiesWidth = cols[2] || null;
    }
    parentContainer.classList.add("panel-animating");
    activitiesPanel.classList.add("panel-animating");
    activitiesPanel.style.opacity = "0";
    // Zero out the gutter too (not just the activities column) -- while collapsed there's
    // nothing to drag, and leaving it non-zero left a persistent gap between the code pane's
    // right edge and the rest of the page (e.g. the topbar's gear icon no longer lined up).
    parentContainer.style.gridTemplateColumns = `auto 0px 0px`;
    // display:none is applied by settleTransition() once the slide/fade finishes, as a
    // fallback in case a browser doesn't fire transitionend for grid-template-columns.
    setTimeout(settleTransition, 300);
    resizer.style.cursor = "default";
    resizer.classList.add("collapsed");
    parentContainer.classList.add("collapsed");
    if (openButton) openButton.hidden = false;
  }

  function expand() {
    if (!collapsed) return;
    collapsed = false;
    // Establish the pre-animation baseline and force a synchronous style flush before setting
    // the open target. Without this, the display:none -> "" flip and the target width/opacity
    // change get coalesced into one recalc with no intermediate frame to transition from, and
    // the panel just snaps open instead of sliding in.
    activitiesPanel.style.display = "";
    activitiesPanel.style.opacity = "0";
    parentContainer.style.gridTemplateColumns = `auto 0px 0px`;
    void parentContainer.offsetHeight;

    parentContainer.classList.add("panel-animating");
    activitiesPanel.classList.add("panel-animating");
    let restoreWidth = savedActivitiesWidth || `calc(31% - ${gutterWidth}px)`;
    parentContainer.style.gridTemplateColumns = `auto ${gutterWidth}px ${restoreWidth}`;
    activitiesPanel.style.opacity = "1";
    setTimeout(settleTransition, 300);
    resizer.style.cursor = "col-resize";
    resizer.classList.remove("collapsed");
    parentContainer.classList.remove("collapsed");
    if (openButton) openButton.hidden = true;
  }

  if (initiallyCollapsed) {
    collapsed = true;
    activitiesPanel.style.display = "none";
    parentContainer.style.gridTemplateColumns = `auto 0px 0px`;
    resizer.style.cursor = "default";
    resizer.classList.add("collapsed");
    parentContainer.classList.add("collapsed");
  } else if (openButton) {
    openButton.hidden = true;
  }

  resizer.addEventListener("mousedown", (e) => {
    if (collapsed) return;
    // Guard against grabbing the gutter in the last few ms of an open animation -- dragging
    // should always be instant, never subject to the panel-open/close transition.
    parentContainer.classList.remove("panel-animating");
    activitiesPanel.classList.remove("panel-animating");
    isDragging = true;
    resizer.classList.add("is-dragging");
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    let rect = parentContainer.getBoundingClientRect();
    let totalWidth = rect.width;
    let codeWidth = e.clientX - rect.left - gutterWidth / 2;
    codeWidth = Math.max(minCodeWidth, Math.min(codeWidth, totalWidth - gutterWidth - minActivitiesWidth));
    let activitiesWidth = totalWidth - codeWidth - gutterWidth;
    parentContainer.style.gridTemplateColumns =
      `${codeWidth}px ${gutterWidth}px ${activitiesWidth}px`;
  });

  document.addEventListener("mouseup", () => {
    if (!isDragging) return;
    isDragging = false;
    resizer.classList.remove("is-dragging");
  });

  return {
    openPanel: expand,
    closePanel: collapse,
  };
}

/**
 * Wires a topbar icon button (e.g. the gear/settings icon) to toggle a dropdown menu open and
 * closed, closing on an outside click or Escape. Used for both the instructor's (review link,
 * end session) and student's (consent form, survey) settings menus.
 */
export function setupDropdownMenu(triggerBtn, menuEl) {
  function close() {
    menuEl.hidden = true;
    triggerBtn.setAttribute("aria-expanded", "false");
  }

  function open() {
    menuEl.hidden = false;
    triggerBtn.setAttribute("aria-expanded", "true");
  }

  triggerBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    menuEl.hidden ? open() : close();
  });

  document.addEventListener("click", (ev) => {
    if (!menuEl.hidden && !menuEl.contains(ev.target) && ev.target !== triggerBtn) close();
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !menuEl.hidden) close();
  });

  return { open, close };
}
