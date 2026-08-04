import { StateEffect, StateField } from "@codemirror/state";
import { EditorView, WidgetType, Decoration, ViewPlugin } from "@codemirror/view";

////////////////////////////////////////////////////////////////////////////////////////////////////////////
// MARK: Anchor widget
////////////////////////////////////////////////////////////////////////////////////////////////////////////

// A zero-footprint point widget: the actual popover panel is mounted (by the caller-supplied
// `mount` callback) as an absolutely-positioned child of this widget's root element, so it
// never affects document flow/line height no matter how large the panel is. Because the root
// element is a normal in-flow descendant of .cm-content, it (and the panel inside it) scroll
// with the document natively, in both axes, with no JS required for that part -- only the
// horizontal placement (see positionAnchoredPopover) needs to be computed.
class PollPopoverAnchorWidget extends WidgetType {
  constructor({ key, mount, unmount, getRange }) {
    super();
    this.key = key;
    this._mount = mount;
    this._unmount = unmount;
    this._getRange = getRange;
  }

  eq(other) {
    return this.key === other.key;
  }

  toDOM(view) {
    const anchor = document.createElement("span");
    anchor.className = "cm-poll-popover-anchor";
    // Stashed here (rather than threaded through positionAnchoredPopover's caller) so the
    // reposition plugin can read live [from, to) span info from a plain DOM query, without
    // needing to know how to map an anchor key back to a poll id itself.
    anchor._pollPopoverGetRange = this._getRange;
    this._mount?.(anchor, view);
    return anchor;
  }

  destroy(dom) {
    this._unmount?.(dom);
  }

  ignoreEvent() {
    return true;
  }
}

////////////////////////////////////////////////////////////////////////////////////////////////////////////
// MARK: StateEffect + StateField
////////////////////////////////////////////////////////////////////////////////////////////////////////////

// value: { key, at, getRange, mount, unmount } -- key identifies the popover slot (e.g.
// "create" or "active:<exerciseId>"), `at` is the doc position to anchor to. `getRange`
// (optional) is a `() => {from, to}` getter for the live span the popover should sit beside.
export const showPollPopoverEffect = StateEffect.define();
// value: { key }
export const hidePollPopoverEffect = StateEffect.define();

export const pollPopoversField = StateField.define({
  create: () => Decoration.none,
  update(popovers, tr) {
    popovers = popovers.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(showPollPopoverEffect)) {
        const { key, at, mount, unmount, getRange } = e.value;
        const widget = new PollPopoverAnchorWidget({ key, mount, unmount, getRange });
        popovers = popovers.update({
          filter: (_f, _t, deco) => deco.spec.widget?.key !== key,
          add: [Decoration.widget({ widget, side: 1 }).range(at)],
          sort: true,
        });
      } else if (e.is(hidePollPopoverEffect)) {
        const { key } = e.value;
        popovers = popovers.update({
          filter: (_f, _t, deco) => deco.spec.widget?.key !== key,
        });
      }
    }
    return popovers;
  },
  provide: (f) => EditorView.decorations.from(f),
});

////////////////////////////////////////////////////////////////////////////////////////////////////////////
// MARK: Continuous repositioning
////////////////////////////////////////////////////////////////////////////////////////////////////////////

const MARGIN = 12;

// Right edge (viewport px) of the widest line spanned by `[from, to)`, or null if unavailable
// (e.g. no range, or a line isn't currently rendered because it's outside CM's viewport).
function widestLineRight(view, range) {
  if (!range || range.from == null || range.to == null) return null;
  const doc = view.state.doc;
  const startLine = doc.lineAt(range.from).number;
  const endLine = doc.lineAt(Math.max(range.to, range.from)).number;
  let maxRight = null;
  for (let n = startLine; n <= endLine; n++) {
    const coords = view.coordsAtPos(doc.line(n).to, -1);
    if (coords && (maxRight == null || coords.right > maxRight)) maxRight = coords.right;
  }
  return maxRight;
}

