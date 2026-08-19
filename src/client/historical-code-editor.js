import { EditorView } from "codemirror";
import { EditorState, Text } from "@codemirror/state";
import { basicExtensions, capLength } from "./cm-extensions.js";
import { scrollIntoViewAccurate } from "./code-editors.js";
import {
  addVersionBlockEffect,
  versionBlockExtensions,
  VersionBlockWidget,
} from "./cm-version-widget.js";
import {
  addPollMarkerEffect,
  getPollMarkerPosition,
  pollMarkerExtensions,
} from "./cm-poll-marker.js";
import { showPollPopoverEffect, hidePollPopoverEffect, pollPopoverExtensions } from "./cm-poll-popover.js";

// A frozen, read-only snapshot of the instructor's editor at some point in the past, showing
// just the ONE activity (poll or code exercise) whose live anchor is gone. Reuses the same
// CodeMirror decoration systems as the live editors (poll markers/popovers, version block
// widgets) -- none of them are coupled to sockets or live doc-version tracking, so they work
// unmodified against a static doc. No update listener, no broadcasting: nothing here is ever
// mutated after construction.
export class HistoricalCodeEditor {
  constructor({ node, doc }) {
    const state = EditorState.create({
      doc: Text.of(doc),
      extensions: [
        ...basicExtensions,
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
        capLength,
        ...versionBlockExtensions(),
        ...pollMarkerExtensions(null),
        ...pollPopoverExtensions(),
      ],
    });
    this.view = new EditorView({ state, parent: node });
  }

  // Places a (non-interactive-click, since no onOpenPollMarker callback is wired) poll marker at
  // the given historical position -- the caller is expected to open the appropriate active/
  // complete popover itself right after, since there's no live exercise-open/close lifecycle to
  // react to. `isOpen` drives the same "still live" gutter styling as the live editors (see
  // code-editors.js); `scroll: false` lets a caller re-dispatch (e.g. once the poll finishes)
  // without re-triggering the scroll-into-view animation.
  renderPollMarker({ id, from, to, isOpen = false, scroll = true }) {
    this.view.dispatch({
      effects: addPollMarkerEffect.of({ id, from, to, isDraft: false, isOpen }),
    });
    if (scroll) scrollIntoViewAccurate(this.view, () => from);
  }

  // Places a read-only VersionBlockWidget (all its variants, switchable but not editable) at
  // the given historical position.
  renderVersionBlock({ from, variants }) {
    const widget = new VersionBlockWidget({
      versionBlockId: "historical",
      variants,
      view: this.view,
      readOnly: true,
    });
    this.view.dispatch({
      effects: addVersionBlockEffect.of({ from, to: from, widget }),
    });
    scrollIntoViewAccurate(this.view, () => from);
  }

  getPollAnchorPosition(id) {
    const { from } = getPollMarkerPosition(this.view.state, id);
    return from;
  }

  getPollAnchorRange(id) {
    const { from, to } = getPollMarkerPosition(this.view.state, id);
    return from == null ? null : { from, to };
  }

  showPollPopover({ key, at, getRange, mount, unmount }) {
    this.view.dispatch({ effects: showPollPopoverEffect.of({ key, at, getRange, mount, unmount }) });
  }

  hidePollPopover(key) {
    this.view.dispatch({ effects: hidePollPopoverEffect.of({ key }) });
  }

  destroy() {
    this.view.destroy();
  }
}
