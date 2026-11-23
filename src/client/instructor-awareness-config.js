// Knobs for the student-side "where is the instructor / what are they doing" cues (see
// workspace.js StudentWorkspace, file-tree.js, file-tabs.js, cm-instructor-awareness.js).
// Tweak these to try out different variants -- everything reads them at runtime.
export const INSTRUCTOR_AWARENESS = {
  enabled: true,

  // true: the tree/tab cues only show once the student has stopped following the instructor.
  // false: they also show while following. (The editor's edge bars while following are governed
  // by the student's own follow-offscreen preference instead -- see getFollowOffscreenMode.)
  onlyWhenNotFollowing: true,

  // Tint + badge on the instructor's active file.
  markInstructorFile: { tree: true, tab: true },

  // The badge: "svg-person", "dot", or any short text / emoji (e.g. "👩‍🏫").
  badge: "svg-person",

  // Glow the file's tree row / tab while the instructor types in it:
  //   "never" | "other-file" (only if it isn't the student's current file) | "always"
  flashTreeOnEdit: "other-file",
  flashTabOnEdit: "other-file",

  // Version blocks: badge + tint the instructor's selected variant's tab, and glow a variant's tab
  // while the instructor types in it:
  //   "never" | "other-variant" (only if the student has a different tab selected) | "always"
  markInstructorVariant: "other-variant",
  flashVariantOnEdit: "other-variant",

  // Glow the "Follow instructor" button when the instructor types:
  //   "never" | "out-of-view" (in a file or variant the student isn't looking at) | "always"
  flashFollowButtonOnEdit: "out-of-view",

  // In the instructor's file: edge bars at the top/bottom of the editor when the instructor's
  // cursor (showCursor) or an edit (flashOnEdit) is scrolled out of view.
  offscreen: { showCursor: true, flashOnEdit: true },

  // Each keystroke flashes the cue, which immediately starts fading back over this long.
  flashFadeMs: 600,
};

// Student preference (gear menu) for when they're following and the instructor's cursor is
// scrolled out of view:
//   "cues":   show the off-screen edge bars, as when not following (default)
//   "scroll": scroll the editor so the instructor stays in view (e.g. for projecting a student
//             window to the class)
const FOLLOW_OFFSCREEN_STORAGE_KEY = "student_follow_offscreen";
export const FOLLOW_OFFSCREEN_MODES = ["cues", "scroll"];

export function getFollowOffscreenMode() {
  try {
    const mode = localStorage.getItem(FOLLOW_OFFSCREEN_STORAGE_KEY);
    return FOLLOW_OFFSCREEN_MODES.includes(mode) ? mode : "cues";
  } catch {
    return "cues";
  }
}

export function setFollowOffscreenMode(mode) {
  try {
    localStorage.setItem(FOLLOW_OFFSCREEN_STORAGE_KEY, mode);
  } catch {
    // Storage unavailable (e.g. private mode) -- just don't remember it.
  }
}

// The badge as a DOM element (fresh each call).
export function makeInstructorBadge() {
  const el = document.createElement("span");
  el.className = "instructor-badge";
  el.title = "The instructor is here";
  const badge = INSTRUCTOR_AWARENESS.badge;
  if (badge === "svg-person") {
    el.innerHTML =
      '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><circle cx="8" cy="4.5" r="3" fill="currentColor"/><path d="M2 15c0-3.6 2.7-6 6-6s6 2.4 6 6z" fill="currentColor"/></svg>';
  } else if (badge === "dot") {
    el.classList.add("instructor-badge-dot");
  } else {
    el.textContent = badge;
  }
  return el;
}

// Shared "flash, then fade straight back" helper (a CSS animation, restarted on every pulse). Keyed
// (e.g. by file id) so a flash survives re-renders: `getEl()` is re-resolved both when pulsing and
// when the flash ends, and components call glowingKeys() while rendering to re-apply the class.
export class GlowTracker {
  constructor(className = "instructor-activity") {
    this.className = className;
    this.timers = new Map(); // key -> timeout
  }

  pulse(key, getEl) {
    restartFlash(getEl(), this.className);
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        getEl()?.classList.remove(this.className);
      }, INSTRUCTOR_AWARENESS.flashFadeMs),
    );
  }

  isGlowing(key) {
    return this.timers.has(key);
  }

  glowingKeys() {
    return [...this.timers.keys()];
  }
}

// (Re)starts the flash animation on `el`: drop the class, force a reflow so the browser notices,
// then add it back. The duration comes from flashFadeMs via a CSS variable.
export function restartFlash(el, className) {
  if (!el) return;
  el.style.setProperty("--instructor-flash-ms", `${INSTRUCTOR_AWARENESS.flashFadeMs}ms`);
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
}

// MARK: Active-exercise badge
// The red "?" (the live-poll gutter marker's look) on tree rows / tabs whose file has an active
// exercise (poll or code). `aggregate`: the element stands in for several files (a collapsed
// folder, the collapsed tree's toggle, the tab overflow button). Fresh element each call.
export function makeExerciseBadge({ aggregate = false } = {}) {
  const el = document.createElement("span");
  el.className = "exercise-badge";
  el.textContent = "?";
  el.title = aggregate ? "An exercise is active in a file in here" : "An exercise is active in this file";
  return el;
}