// Positions `panelEl` (a `.poll-popover--anchored`, absolutely positioned relative to
// `anchorEl`) beside the code it's anchored to, and toggles visibility depending on whether
// `anchorEl` is currently within the visible bounds of `scrollerEl`. Horizontally, it sits just
// right of the widest line in `getRange()`'s span, unless that would push it past the editor's
// visible right edge, in which case it's pulled in to fit (overlapping the code).
function positionAnchoredPopover(panelEl, anchorEl, scrollerEl, view, getRange) {
  const anchorRect = anchorEl.getBoundingClientRect();
  const scrollerRect = scrollerEl.getBoundingClientRect();

  // The anchor is a zero-size point at the top of the panel (see .cm-poll-popover-anchor); the
  // panel itself extends downward from there by its own height. Offscreen-ness has to account
  // for that height, or the panel disappears the instant its anchor line scrolls one pixel above
  // the scroller's top -- even though most of the panel may still be visible below it.
  const panelHeight = panelEl.offsetHeight;
  const offscreen =
    anchorRect.top + panelHeight < scrollerRect.top ||
    anchorRect.top > scrollerRect.bottom ||
    anchorRect.right < scrollerRect.left ||
    anchorRect.left > scrollerRect.right;
  panelEl.classList.toggle("poll-popover--offscreen", offscreen);
  if (offscreen) return;

  const panelWidth = panelEl.getBoundingClientRect().width || panelEl.offsetWidth;
  const codeRight = widestLineRight(view, getRange?.()) ?? anchorRect.right;

  const besideCode = codeRight + MARGIN;
  const fitsInEditor = scrollerRect.right - panelWidth - MARGIN;
  const leftViewport = Math.max(Math.min(besideCode, fitsInEditor), scrollerRect.left + MARGIN);
  panelEl.style.left = `${leftViewport - anchorRect.left}px`;
}

// Drives continuous repositioning of every mounted popover anchor: CM's own update() cycle
// (viewport/geometry changes from vertical scrolling or doc edits), plus an explicit scroll
// listener (horizontal-only scrolling doesn't reliably trigger a CM update) and a
// ResizeObserver (pane resizes / window resizes that change the scroller's width).
const pollPopoverRepositionPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.view = view;
      this._scheduled = false;
      this._onScroll = () => this.schedule();
      view.scrollDOM.addEventListener("scroll", this._onScroll, { passive: true });
      this._resizeObserver = new ResizeObserver(() => this.schedule());
      this._resizeObserver.observe(view.scrollDOM);
      this.schedule();
    }

    update(update) {
      if (update.docChanged || update.viewportChanged || update.geometryChanged) {
        this.schedule();
      } else if (update.transactions.some((tr) => tr.effects.some((e) => e.is(showPollPopoverEffect) || e.is(hidePollPopoverEffect)))) {
        this.schedule();
      }
    }

    schedule() {
      if (this._scheduled) return;
      this._scheduled = true;
      requestAnimationFrame(() => {
        this._scheduled = false;
        this.repositionAll();
      });
    }

    repositionAll() {
      const anchors = this.view.dom.querySelectorAll(".cm-poll-popover-anchor");
      for (const anchorEl of anchors) {
        const panelEl = anchorEl.querySelector(".poll-popover--anchored");
        if (panelEl) {
          positionAnchoredPopover(panelEl, anchorEl, this.view.scrollDOM, this.view, anchorEl._pollPopoverGetRange);
        }
      }
    }

    destroy() {
      this.view.scrollDOM.removeEventListener("scroll", this._onScroll);
      this._resizeObserver.disconnect();
    }
  },
);

////////////////////////////////////////////////////////////////////////////////////////////////////////////
// MARK: Public extension bundle
////////////////////////////////////////////////////////////////////////////////////////////////////////////

export function pollPopoverExtensions() {
  return [pollPopoversField, pollPopoverRepositionPlugin];
}
