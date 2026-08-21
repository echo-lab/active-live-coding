import "./style.css";
import "./style-student-page.css";
import "./style-review-lecture.css";

import { createNoopSocket, GET_JSON_REQUEST } from "./utils.js";
import { StudentCodeEditor } from "./code-editors.js";
import {
  versionBlocksField,
  setVersionBlockReadOnly,
} from "./cm-version-widget.js";
import { makeActivitiesPanelResizable } from "./shared-interactions.js";
import { StudentActivitiesPanel } from "./activities-panel.js";
import { StudentActivitiesManager } from "./activities-manager.js";
import { StudentPollCompletePopover } from "./poll-complete-popover.js";
import { PollPopoverCoordinator } from "./poll-popover-coordinator.js";
import { createHistoricalViewController } from "./historical-view-controller.js";

const instructorCodeContainer = document.querySelector("#instructor-code-container");
const instructorCodeTab = document.querySelector("#instructor-code-tab");
const parentContainer = document.querySelector(".parent-container");
const reviewErrorEl = document.querySelector("#review-error");
const reviewBannerEl = document.querySelector("#review-banner");

const activitiesResizer = document.querySelector("#resize-activities");
const activitiesContainer = document.querySelector("#activities-container");
const { openPanel: openActivitiesPanel, closePanel: closeActivitiesPanel } = makeActivitiesPanelResizable(
  parentContainer,
  activitiesResizer,
  activitiesContainer,
  document.querySelector("#open-activities-panel"),
  /*gutterWidth=*/ 12,
  /*minCodeWidth=*/ 400,
  /*minActivitiesWidth=*/ 300,
  /*initiallyCollapsed*/ true
);

document.querySelector("#open-activities-panel").addEventListener("click", openActivitiesPanel);
document.querySelector("#student-activities-list-close").addEventListener("click", () => {
  historicalController.returnToLive();
  closeActivitiesPanel();
});

// Whichever student this browser belongs to (if any) -- read directly rather than via
// getUserID(), which would mint and persist a brand-new id as a side effect if none exists yet.
// That's the right behavior for the live student page (which is establishing a new identity),
// but wrong here: a reviewer with no prior identity should just see no responses, not get one
// silently created.
const studentId = localStorage.getItem("user_id");

const historicalController = createHistoricalViewController({
  liveTabEl: instructorCodeTab,
  historicalTabEl: document.querySelector("#historical-code-tab"),
  historicalTabTextEl: document.querySelector("#historical-code-tab-text"),
  historicalTabCloseBtn: document.querySelector("#historical-code-tab .historical-code-tab-close"),
  liveContainerEl: instructorCodeContainer,
  historicalContainerEl: document.querySelector("#historical-code-container"),
  historicalMountEl: document.querySelector("#historical-code-container .historical-editor-mount"),
  returnToLiveBtn: document.querySelector("#return-to-live-btn"),
  createActivePopover: (args) => new StudentPollCompletePopover({ ...args, student_id: studentId }),
  createCompletePopover: (args) => new StudentPollCompletePopover({ ...args, student_id: studentId }),
  studentId,
  reviewMode: true,
});

function showError(message) {
  parentContainer.hidden = true;
  reviewErrorEl.textContent = message;
  reviewErrorEl.hidden = false;
}

function initialize({ name, isFinished, sessionNumber, lectureDoc, lectureDocVersion, exercises = [], versionBlocks = [] }) {
  document.querySelector("#session-name-display").innerText = `Lecture ID: ${name}`;
  reviewBannerEl.hidden = isFinished;

  setVersionBlockReadOnly(true);

  const noopSocket = createNoopSocket();

  const activitiesManager = new StudentActivitiesManager({
    sessionNumber,
    userId: studentId,
    studentIdentifier: null,
    socket: noopSocket,
    exercises,
  });

  let activitiesPanel;

  const codeEditor = new StudentCodeEditor({
    node: instructorCodeContainer,
    doc: lectureDoc,
    docVersion: lectureDocVersion,
    socket: noopSocket,
    sessionId: sessionNumber,
    extraExtensions: [versionBlocksField],
    versionBlocks,
    activitiesManager,
    reviewMode: true,
    onOpenPollMarker: (exerciseId) => activitiesPanel?.showExerciseById(exerciseId),
  });

  const pollPopoverCoordinator = new PollPopoverCoordinator();

  const studentCompletePollPopover = new StudentPollCompletePopover({
    student_id: studentId,
    manager: activitiesManager,
    showPollPopover: (args) => codeEditor.showPollPopover(args),
    hidePollPopover: (key) => codeEditor.hidePollPopover(key),
    coordinator: pollPopoverCoordinator,
    onClose: () => activitiesPanel?.notifyCompletePopoverClosed(),
  });

  activitiesPanel = new StudentActivitiesPanel(activitiesManager, {
    student_id: studentId,
    reviewMode: true,
    onPollPanelOpenChange: (id) => codeEditor.setPollHighlightOpen(id),
    completePopover: studentCompletePollPopover,
    getAnchor: (ex) => {
      if (ex.code_anchor_from != null && ex.code_anchor_to != null) {
        const at = codeEditor.getPollAnchorPosition(ex.id);
        if (at != null) return { kind: "code", at, getRange: () => codeEditor.getPollAnchorRange(ex.id) };
      }
      const paneRect = instructorCodeContainer.getBoundingClientRect();
      return {
        kind: "standalone",
        rect: { top: paneRect.top + 8, bottom: paneRect.top + 8, left: paneRect.right - 8, right: paneRect.right - 8, width: 0, height: 0 },
      };
    },
    scrollToExercise: (ex) => {
      historicalController.returnToLive();
      if (ex.type === "CODE_VARIANT") {
        codeEditor.scrollToVersionBlock(ex.VersionBlockId);
      } else {
        codeEditor.scrollToPollMarker(ex.id);
      }
    },
    openHistoricalView: (ex) => historicalController.open(ex, activitiesManager),
    closeHistoricalView: () => historicalController.returnToLive(),
  });
}

async function load() {
  const lectureId = new URLSearchParams(location.search).get("id");
  if (!lectureId) {
    showError("No lecture id was given. Check the link and try again.");
    return;
  }

  const params = new URLSearchParams({ id: lectureId, ...(studentId ? { studentId } : {}) });
  const res = await fetch(`/review-lecture?${params}`, GET_JSON_REQUEST).then((r) => r.json());
  if (res.error) {
    showError(res.error === "Lecture not found" ? "This lecture couldn't be found." : res.error);
    return;
  }
  initialize(res);
}

load();
