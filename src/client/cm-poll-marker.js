import { StateEffect, StateField, Facet, RangeSetBuilder } from "@codemirror/state";
import { EditorView, Decoration, GutterMarker, gutter } from "@codemirror/view";

////////////////////////////////////////////////////////////////////////////////////////////////////////////
// MARK: Poll marker position tracking
////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const DRAFT_POLL_ID = "__poll_draft__";

// value: {id, from, to, isDraft}
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
        const { id, from, to, isDraft } = e.value;
        markers = markers.update({
          filter: (_f, _t, deco) => deco.spec.pollId !== id,
          add: [Decoration.mark({ pollId: id, isDraft: !!isDraft }).range(from, to)],
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

// Screen-space rect for a document range [from, to): pinned just past the right edge of the
// widest line it spans (not the editor pane's edge), so an anchored popover lands right next
// to the code instead of far off to the side. Falls back to the editor pane's right edge if
// measurement fails for some reason (e.g., positions off-screen).
export function coordsForRange(view, from, to) {
  const state = view.state;
  const startLine = state.doc.lineAt(from);
  const endLine = state.doc.lineAt(to);
  let maxRight = -Infinity;
  for (let lineNum = startLine.number; lineNum <= endLine.number; lineNum++) {
    const coords = view.coordsAtPos(state.doc.line(lineNum).to);
    if (coords) maxRight = Math.max(maxRight, coords.right);
  }
  const topCoords = view.coordsAtPos(from);
  const bottomCoords = view.coordsAtPos(to) ?? topCoords;
  if (!isFinite(maxRight) || !topCoords) {
    maxRight = view.dom.getBoundingClientRect().right;
  }
  const top = topCoords?.top ?? 0;
  const bottom = bottomCoords?.bottom ?? top + 20;
  return { left: maxRight, right: maxRight, top, bottom, width: 0, height: bottom - top };
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
  constructor(pollId, isDraft) {
    super();
    this.pollId = pollId;
    this.isDraft = isDraft;
  }

  eq(other) {
    return this.pollId === other.pollId && this.isDraft === other.isDraft;
  }

  toDOM(view) {
    const el = document.createElement("div");
    el.className = "cm-poll-marker-icon" + (this.isDraft ? " cm-poll-marker-draft" : "");
    el.textContent = "?";
    el.title = this.isDraft ? "Poll draft (not yet asked)" : "Poll linked to this code — click to view";

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
    // single ascending pass, so we can't add each poll to the builder as we see it.
    const byLine = new Map();
    view.state.field(pollMarkersField).between(0, doc.length, (from, to, deco) => {
      const lineStart = doc.lineAt(from).from;
      let entries = byLine.get(lineStart);
      if (!entries) byLine.set(lineStart, (entries = []));
      entries.push({ pollId: deco.spec.pollId, isDraft: deco.spec.isDraft });
    });

    const builder = new RangeSetBuilder();
    for (const [lineStart, entries] of byLine) {
      // Deterministic order (poll ids are auto-incrementing, so this is creation order)
      // rather than whatever order the underlying RangeSet happened to yield.
      entries.sort((a, b) => (a.pollId > b.pollId ? 1 : a.pollId < b.pollId ? -1 : 0));
      for (const { pollId, isDraft } of entries) {
        builder.add(lineStart, lineStart, new PollGutterMarker(pollId, isDraft));
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
  ".cm-poll-highlight": {
    backgroundColor: "rgba(88, 97, 255, 0.12)",
  },
  ".cm-poll-hover-highlight": {
    backgroundColor: "rgba(88, 97, 255, 0.25)",
  },
});

////////////////////////////////////////////////////////////////////////////////////////////////////////////
// MARK: Public extension bundle
////////////////////////////////////////////////////////////////////////////////////////////////////////////

export function pollMarkerExtensions(onOpenPollMarker) {
  return [
    handleOpenPollMarker.of(onOpenPollMarker),
    pollMarkersField,
    pollHoverField,
    pollPanelOpenField,
    pollHighlightDecorations,
    pollMarkerGutterColumn,
    pollMarkerTheme,
  ];
}
