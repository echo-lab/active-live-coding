import { StateEffect, StateField } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { setInstructorSelection } from "./cm-extensions.js";
import { INSTRUCTOR_AWARENESS, restartFlash } from "./instructor-awareness-config.js";

// MARK: Instructor awareness (student editor)
// Edge bars at the top/bottom of a student's read-only editor pointing at the instructor when
// they're scrolled out of view: where their cursor is (offscreen.showCursor), and a glow when they
// edit off-screen (offscreen.flashOnEdit). Clicking a bar scrolls to the instructor.
//
// Whether the bars apply at all is up to the caller's isActive() (StudentWorkspace: cues are on
// and this is the instructor's active file). Alternatively, while shouldAutoScroll() holds, the
// editor itself scrolls (just enough) to keep the instructor's cursor / latest edit in view.
// Dispatch refreshAwarenessEffect when either may have changed.

// Instructor activity somewhere other than the main doc (e.g. a variant inside a version block):
// value is a doc position.
export const instructorActivityEffect = StateEffect.define();
// Re-evaluate isActive() and the bars.
export const refreshAwarenessEffect = StateEffect.define();

// The instructor's cursor head in this doc, or null if they aren't in it.
export const instructorHeadField = StateField.define({
  create: () => null,
  update(head, tr) {
    if (head != null && tr.docChanged) head = tr.changes.mapPos(head);
    for (const e of tr.effects) {
      if (!e.is(setInstructorSelection)) continue;
      const h = e.value.head;
      head = h < 0 || h > tr.newDoc.length ? null : h;
    }
    return head;
  },
});

// Where an update says the instructor just did something: the start of their first change (the
// student's main doc is read-only, so every doc change is the instructor's), or an explicit
// instructorActivityEffect.
function activityPos(update) {
  for (const tr of update.transactions) {
    for (const e of tr.effects) if (e.is(instructorActivityEffect)) return e.value;
  }
  if (!update.docChanged) return null;
  let pos = null;
  update.changes.iterChangedRanges((_fromA, _toA, fromB) => {
    if (pos == null) pos = fromB;
  });
  return pos;
}

export function instructorAwareness({ isActive, shouldAutoScroll = () => false }) {
  const plugin = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.bars = {
          above: this._makeBar("above", "↑ Instructor"),
          below: this._makeBar("below", "↓ Instructor"),
        };
        this.lastActivityPos = null;
        this.lastActivityAt = 0;
        this.glowTimer = null;
        this.glowing = null; // "above" | "below" | null
        this._onScroll = () => this.schedule();
        view.scrollDOM.addEventListener("scroll", this._onScroll, { passive: true });
        this.schedule();
      }

      _makeBar(dir, label) {
        const bar = document.createElement("div");
        bar.className = `cm-instructor-edge ${dir}`;
        bar.hidden = true;
        const pill = document.createElement("button");
        pill.type = "button";
        pill.className = "cm-instructor-edge-pill";
        pill.textContent = label;
        pill.title = "Scroll to where the instructor is";
        pill.addEventListener("mousedown", (e) => e.preventDefault());
        pill.addEventListener("click", () => this.scrollToInstructor());
        bar.append(pill);
        this.view.dom.append(bar);
        return bar;
      }

      update(update) {
        const pos = activityPos(update);
        if (pos != null) {
          this.lastActivityPos = pos;
          this.lastActivityAt = Date.now();
          this.pendingFlash = true;
        }
        const headMoved = update.startState.field(instructorHeadField, false) !== update.state.field(instructorHeadField, false);
        const refreshed = update.transactions.some((tr) => tr.effects.some((e) => e.is(refreshAwarenessEffect)));
        if ((pos != null || headMoved || refreshed) && shouldAutoScroll()) {
          // Can't dispatch mid-update; "nearest" is a no-op while the target is already on screen.
          queueMicrotask(() => {
            if (this.view.dom.isConnected && shouldAutoScroll()) this.scrollToInstructor("nearest");
          });
        }
        this.schedule();
      }

      // The position the bars point to: the instructor's cursor, else (if showCursor is off, or
      // they have none) a recent edit.
      _targetPos() {
        const head = this.view.state.field(instructorHeadField, false);
        if (INSTRUCTOR_AWARENESS.offscreen.showCursor && head != null) return head;
        const recent = Date.now() - this.lastActivityAt < INSTRUCTOR_AWARENESS.flashFadeMs;
        return recent ? this.lastActivityPos : null;
      }

      schedule() {
        this.view.requestMeasure({
          key: this,
          read: (view) => {
            if (!isActive() || !view.dom.isConnected || view.scrollDOM.clientHeight === 0) return null;
            const rect = view.scrollDOM.getBoundingClientRect();
            const where = (pos) => {
              if (pos == null || pos > view.state.doc.length) return null;
              const block = view.lineBlockAt(pos);
              const top = view.documentTop + block.top;
              const bottom = view.documentTop + block.bottom;
              if (bottom <= rect.top + 2) return "above";
              if (top >= rect.bottom - 2) return "below";
              return "visible";
            };
            return { target: where(this._targetPos()), activity: this.pendingFlash ? where(this.lastActivityPos) : null };
          },
          write: (m) => {
            const flash = this.pendingFlash;
            this.pendingFlash = false;
            if (!m) {
              this._setGlow(null);
              for (const bar of Object.values(this.bars)) bar.hidden = true;
              return;
            }
            if (flash && INSTRUCTOR_AWARENESS.offscreen.flashOnEdit) {
              if (m.activity === "above" || m.activity === "below") this._setGlow(m.activity);
              else if (m.activity === "visible") this._setGlow(null);
            }
            // A bar shows while it points at the instructor's cursor, or while it's glowing.
            for (const [dir, bar] of Object.entries(this.bars)) bar.hidden = m.target !== dir && this.glowing !== dir;
          },
        });
      }

      // Flashes `dir`'s bar (it fades back over flashFadeMs, restarting on each call); null stops
      // at once.
      _setGlow(dir) {
        clearTimeout(this.glowTimer);
        for (const [d, bar] of Object.entries(this.bars)) {
          if (d === dir) restartFlash(bar, "active-edit");
          else bar.classList.remove("active-edit");
        }
        this.glowing = dir;
        if (!dir) return;
        this.glowTimer = setTimeout(() => {
          this.glowing = null;
          for (const bar of Object.values(this.bars)) bar.classList.remove("active-edit");
          this.schedule(); // an edit-only bar (no cursor) goes away again
        }, INSTRUCTOR_AWARENESS.flashFadeMs);
      }

      scrollToInstructor(y = "center") {
        const pos = this._targetPos() ?? this.lastActivityPos;
        if (pos == null || pos > this.view.state.doc.length) return;
        this.view.dispatch({ effects: EditorView.scrollIntoView(pos, { y, yMargin: 40 }) });
      }

      destroy() {
        clearTimeout(this.glowTimer);
        this.view.scrollDOM.removeEventListener("scroll", this._onScroll);
        for (const bar of Object.values(this.bars)) bar.remove();
      }
    },
  );
  return [instructorHeadField, plugin];
}
