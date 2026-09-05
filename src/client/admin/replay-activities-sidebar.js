import {
  activityPreviewText,
  activityIconHtml,
  isAnchorDeleted,
  computeAnonLabels,
  createAnswerDisplay,
  computeMcqCounts,
  PollMcqBuilder,
  buildActivityHeader,
} from "../activities-panel.js";

// Read-only activities sidebar for the admin lecture-replay page. Deliberately NOT
// InstructorActivitiesPanel/StudentActivitiesPanel -- both attach listeners to fixed page-level
// DOM nodes on construction and expect a live, event-driven exercise lifecycle, neither of which
// holds for a component fed a fresh, arbitrary-order snapshot on every scrub tick. This mimics the
// instructor's real panel visually (same ids/classes, so it picks up the exact same CSS in
// style.css) and structurally (list <-> summary views, same response rendering), but is
// constructed once and simply re-rendered, and has no code path that can create, finish, or
// dissolve anything -- there is no "ask students"/"finish"/"add as variant" wiring here at all.
export function createReplayActivitiesSidebar({ onScrollToExercise }) {
  const listEl = document.querySelector("#activities-list");
  const listItemsEl = document.querySelector("#activities-list-items");
  const pollEl = document.querySelector("#activities-poll");
  const codeExerciseEl = document.querySelector("#activities-code-exercise");

  let currentExercises = [];
  let selectedExerciseId = null;

  function showView(name) {
    listEl.hidden = name !== "list";
    pollEl.hidden = name !== "poll";
    codeExerciseEl.hidden = name !== "code-exercise";
  }

  function backToList() {
    selectedExerciseId = null;
    showView("list");
    updateSelectedHighlight();
  }

  function updateSelectedHighlight() {
    listItemsEl.querySelectorAll(".activity-list-item[data-exercise-id]").forEach((el) => {
      el.classList.toggle("selected", Number(el.dataset.exerciseId) === selectedExerciseId);
    });
  }

  function renderSummary(ex) {
    const isPoll = ex.type === "POLL" || ex.type === "POLL_MCQ";
    const container = isPoll ? pollEl : codeExerciseEl;
    container.innerHTML = "";
    container.appendChild(buildActivityHeader({ onBack: backToList, onClose: backToList }));

    const responsesEl = document.createElement("div");
    responsesEl.className = "responses-list";
    container.appendChild(responsesEl);

    if (ex.type === "POLL_MCQ" && ex.default_answer) {
      const choices = JSON.parse(ex.default_answer);
      const { counts, total } = computeMcqCounts(choices, ex.ExerciseResponses);
      PollMcqBuilder.buildResults(responsesEl, choices, counts, total);
    } else if (ex.ExerciseResponses.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No responses.";
      responsesEl.appendChild(empty);
    } else {
      const anonLabels = computeAnonLabels(ex.ExerciseResponses);
      ex.ExerciseResponses.forEach((r) => {
        const label = r.student_identifier || anonLabels.get(r);
        responsesEl.appendChild(createAnswerDisplay(r.answer, ex.type, { label }));
      });
    }

    showView(isPoll ? "poll" : "code-exercise");
  }

  function renderList() {
    listItemsEl.innerHTML = "";
    const relevant = currentExercises.filter(
      (ex) => ex.type === "POLL" || ex.type === "POLL_MCQ" || ex.type === "CODE_VARIANT"
    );
    [...relevant].reverse().forEach((ex) => {
      const isActive = ex.end_ts == null;
      const item = document.createElement("div");
      item.className = "activity-list-item";
      item.classList.toggle("anchor-deleted", isAnchorDeleted(ex));
      const previewClass = ex.type === "CODE_VARIANT" ? "activity-item-preview is-code" : "activity-item-preview";
      const badge = isActive ? `<span class="activity-item-badge badge-active">Active</span>` : "";
      item.innerHTML = `${activityIconHtml(ex)}<span class="${previewClass}">${activityPreviewText(ex)}</span>${badge}`;

      // Per product decision: an exercise still active as of the current scrub time isn't
      // clickable at all -- closer to how the live app treats an in-progress exercise, and avoids
      // needing any live/active popover equivalent in this read-only context.
      if (!isActive) {
        item.dataset.exerciseId = ex.id;
        item.addEventListener("click", () => {
          selectedExerciseId = ex.id;
          onScrollToExercise?.(ex);
          renderSummary(ex);
          updateSelectedHighlight();
        });
      }
      listItemsEl.appendChild(item);
    });
    updateSelectedHighlight();
  }

  function render(exercisesAtT) {
    currentExercises = exercisesAtT;
    renderList();
    if (selectedExerciseId != null) {
      const ex = currentExercises.find((e) => e.id === selectedExerciseId && e.end_ts != null);
      if (ex) {
        renderSummary(ex);
      } else {
        backToList();
      }
    }
  }

  showView("list");
  return { render };
}
