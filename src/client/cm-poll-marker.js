import { StateEffect, StateField, Facet, RangeSetBuilder } from "@codemirror/state";
import { EditorView, Decoration, GutterMarker, gutter } from "@codemirror/view";

////////////////////////////////////////////////////////////////////////////////////////////////////////////
// MARK: Poll marker position tracking
////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const DRAFT_POLL_ID = "__poll_draft__";

// value: {id, from, to, isDraft, isOpen}
export const addPollMarkerEffect = StateEffect.define();
// value: {id}
export const removePollMarkerEffect = StateEffect.define();

// Tracks the live [from, to) range of every poll anchored to this document. Non-replacing
// mark decorations, so (unlike version blocks) the underlying code stays visible/editable.
export const pollMarkersField = StateField.define({
  create: () => Decoration.none,
  update(markers, tr) {
    markers = markers.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(addPollMarkerEffect)) {
        const { id, from, to, isDraft, isOpen } = e.value;
        markers = markers.update({
          filter: (_f, _t, deco) => deco.spec.pollId !== id,
          add: [Decoration.mark({ pollId: id, isDraft: !!isDraft, isOpen: !!isOpen }).range(from, to)],
          sort: true,
        });
      } else if (e.is(removePollMarkerEffect)) {
        const { id } = e.value;
        markers = markers.update({
          filter: (_f, _t, deco) => deco.spec.pollId !== id,
        });
      }
    }
    return markers;
  },
});

// Looks up the CURRENT position of a poll marker (after any live edits since it was added).
export function getPollMarkerPosition(state, id) {
  const markers = state.field(pollMarkersField);
  let from = null, to = null;
  markers.between(0, state.doc.length, (f, t, deco) => {
    if (deco.spec.pollId === id) { from = f; to = t; return false; }
  });
  return { from, to };
}

////////////////////////////////////////////////////////////////////////////////////////////////////////////
// MARK: Hover + panel-open highlight
////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const setPollHover = StateEffect.define();
export const clearPollHover = StateEffect.define();

const pollHoverField = StateField.define({
  create: () => null,
  update(hover, tr) {
    for (const e of tr.effects) {
      if (e.is(setPollHover)) hover = e.value;
      else if (e.is(clearPollHover)) hover = null;
    }
    return hover;
  },
});

// value: pollId (or DRAFT_POLL_ID) whose sidebar view is currently open, or null.
export const setPollPanelOpen = StateEffect.define();
export const clearPollPanelOpen = StateEffect.define();

const pollPanelOpenField = StateField.define({
  create: () => null,
  update(open, tr) {
    for (const e of tr.effects) {
      if (e.is(setPollPanelOpen)) open = e.value;
      else if (e.is(clearPollPanelOpen)) open = null;
    }
    return open;
  },
});

// Highlight decorations are DERIVED from pollMarkersField + the hover/open ids on every read,
// rather than remapped themselves -- pollMarkersField stays the single source of truth for positions.
const pollHighlightDecorations = EditorView.decorations.compute(
  [pollMarkersField, pollHoverField, pollPanelOpenField],
  (state) => {
    const hoverId = state.field(pollHoverField);
    const openId = state.field(pollPanelOpenField);
    if (hoverId == null && openId == null) return Decoration.none;

    const ranges = [];
    state.field(pollMarkersField).between(0, state.doc.length, (from, to, deco) => {
      const isHovered = deco.spec.pollId === hoverId;
      const isOpen = deco.spec.pollId === openId;
      if (!isHovered && !isOpen) return;
      const cls = isHovered ? "cm-poll-highlight cm-poll-hover-highlight" : "cm-poll-highlight";
      ranges.push(Decoration.mark({ class: cls }).range(from, to));
    });
    return Decoration.set(ranges, true);
  },
);

////////////////////////////////////////////////////////////////////////////////////////////////////////////
// MARK: Gutter icon
////////////////////////////////////////////////////////////////////////////////////////////////////////////

// Callback invoked with a pollId when a (non-draft) marker is clicked.
export const handleOpenPollMarker = Facet.define({
  combine: (values) => (values.length ? values.at(-1) : null),
});

class PollGutterMarker extends GutterMarker {
  constructor(pollId, isDraft, isOpen) {
    super();
    this.pollId = pollId;
    this.isDraft = isDraft;
    this.isOpen = isOpen;
  }

  eq(other) {
    return this.pollId === other.pollId && this.isDraft === other.isDraft && this.isOpen === other.isOpen;
  }

  toDOM(view) {
    const el = document.createElement("div");
    const isLive = !this.isDraft && this.isOpen;
    el.className = "cm-poll-marker-icon" + (this.isDraft ? " cm-poll-marker-draft" : "") + (isLive ? " cm-poll-marker-open" : "");
    el.textContent = "?";
    el.title = this.isDraft
      ? "Poll draft (not yet asked)"
      : isLive
        ? "Poll is live — click to view"
        : "Poll linked to this code — click to view";

    el.addEventListener("mouseenter", () => {
      view.dispatch({ effects: setPollHover.of(this.pollId) });
    });
    el.addEventListener("mouseleave", () => {
      view.dispatch({ effects: clearPollHover.of(null) });
    });
    if (!this.isDraft) {
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const callback = view.state.facet(handleOpenPollMarker);
        callback && callback(this.pollId);
      });
    }
    return el;
  }

  ignoreEvent() {
    return true;
  }
}

