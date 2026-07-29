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
    const builder = new RangeSetBuilder();
    const doc = view.state.doc;
    const seenLines = new Set();
    view.state.field(pollMarkersField).between(0, doc.length, (from, to, deco) => {
      const lineStart = doc.lineAt(from).from;
      if (seenLines.has(lineStart)) return; // two polls starting on the same line: show just one marker (rare)
      seenLines.add(lineStart);
      builder.add(lineStart, lineStart, new PollGutterMarker(deco.spec.pollId, deco.spec.isDraft));
    });
    return builder.finish();
  },
});

const pollMarkerTheme = EditorView.baseTheme({
  ".cm-poll-marker-gutter": { width: "16px" },
  ".cm-poll-marker-gutter .cm-gutterElement": { padding: "0" },
  ".cm-poll-marker-icon": {
    width: "13px",
    height: "13px",
    marginTop: "3px",
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
