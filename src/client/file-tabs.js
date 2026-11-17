import { GlowTracker, makeExerciseBadge, makeInstructorBadge } from "./instructor-awareness-config.js";

// MARK: FileTabBar
// A strip of closable file tabs. DOM only: the open/active state lives in the controller
// (workspace.js), which pushes it in with setState(). setState never fires callbacks; only real
// user clicks do (onActivate / onClose) -- so the controller can tell "the user picked a file"
// apart from "we're mirroring someone else's tabs".
//
// Tabs that don't fit are moved into a "▾ N more" dropdown at the end of the strip. The active tab
// is always kept visible (it takes the last visible slot if it would otherwise overflow).
export class FileTabBar {
  // getLabel(id) -> {label, title}
  constructor({ containerEl, getLabel, closable = true, onActivate, onClose }) {
    this.containerEl = containerEl;
    this.getLabel = getLabel;
    this.closable = closable;
    this.onActivate = onActivate;
    this.onClose = onClose;
    this.openIds = [];
    this.activeId = null;
    // Student awareness cues: the instructor's file (tint + badge) and files they're typing in (glow).
    this.instructorFileId = null;
    this._glow = new GlowTracker();
    // Files with an active exercise (red "?" badge).
    this.exerciseFileIds = new Set();

    containerEl.classList.add("file-tabs");

    this.stripEl = document.createElement("div");
    this.stripEl.className = "file-tabs-strip";
    containerEl.append(this.stripEl);

    this.overflowWrap = document.createElement("div");
    this.overflowWrap.className = "file-tabs-overflow";
    this.overflowBtn = document.createElement("button");
    this.overflowBtn.className = "file-tabs-overflow-btn";
    this.overflowMenu = document.createElement("div");
    this.overflowMenu.className = "file-tabs-overflow-menu";
    this.overflowMenu.hidden = true;
    this.overflowWrap.append(this.overflowBtn, this.overflowMenu);
    containerEl.append(this.overflowWrap);

    this.overflowBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.overflowMenu.hidden = !this.overflowMenu.hidden;
    });
    document.addEventListener("pointerdown", (e) => {
      if (!this.overflowWrap.contains(e.target)) this.overflowMenu.hidden = true;
    });

    // Re-fit whenever the space around the tabs changes (window resize, panels opening/resizing).
    this._resizeObserver = new ResizeObserver(() => this._layout());
    this._resizeObserver.observe(containerEl.parentElement ?? containerEl);
    // ...and whenever a neighbour (e.g. the historical tab) appears, disappears, or changes size.
    for (const sibling of containerEl.parentElement?.children ?? []) {
      if (sibling !== containerEl) this._resizeObserver.observe(sibling);
    }
    this.render();
  }

  setState({ openIds, activeId }) {
    this.openIds = [...openIds];
    this.activeId = activeId;
    this.render();
  }

  // Re-reads every tab's label (e.g. after a rename).
  refreshLabels() {
    this.render();
  }

  render() {
    this.stripEl.innerHTML = "";
    this.tabEls = new Map();
    for (const id of this.openIds) {
      const tab = this._makeTab(id);
      this.tabEls.set(id, tab);
      this.stripEl.append(tab);
    }
    this._layout();
  }

  // MARK: Badges

  // Marks the tabs of files with an active exercise. Kept across re-renders.
  setExerciseFiles(ids) {
    this.exerciseFileIds = new Set(ids);
    this._applyMarks();
  }

  // MARK: Instructor awareness (student page)

  // Marks the instructor's file's tab (null: none). Kept across re-renders.
  setInstructorFile(id) {
    this.instructorFileId = id;
    this._applyMarks();
  }

  // Glows the file's tab (if open) while the instructor types in it.
  pulseTab(id) {
    if (!this.openIds.includes(id)) return;
    this._glow.pulse(id, () => this._visibleTabFor(id));
  }

  // The file's tab, or the "▾ N more" button if the tab is in the overflow menu.
  _visibleTabFor(id) {
    const tab = this.tabEls?.get(id);
    if (!tab) return null;
    return tab.hidden ? this.overflowBtn : tab;
  }

  // Re-applies the exercise badges, then the instructor's tint + badge (so the person comes last),
  // then any glow -- each on the tab standing in for its file.
  _applyMarks() {
    for (const el of this.containerEl.querySelectorAll(".instructor-here")) el.classList.remove("instructor-here");
    for (const el of this.containerEl.querySelectorAll(".instructor-badge, .exercise-badge")) el.remove();
    this.overflowBtn.classList.remove(this._glow.className);
    for (const tab of this.tabEls?.values() ?? []) tab.classList.remove(this._glow.className);

    // On a tab, badges go before the close button.
    const addBadge = (el, badge) => {
      const close = el.querySelector(".file-tab-close");
      if (close) close.before(badge);
      else el.append(badge);
    };
    const exerciseEls = new Set();
    for (const id of this.exerciseFileIds) {
      if (!this.openIds.includes(id)) continue;
      const el = this._visibleTabFor(id);
      if (el) exerciseEls.add(el);
    }
    for (const el of exerciseEls) addBadge(el, makeExerciseBadge({ aggregate: el === this.overflowBtn }));

    const el = this.instructorFileId != null ? this._visibleTabFor(this.instructorFileId) : null;
    if (el) {
      el.classList.add("instructor-here");
      addBadge(el, makeInstructorBadge());
    }
    for (const id of this._glow.glowingKeys()) this._visibleTabFor(id)?.classList.add(this._glow.className);
  }

  _makeTab(id) {
    const { label, title } = this.getLabel(id);
    const tab = document.createElement("div");
    tab.className = "code-tab file-tab";
    tab.classList.toggle("selected", id === this.activeId);
    tab.title = title;
    tab.dataset.fileId = id;

    const text = document.createElement("span");
    text.className = "code-tab-text";
    text.textContent = label;
    tab.append(text);
    tab.addEventListener("click", () => this.onActivate?.(id));

    if (this.closable) {
      const close = document.createElement("button");
      close.className = "file-tab-close";
      close.setAttribute("aria-label", `Close ${label}`);
      close.textContent = "×";
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        this.onClose?.(id);
      });
      tab.append(close);
      // Middle-click closes, like most editors.
      tab.addEventListener("auxclick", (e) => {
        if (e.button === 1) this.onClose?.(id);
      });
    }
    return tab;
  }

  // The width the tabs could take up: the bar is sized to its content, so its own width says
  // nothing about the free space -- use its parent's width minus whatever else sits in it (e.g. the
  // historical tab).
  _availableWidth() {
    const parent = this.containerEl.parentElement;
    if (!parent) return this.containerEl.clientWidth;
    const style = getComputedStyle(parent);
    let width = parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    for (const sibling of parent.children) {
      if (sibling !== this.containerEl && !sibling.hidden) width -= sibling.getBoundingClientRect().width;
    }
    return width;
  }

  _layout() {
    this._fitTabs();
    // Again now that we know which tabs overflowed (and the overflow button's label is final).
    this._applyMarks();
  }

  // Decides which tabs fit, hiding the rest and listing them in the overflow menu.
  _fitTabs() {
    const tabs = this.openIds.map((id) => [id, this.tabEls.get(id)]);
    for (const [, el] of tabs) el.hidden = false;
    this.overflowWrap.hidden = true;
    // Measure with the badges in place, so a badged tab isn't squeezed.
    this._applyMarks();
    if (tabs.length === 0) return;

    const available = this._availableWidth();
    // Fractional widths: rounded offsetWidths can add up to a pixel or two more than the real total.
    const widths = tabs.map(([, el]) => el.getBoundingClientRect().width);
    const total = widths.reduce((a, b) => a + b, 0);
    if (total <= available + 0.5) return;

    // Leave room for the overflow button (labelled for the worst case before measuring it), then
    // fill greedily in order.
    this.overflowBtn.textContent = `▾ ${tabs.length} more`;
    this.overflowWrap.hidden = false;
    const room = available - this.overflowWrap.getBoundingClientRect().width;
    const visible = new Set();
    let used = 0;
    for (let i = 0; i < tabs.length; i++) {
      if (used + widths[i] > room) break;
      used += widths[i];
      visible.add(tabs[i][0]);
    }
    // Keep the active tab visible: evict tabs from the end until it fits.
    const activeIndex = tabs.findIndex(([id]) => id === this.activeId);
    if (activeIndex >= 0 && !visible.has(this.activeId)) {
      const visibleIds = [...visible];
      while (visibleIds.length > 0 && used + widths[activeIndex] > room) {
        const evicted = visibleIds.pop();
        visible.delete(evicted);
        used -= widths[tabs.findIndex(([id]) => id === evicted)];
      }
      visible.add(this.activeId);
    }

    const hidden = tabs.filter(([id]) => !visible.has(id));
    for (const [, el] of hidden) el.hidden = true;
    this.overflowBtn.textContent = `▾ ${hidden.length} more`;
    this.overflowMenu.innerHTML = "";
    for (const [id] of hidden) {
      const { label, title } = this.getLabel(id);
      const item = document.createElement("button");
      item.className = "file-tabs-overflow-item";
      item.textContent = label;
      item.title = title;
      item.addEventListener("click", () => {
        this.overflowMenu.hidden = true;
        this.onActivate?.(id);
      });
      this.overflowMenu.append(item);
    }
  }
}