const pollMarkerGutterColumn = gutter({
  class: "cm-poll-marker-gutter",
  markers(view) {
    const doc = view.state.doc;
    // Group by line start first: CodeMirror gutters support multiple independent
    // markers at the same position, but RangeSetBuilder requires them added in a
    // single ascending pass. RangeSet#between does NOT guarantee ranges are
    // reported in position order (it's a chain of layers, walked layer-by-layer
    // rather than merged by position), so we can't rely on encounter order even
    // for the line-start grouping itself -- the Map's keys must be sorted below.
    const byLine = new Map();
    view.state.field(pollMarkersField).between(0, doc.length, (from, to, deco) => {
      const lineStart = doc.lineAt(from).from;
      let entries = byLine.get(lineStart);
      if (!entries) byLine.set(lineStart, (entries = []));
      entries.push({ pollId: deco.spec.pollId, isDraft: deco.spec.isDraft, isOpen: deco.spec.isOpen });
    });

    const builder = new RangeSetBuilder();
    const sortedLineStarts = [...byLine.keys()].sort((a, b) => a - b);
    for (const lineStart of sortedLineStarts) {
      const entries = byLine.get(lineStart);
      // Deterministic order (poll ids are auto-incrementing, so this is creation order)
      // rather than whatever order the underlying RangeSet happened to yield.
      entries.sort((a, b) => (a.pollId > b.pollId ? 1 : a.pollId < b.pollId ? -1 : 0));
      for (const { pollId, isDraft, isOpen } of entries) {
        builder.add(lineStart, lineStart, new PollGutterMarker(pollId, isDraft, isOpen));
      }
    }
    return builder.finish();
  },
});

const pollMarkerTheme = EditorView.baseTheme({
  ".cm-poll-marker-gutter": { minWidth: "16px" },
  ".cm-poll-marker-gutter .cm-gutterElement": {
    padding: "0",
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: "2px",
  },
  ".cm-poll-marker-icon": {
    flexShrink: "0",
    width: "13px",
    height: "13px",
    marginLeft: "1px",
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "9px",
    lineHeight: "1",
    fontWeight: "bold",
    cursor: "pointer",
    backgroundColor: "#5861ff",
    color: "white",
  },
  ".cm-poll-marker-draft": {
    backgroundColor: "#9298ff",
    cursor: "default",
  },
  ".cm-poll-marker-open": {
    backgroundColor: "#e5484d",
    boxShadow: "0 0 0 rgba(229, 72, 77, 0.6)",
    animation: "cm-poll-marker-pulse 1.8s ease-in-out infinite",
  },
  "@keyframes cm-poll-marker-pulse": {
    "0%, 100%": { backgroundColor: "#e5484d", boxShadow: "0 0 0 0 rgba(229, 72, 77, 0.6)" },
    "50%": { backgroundColor: "#ff8a80", boxShadow: "0 0 3px 2px rgba(229, 72, 77, 0.35)" },
  },
  ".cm-poll-highlight": {
    backgroundColor: "rgba(88, 97, 255, 0.12)",
  },
  ".cm-poll-hover-highlight": {
    backgroundColor: "rgba(88, 97, 255, 0.25)",
  },
});

////////////////////////////////////////////////////////////////////////////////////////////////////////////
// MARK: Anchor-deletion detection
////////////////////////////////////////////////////////////////////////////////////////////////////////////

// Fires onAnchorRemoved(id) the moment a previously-live poll marker (not the draft) disappears
// from the doc -- e.g. the anchored code gets fully deleted. Decoration.mark's default mapMode
// (TrackDel) already drops a marker from pollMarkersField once its span collapses; this just
// surfaces that moment by diffing the marker id set before/after each transaction.
function pollMarkerRemovalListener(onAnchorRemoved) {
  return EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    const before = new Set();
    update.startState.field(pollMarkersField).between(0, update.startState.doc.length, (_f, _t, deco) => {
      before.add(deco.spec.pollId);
    });
    if (before.size === 0) return;
    const after = new Set();
    update.state.field(pollMarkersField).between(0, update.state.doc.length, (_f, _t, deco) => {
      after.add(deco.spec.pollId);
    });
    for (const id of before) {
      if (id !== DRAFT_POLL_ID && !after.has(id)) onAnchorRemoved(id);
    }
  });
}

////////////////////////////////////////////////////////////////////////////////////////////////////////////
// MARK: Public extension bundle
////////////////////////////////////////////////////////////////////////////////////////////////////////////

export function pollMarkerExtensions(onOpenPollMarker, onAnchorRemoved) {
  return [
    handleOpenPollMarker.of(onOpenPollMarker),
    pollMarkersField,
    pollHoverField,
    pollPanelOpenField,
    pollHighlightDecorations,
    pollMarkerGutterColumn,
    pollMarkerTheme,
    ...(onAnchorRemoved ? [pollMarkerRemovalListener(onAnchorRemoved)] : []),
  ];
}
