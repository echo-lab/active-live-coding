import { HistoricalCodeEditor } from "./historical-code-editor.js";
import { PollPopoverCoordinator } from "./poll-popover-coordinator.js";
import { GET_JSON_REQUEST } from "./utils.js";

function formatRelativeTime(ms) {
  const diffSec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? "" : "s"} ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
}

// Drives the "historical view" tab: a second, read-only code-editor tab shown in place of the
// live one when the user clicks a sidebar activity whose anchor is gone. Identical wiring is
// used on both the instructor and student pages (same DOM pattern, same endpoint) -- the only
// per-page difference is which PollCompletePopover class/args to build, which the caller
// supplies via `createCompletePopover`.
export function createHistoricalViewController({
  liveTabEl,
  historicalTabEl,
  historicalTabTextEl,
  historicalTabCloseBtn,
  liveContainerEl,
  historicalContainerEl,
  historicalMountEl,
  returnToLiveBtn,
  createCompletePopover, // ({showPollPopover, hidePollPopover, coordinator, onClose}) => popover instance
  onClose, // (exerciseId) => void, called whenever the historical tab for that exercise tears down
  studentId = null, // when set (student page), also fetch this student's own answer to show as a trailing tab
}) {
  let historicalEditor = null;
  let historicalPopover = null;
  let currentExerciseId = null;

  function isShowingExercise(id) {
    return currentExerciseId === id;
  }

  function showHistoricalTab() {
    liveTabEl.classList.remove("selected");
    historicalTabEl.classList.add("selected");
    liveContainerEl.hidden = true;
    historicalContainerEl.hidden = false;
  }

  function showLiveTab() {
    liveTabEl.classList.add("selected");
    historicalTabEl.classList.remove("selected");
    liveContainerEl.hidden = false;
    historicalContainerEl.hidden = true;
  }

  // Fully tears down the historical tab (not just switches away from it) -- destroys the editor
  // and popover, forgets which exercise was showing, and hides the tab itself. Used any time we
  // navigate away from the historical view for good: its own close/return-to-live controls, the
  // activities panel's back/close buttons, picking a new activity, or switching to the live tab.
  function closeHistorical() {
    if (currentExerciseId == null) return;
    const closedId = currentExerciseId;
    showLiveTab();
    historicalPopover?.close();
    historicalEditor?.destroy();
    historicalEditor = null;
    historicalPopover = null;
    currentExerciseId = null;
    historicalTabEl.hidden = true;
    historicalMountEl.innerHTML = "";
    onClose?.(closedId);
  }

  async function open(ex) {
    if (isShowingExercise(ex.id)) {
      showHistoricalTab();
      return;
    }

    const url =
      studentId != null
        ? `/exercise/${ex.id}/historical-context?student_id=${encodeURIComponent(studentId)}`
        : `/exercise/${ex.id}/historical-context`;
    const data = await fetch(url, GET_JSON_REQUEST).then((r) => r.json());
    if (data.error) {
      console.error("Failed to load historical context:", data.error);
      return;
    }

    closeHistorical();

    // Make the tab/container visible BEFORE constructing the editor below -- CodeMirror can't
    // measure real layout while mounted inside a `hidden` (display:none) container, which breaks
    // the animated scroll-into-view further down.
    historicalTabTextEl.textContent = `instructor.py · ${formatRelativeTime(data.timestamp)}`;
    historicalTabEl.hidden = false;
    currentExerciseId = ex.id;
    showHistoricalTab();

    // Wait a frame so the browser actually PAINTs that now-visible, unscrolled, empty container
    // before we mount the editor into it -- otherwise the editor's own first paint and its
    // scrolled-to-target state land in the same frame, and there's nothing to visibly animate
    // from (it just looks like a jump).
    requestAnimationFrame(() => {
      historicalEditor = new HistoricalCodeEditor({ node: historicalMountEl, doc: data.doc });

      // One more wait: give CodeMirror a frame to lay out/measure the freshly-mounted,
      // now-visible editor before we scroll it -- scrolling in the same tick as mounting can
      // race CodeMirror's own becomes-visible remeasure and again just jump instead of animate.
      requestAnimationFrame(() => {
        if (data.type === "CODE_VARIANT") {
          historicalEditor.renderVersionBlock(data.versionBlock);
        } else {
          historicalEditor.renderPollMarker({ id: ex.id, from: data.anchor.from, to: data.anchor.to });
          historicalPopover = createCompletePopover({
            showPollPopover: (args) => historicalEditor.showPollPopover(args),
            hidePollPopover: (key) => historicalEditor.hidePollPopover(key),
            coordinator: new PollPopoverCoordinator(),
            onClose: () => {},
          });
          historicalPopover.open({
            exercise: ex,
            anchor: {
              kind: "code",
              at: historicalEditor.getPollAnchorPosition(ex.id),
              getRange: () => historicalEditor.getPollAnchorRange(ex.id),
            },
          });
        }
      });
    });
  }

  liveTabEl.addEventListener("click", closeHistorical);
  historicalTabEl.addEventListener("click", () => {
    if (currentExerciseId != null) showHistoricalTab();
  });
  historicalTabCloseBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeHistorical();
  });
  returnToLiveBtn?.addEventListener("click", closeHistorical);

  return { open, returnToLive: closeHistorical, isShowingExercise };
}
