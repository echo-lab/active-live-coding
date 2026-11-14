import "../style.css";
import "../style-student-page.css";
import "../style-review-lecture.css";
import "./style-admin.css";

import { GET_JSON_REQUEST, createNoopSocket } from "../utils.js";
import { setVersionBlockReadOnly, VersionBlockWidget } from "../cm-version-widget.js";
import { StudentActivitiesManager } from "../activities-manager.js";
import { LectureFileSystem } from "../file-system.js";
import { StudentWorkspace } from "../workspace.js";
import {
  computeSnapshotAtTime,
  computeTimelineMarkers,
  computeTimeBounds,
  computeActivityTimeline,
  compressTime,
  expandCompressed,
} from "./replay-snapshot.js";
import { createReplayActivitiesSidebar } from "./replay-activities-sidebar.js";

// Widgets in this page are always frozen historical snapshots -- never a live doc to protect.
setVersionBlockReadOnly(true);

const mainEl = document.querySelector("#replay-main");
const followBtn = document.querySelector("#follow-instructor-btn");
const errorEl = document.querySelector("#replay-error");
const nameDisplayEl = document.querySelector("#replay-session-name-display");
const timelineEl = document.querySelector("#replay-timeline");
const rangeEl = document.querySelector("#replay-timeline-range");
const gapsEl = document.querySelector("#replay-timeline-gaps");
const markersEl = document.querySelector("#replay-timeline-markers");
const timeEl = document.querySelector("#replay-timeline-time");
const prevBtn = document.querySelector("#replay-prev-btn");
const nextBtn = document.querySelector("#replay-next-btn");
const eventLogToggleBtn = document.querySelector("#replay-event-log-toggle");
const eventLogListEl = document.querySelector("#replay-event-log-list");

// Stateless -- StudentActivitiesManager unconditionally calls socket.on(...), but this page replays from an in-memory snapshot and never receives (or sends) any live messages.
const noopSocket = createNoopSocket();

let data = null;
let markers = [];
let bounds = { min: 0, max: 0 };
let segments = [];
let totalCompressedUnits = 0;
// Built once data arrives; load()-ed with a fresh snapshot on every scrub. Like a student, it
// follows the instructor's tabs (as recorded at the scrub time) until the viewer picks a file.
let workspace = null;
// The exact scrub position, authoritative -- never re-derived from the range input's (quantized)
// value. Only jumpTo()/the input handlers ever set this; everything else (stepping, the event
// log's highlight) reads it directly, so there's no lossy round-trip to drift against.
let currentT = 0;

function showError(message) {
  mainEl.hidden = true;
  timelineEl.hidden = true;
  errorEl.textContent = message;
  errorEl.hidden = false;
}

// Mounts a real, instructor-style read-only VersionBlockWidget -- only the variants the
// instructor actually created as of the current scrub time, never a per-student pseudo-variant.
// Browsing student responses happens in the sidebar instead, same as the live instructor's
// "add as variant" being a deliberate action rather than something that happens automatically.
function makeVersionBlockWidget({ versionBlockId, variants, view }) {
  return new VersionBlockWidget({ versionBlockId, variants, view, readOnly: true });
}

const sidebar = createReplayActivitiesSidebar({
  onScrollToExercise: (ex) => {
    if (ex.type === "CODE_VARIANT" ? ex.VersionBlockId != null : ex.code_anchor_from != null) {
      workspace?.scrollToExercise(ex);
    }
  },
});

function renderAtTime(T) {
  const snapshot = computeSnapshotAtTime(data, T);

  const activitiesManager = new StudentActivitiesManager({
    sessionNumber: data.id,
    userId: null,
    studentIdentifier: null,
    socket: noopSocket,
    exercises: snapshot.exercises,
  });

  // Rebuilds every file's editor (disposing the old ones, including their version blocks' nested
  // variant editors).
  workspace.load({
    files: snapshot.files,
    versionBlocks: snapshot.versionBlocks,
    activitiesManager,
    instructorView: snapshot.instructorView,
  });

  sidebar.render(snapshot.exercises);

  timeEl.textContent = new Date(T).toLocaleString();
  updateEventLogHighlight();
}

let rafScheduled = false;
function scheduleRender(T) {
  // currentT updates immediately (synchronously with the drag), even though the expensive
  // re-render itself is coalesced to at most once per frame -- so anything reading currentT
  // in between frames (e.g. a prev/next press mid-drag) still sees an accurate position.
  currentT = T;
  if (rafScheduled) return;
  rafScheduled = true;
  requestAnimationFrame(() => {
    rafScheduled = false;
    renderAtTime(currentT);
  });
}

function jumpTo(T) {
  currentT = T;
  rangeEl.value = Math.round(compressTime(segments, T));
  renderAtTime(T);
}

// Index of the last marker at-or-before T, sorted ascending -- or -1 if T is before all of them.
function findCurrentMarkerIndex(T) {
  let idx = -1;
  for (let i = 0; i < markers.length; i++) {
    if (markers[i].ts <= T) idx = i;
    else break;
  }
  return idx;
}

// Steps to the next/previous individual marker relative to currentT -- never derived from the
// range input's value, so this can't drift the way a re-quantized read of the slider would (see
// the currentT comment above).
function stepMarker(direction) {
  const idx = findCurrentMarkerIndex(currentT);
  if (direction > 0) {
    const next = markers[idx + 1]; // always exactly one past "at-or-before" -- unconditional
    if (next) jumpTo(next.ts);
  } else {
    const onCurrent = idx >= 0 && markers[idx].ts === currentT;
    const prev = markers[onCurrent ? idx - 1 : idx];
    if (prev) jumpTo(prev.ts);
  }
}

