import { ChangeSet, Text } from "@codemirror/state";

// Per-lecture cache of the live document plus the change history needed to cheaply resolve
// version-block/poll anchor positions. Replaces the old pattern of replaying every
// InstructorChange from scratch on every read (see the plan this implements). Keyed by
// lectureId; each value is a Promise so concurrent callers for a not-yet-cached lecture share
// one hydration instead of each independently paying the full replay cost (thundering herd).
const cache = new Map();

// Every write into `cache` goes through here so a rejected promise (an out-of-order edit
// detected mid-chain, or a DB error during hydration) can never get stuck permanently: once the
// promise settles rejected, if it's still the current entry for this lecture, drop it so the
// next caller re-hydrates fresh from the DB. If something newer has since been chained onto the
// same broken lineage, that promise is itself rejected too (rejections propagate through
// .then() chains) and cleans itself up in turn when it settles.
function setCache(lectureId, promise) {
  cache.set(lectureId, promise);
  promise.catch(() => {
    if (cache.get(lectureId) === promise) cache.delete(lectureId);
  });
  return promise;
}

async function hydrate(lecture) {
  const changes = await lecture.getInstructorChanges({
    attributes: ["change", "change_number"],
    order: ["change_number"],
  });
  let doc = Text.empty;
  const changeLog = [];
  for (const { change } of changes) {
    const cs = ChangeSet.fromJSON(JSON.parse(change));
    doc = cs.apply(doc);
    changeLog.push(cs);
  }
  return { doc, docVersion: changeLog.length, changeLog, versionBlockAnchors: new Map(), pollAnchors: new Map() };
}

// Synchronous get-or-create: returns the current (pending or resolved) promise for this
// lecture, hydrating from the DB if this is the first access. Synchronous up to the point of
// returning -- the actual hydration work happens inside the returned promise.
function ensureHydrating(lecture) {
  let current = cache.get(lecture.id);
  if (!current) current = setCache(lecture.id, hydrate(lecture));
  return current;
}

export async function getCachedDoc(lecture) {
  const entry = await ensureHydrating(lecture);
  return { doc: entry.doc, docVersion: entry.docVersion };
}

// Fully synchronous (no await) -- called directly from the INSTRUCTOR_EDIT socket handler,
// which is itself synchronous end-to-end today. Because every cache mutation (this function,
// and the anchor lookups below) reads the current promise and re-stores a chained one
// synchronously with no await in between, an HTTP handler's read of the cache can never observe
// a partially-applied state -- see the plan's correctness argument for the docVersion invariant.
export function applyChangeToCache(lectureId, { id, changes }) {
  const current = cache.get(lectureId);
  if (!current) return; // not hydrated yet -- next read will hydrate fresh from the DB, correct by construction

  setCache(
    lectureId,
    current.then((entry) => {
      if (entry.docVersion !== id) {
        throw new Error(`Doc cache out of sync for lecture ${lectureId}: expected change ${entry.docVersion}, got ${id}`);
      }

      const cs = ChangeSet.fromJSON(changes);
      const doc = cs.apply(entry.doc);
      const changeLog = [...entry.changeLog, cs];

      const versionBlockAnchors = new Map();
      for (const [blockId, { from }] of entry.versionBlockAnchors) {
        const mapped = cs.mapPos(from);
        versionBlockAnchors.set(blockId, { from: mapped, to: mapped });
      }

      const pollAnchors = new Map();
      for (const [exerciseId, { from, to }] of entry.pollAnchors) {
        const newFrom = cs.mapPos(from, 1);
        const newTo = cs.mapPos(to, -1);
        if (newTo > newFrom) pollAnchors.set(exerciseId, { from: newFrom, to: newTo });
        // else: anchor's underlying code was entirely deleted by this edit -- drop it, matching
        // the existing "report no anchor" behavior once the anchored code is gone.
      }

      return { doc, docVersion: entry.docVersion + 1, changeLog, versionBlockAnchors, pollAnchors };
    }),
  );
}

export function invalidateCachedDoc(lectureId) {
  cache.delete(lectureId);
}

// Returns the version block's current live position, registering it in the cache on first
// lookup via a *bounded* replay (only the changes since the block's own anchor_change_number,
// not the whole lecture).
export function getCachedVersionBlockAnchor(lecture, blockId, anchorPos, anchorChangeNumber) {
  const current = ensureHydrating(lecture);
  const next = current.then((entry) => {
    if (entry.versionBlockAnchors.has(blockId)) return entry;
    let from = anchorPos;
    for (let i = anchorChangeNumber; i < entry.docVersion; i++) from = entry.changeLog[i].mapPos(from);
    const versionBlockAnchors = new Map(entry.versionBlockAnchors);
    versionBlockAnchors.set(blockId, { from, to: from });
    return { ...entry, versionBlockAnchors };
  });
  setCache(lecture.id, next);
  return next.then((entry) => entry.versionBlockAnchors.get(blockId));
}

// Same idea for a poll's code anchor -- returns null if the anchored code has since been
// entirely deleted (matching the existing "report no anchor" behavior).
export function getCachedPollAnchor(lecture, exerciseId, anchorFrom, anchorTo, anchorChangeNumber) {
  const current = ensureHydrating(lecture);
  const next = current.then((entry) => {
    if (entry.pollAnchors.has(exerciseId)) return entry;
    let from = anchorFrom;
    let to = anchorTo;
    for (let i = anchorChangeNumber; i < entry.docVersion; i++) {
      from = entry.changeLog[i].mapPos(from, 1);
      to = entry.changeLog[i].mapPos(to, -1);
    }
    if (to <= from) return entry; // fully deleted -- nothing to register
    const pollAnchors = new Map(entry.pollAnchors);
    pollAnchors.set(exerciseId, { from, to });
    return { ...entry, pollAnchors };
  });
  setCache(lecture.id, next);
  return next.then((entry) => entry.pollAnchors.get(exerciseId) ?? null);
}

export function unregisterVersionBlockAnchor(lectureId, blockId) {
  const current = cache.get(lectureId);
  if (!current) return;
  setCache(
    lectureId,
    current.then((entry) => {
      if (!entry.versionBlockAnchors.has(blockId)) return entry;
      const versionBlockAnchors = new Map(entry.versionBlockAnchors);
      versionBlockAnchors.delete(blockId);
      return { ...entry, versionBlockAnchors };
    }),
  );
}
