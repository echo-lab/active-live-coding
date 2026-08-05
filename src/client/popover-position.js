// Positions a floating popover to the side of an anchor rect (right by default, flipping to
// the left if there's no room) rather than above/below it, so it doesn't cover the content the
// user is looking at. Expects `rootEl` to already contain a `.poll-popover-arrow` element.
export function positionPopover(rootEl, anchorRect, { margin = 12 } = {}) {
  // Render off-screen first so we can measure its natural size before placing it.
  rootEl.style.visibility = "hidden";
  rootEl.style.left = "0px";
  rootEl.style.top = "0px";

  requestAnimationFrame(() => {
    if (!rootEl.isConnected) return; // Closed before the frame fired.
    const rect = rootEl.getBoundingClientRect();

    const fitsRight = anchorRect.right + margin + rect.width <= window.innerWidth - margin;
    const side = fitsRight ? "right" : "left";
    let left = side === "right"
      ? anchorRect.right + margin
      : anchorRect.left - margin - rect.width;
    left = Math.max(left, margin);
    left = Math.min(left, window.innerWidth - rect.width - margin);

    let top = anchorRect.top;
    top = Math.min(top, window.innerHeight - rect.height - margin);
    top = Math.max(top, margin);

    rootEl.style.left = `${left}px`;
    rootEl.style.top = `${top}px`;

    const arrowEl = rootEl.querySelector(".poll-popover-arrow");
    arrowEl.classList.remove("poll-popover-arrow--left", "poll-popover-arrow--right");
    // side === "right" means the popover sits to the right of the anchor, so the arrow
    // points left (back at the anchor) and lives on the popover's left edge, and vice versa.
    arrowEl.classList.add(side === "right" ? "poll-popover-arrow--left" : "poll-popover-arrow--right");
    const anchorCenterY = anchorRect.top + anchorRect.height / 2;
    const arrowTop = Math.min(Math.max(anchorCenterY - top - 7, 12), rect.height - 26);
    // const arrowTop = Math.min(Math.max(anchorCenterY - top - 7, 12), rect.height - 40);
    arrowEl.style.top = `${arrowTop}px`;

    rootEl.style.visibility = "visible";
  });
}
