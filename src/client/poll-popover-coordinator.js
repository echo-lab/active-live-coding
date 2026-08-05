// Ensures at most one poll popover (create/active/complete, either role) is open at a time --
// opening any of them closes whichever one was already open.
export class PollPopoverCoordinator {
  constructor() {
    this._current = null;
  }

  notifyOpening(popover) {
    if (this._current && this._current !== popover) this._current.close();
    this._current = popover;
  }

  notifyClosed(popover) {
    if (this._current === popover) this._current = null;
  }
}