function renderMarkers() {
  markersEl.innerHTML = "";
  if (totalCompressedUnits === 0) return;
  markers.forEach((m) => {
    const el = document.createElement("div");
    el.className = `replay-timeline-marker ${m.kind}`;
    el.style.left = `${(compressTime(segments, m.ts) / totalCompressedUnits) * 100}%`;
    el.title = `${m.label} — ${new Date(m.ts).toLocaleString()}`;
    el.addEventListener("click", () => jumpTo(m.ts));
    markersEl.appendChild(el);
  });
}

// Renders each compressed-away gap as a small fixed-ish band (see computeActivityTimeline) with a
// tooltip showing how long it really was -- the "this is a break" decoration for the timeline.
function renderGaps() {
  gapsEl.innerHTML = "";
  if (totalCompressedUnits === 0) return;
  segments
    .filter((s) => s.kind === "gap")
    .forEach((s) => {
      const el = document.createElement("div");
      el.className = "replay-timeline-gap";
      const leftPct = (s.compressedStart / totalCompressedUnits) * 100;
      const widthPct = ((s.compressedEnd - s.compressedStart) / totalCompressedUnits) * 100;
      el.style.left = `${leftPct}%`;
      el.style.width = `${widthPct}%`;
      el.title = `${formatDuration(s.endT - s.startT)} with no recorded activity`;
      gapsEl.appendChild(el);
    });
}

function formatDuration(ms) {
  const totalMinutes = Math.round(ms / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(" ");
}

// Built once the marker/segment data is known; each row is clickable, and the "current" row
// (findCurrentMarkerIndex(currentT)) is kept in sync on every render via updateEventLogHighlight.
function buildEventLogRows() {
  eventLogListEl.innerHTML = "";
  const rows = [
    ...markers.map((m, i) => ({ kind: "marker", index: i, ts: m.ts })),
    ...segments.filter((s) => s.kind === "gap").map((s) => ({ kind: "gap", ts: s.startT, duration: s.endT - s.startT })),
  ].sort((a, b) => a.ts - b.ts);

  rows.forEach((row) => {
    if (row.kind === "gap") {
      const el = document.createElement("div");
      el.className = "replay-event-log-gap-row";
      el.textContent = `— ${formatDuration(row.duration)} gap —`;
      eventLogListEl.appendChild(el);
      return;
    }
    const m = markers[row.index];
    const el = document.createElement("div");
    el.className = "replay-event-log-row";
    el.dataset.markerIndex = row.index;
    el.innerHTML = `<span class="replay-event-log-ts">${new Date(m.ts).toLocaleString()}</span><span>${m.label}</span>`;
    el.addEventListener("click", () => jumpTo(m.ts));
    eventLogListEl.appendChild(el);
  });
}

function updateEventLogHighlight() {
  const currentIndex = findCurrentMarkerIndex(currentT);
  let currentRow = null;
  eventLogListEl.querySelectorAll(".replay-event-log-row").forEach((el) => {
    const isCurrent = Number(el.dataset.markerIndex) === currentIndex;
    el.classList.toggle("current", isCurrent);
    if (isCurrent) currentRow = el;
  });
  currentRow?.scrollIntoView({ block: "nearest" });
}

async function load() {
  const lectureId = new URLSearchParams(location.search).get("id");
  if (!lectureId) {
    showError("No lecture id was given. Check the link and try again.");
    return;
  }

  const res = await fetch(`/api/admin/lecture/${lectureId}/replay`, GET_JSON_REQUEST).then((r) => r.json());
  if (res.error) {
    showError(res.error);
    return;
  }
  data = res;
  nameDisplayEl.textContent = `Lecture: ${data.name} (instructor: ${data.instructor_id})`;

  markers = computeTimelineMarkers(data);
  bounds = computeTimeBounds(data);
  if (bounds.max === bounds.min) timelineEl.classList.add("disabled");

  ({ segments, totalCompressedUnits } = computeActivityTimeline(data));
  rangeEl.min = 0;
  rangeEl.max = totalCompressedUnits;
  rangeEl.step = 1;

  workspace = new StudentWorkspace({
    fs: new LectureFileSystem({ sessionNumber: data.id }),
    containersHostEl: document.querySelector("#code-containers"),
    tabsEl: document.querySelector("#file-tabs"),
    treePanelEl: document.querySelector("#file-tree-panel"),
    sessionNumber: data.id,
    mode: "review",
    makeVersionBlockWidget,
  });
  workspace.addEventListener("followchange", ({ detail: { following } }) => {
    followBtn.hidden = following;
  });
  followBtn.addEventListener("click", () => workspace.setFollowing(true));

  renderGaps();
  renderMarkers();
  buildEventLogRows();

  rangeEl.addEventListener("input", () => scheduleRender(expandCompressed(segments, Number(rangeEl.value))));
  rangeEl.addEventListener("change", () => {
    currentT = expandCompressed(segments, Number(rangeEl.value));
    renderAtTime(currentT);
  });
  prevBtn.addEventListener("click", () => stepMarker(-1));
  nextBtn.addEventListener("click", () => stepMarker(1));
  eventLogToggleBtn.addEventListener("click", () => {
    const collapsed = eventLogListEl.hidden;
    eventLogListEl.hidden = !collapsed;
    eventLogToggleBtn.textContent = collapsed ? "▾ Event log" : "▸ Event log";
    if (collapsed) updateEventLogHighlight();
  });

  // Start at the latest available state, like review-lecture.html does.
  jumpTo(bounds.max);
}

load();
