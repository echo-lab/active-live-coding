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

  function returnToLive() {
    if (currentExerciseId == null) return;
    liveTabEl.classList.add("selected");
    historicalTabEl.classList.remove("selected");
    liveContainerEl.hidden = false;
    historicalContainerEl.hidden = true;
  }

  async function open(ex) {
    if (isShowingExercise(ex.id)) {
      showHistoricalTab();
      return;
    }

    const data = await fetch(`/exercise/${ex.id}/historical-context`, GET_JSON_REQUEST).then((r) => r.json());
    if (data.error) {
      console.error("Failed to load historical context:", data.error);
      return;
    }

    historicalPopover?.close();
    historicalEditor?.destroy();
    historicalMountEl.innerHTML = "";
    historicalEditor = new HistoricalCodeEditor({ node: historicalMountEl, doc: data.doc });

    // Make the tab/container visible BEFORE placing the marker/widget below -- scrolling to it
    // needs a real, laid-out (non-hidden) scroller to animate against, or the smooth scroll has
    // nothing to animate from and just jumps once the container becomes visible afterward.
    historicalTabTextEl.textContent = `instructor.py · ${formatRelativeTime(data.timestamp)}`;
    historicalTabEl.hidden = false;
    currentExerciseId = ex.id;
    showHistoricalTab();

    // One more wait: the browser needs to actually PAINT that now-visible, unscrolled frame
    // before an animated scroll away from it is perceptible -- doing both in the same tick
    // means the container's first-ever paint already shows the scrolled state, so there's
    // nothing to visibly animate from and it just looks like a jump.
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
  }

  liveTabEl.addEventListener("click", returnToLive);
  historicalTabEl.addEventListener("click", () => {
    if (currentExerciseId != null) showHistoricalTab();
  });
  historicalTabCloseBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    returnToLive();
  });
  returnToLiveBtn?.addEventListener("click", returnToLive);

  return { open, returnToLive, isShowingExercise };
}
