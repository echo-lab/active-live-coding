import "./style.css";
import "./style-student-page.css";
import "./style-review-lecture.css";

import { createNoopSocket, GET_JSON_REQUEST } from "./utils.js";
import { setVersionBlockReadOnly } from "./cm-version-widget.js";
import { LectureFileSystem } from "./file-system.js";
import { StudentWorkspace } from "./workspace.js";
import { makeActivitiesPanelResizable } from "./shared-interactions.js";
import { StudentActivitiesPanel } from "./activities-panel.js";
import { StudentActivitiesManager } from "./activities-manager.js";
import { StudentPollCompletePopover } from "./poll-complete-popover.js";
import { PollPopoverCoordinator } from "./poll-popover-coordinator.js";
import { createHistoricalViewController } from "./historical-view-controller.js";

const codeContainersHost = document.querySelector("#code-containers");
const fileTabsEl = document.querySelector("#file-tabs");
const workspaceRow = document.querySelector("#workspace-row");
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
  liveTabEl: fileTabsEl,
  historicalTabEl: document.querySelector("#historical-code-tab"),
  historicalTabTextEl: document.querySelector("#historical-code-tab-text"),
  historicalTabCloseBtn: document.querySelector("#historical-code-tab .historical-code-tab-close"),
  liveContainerEl: codeContainersHost,
  historicalContainerEl: document.querySelector("#historical-code-container"),
  historicalMountEl: document.querySelector("#historical-code-container .historical-editor-mount"),
  returnToLiveBtn: document.querySelector("#return-to-live-btn"),
  createActivePopover: (args) => new StudentPollCompletePopover({ ...args, student_id: studentId }),
  createCompletePopover: (args) => new StudentPollCompletePopover({ ...args, student_id: studentId }),
  studentId,
  reviewMode: true,
});

function showError(message) {
  workspaceRow.hidden = true;
  reviewErrorEl.textContent = message;
  reviewErrorEl.hidden = false;
}

function initialize({ name, isFinished, sessionNumber, files = [], exercises = [], versionBlocks = [], instructorView = null }) {
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

  // Read-only and static: the reader browses the files freely (there's no instructor to follow).
  const workspace = new StudentWorkspace({
    fs: new LectureFileSystem({ files, sessionNumber }),
    containersHostEl: codeContainersHost,
    tabsEl: fileTabsEl,
    treePanelEl: document.querySelector("#file-tree-panel"),
    sessionNumber,
    activitiesManager,
    versionBlocks,
    instructorView,
    mode: "review",
    onOpenPollMarker: (exerciseId) => activitiesPanel?.showExerciseById(exerciseId),
  });
  // Opening a file tab leaves the historical view.
  workspace.addEventListener("viewchange", ({ detail: { source } }) => {
    if (source === "user") historicalController.returnToLive();
  });

  const pollPopoverCoordinator = new PollPopoverCoordinator();

  const studentCompletePollPopover = new StudentPollCompletePopover({
    student_id: studentId,
    manager: activitiesManager,
    showPollPopover: (args) => workspace.showPollPopover(args),
    hidePollPopover: (key) => workspace.hidePollPopover(key),
    coordinator: pollPopoverCoordinator,
    onClose: () => activitiesPanel?.notifyCompletePopoverClosed(),
  });

  activitiesPanel = new StudentActivitiesPanel(activitiesManager, {
    student_id: studentId,
    reviewMode: true,
    onPollPanelOpenChange: (id) => workspace.setPollHighlightOpen(id),
    completePopover: studentCompletePollPopover,
    getAnchor: (ex) => workspace.anchorForExercise(ex),
    scrollToExercise: (ex) => {
      historicalController.returnToLive();
      workspace.scrollToExercise(ex);
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
