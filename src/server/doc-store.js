import { ChangeSet, Text } from "@codemirror/state";
import { db } from "./database.js";
import { Document, DocumentChangeBatch, encodeChangeBatch } from "./models.js";
import { SOCKET_MESSAGE_TYPE } from "../shared-constants.js";

// MARK: Overview
// In-memory store for every live document (lecture files + variants). The DB's Document row holds
// only the latest SNAPSHOT; this module is the source of truth while a document is being edited:
//
//   - Changes stream in over the socket and are applied synchronously to the in-memory text
//     (applyChange). They're also kept in `pending` until flushed.
//   - Every FLUSH_INTERVAL_MS, flushAll() writes, per dirty document and in ONE transaction, the new
//     snapshot (content + version + anchors) and a DocumentChangeBatch holding the raw pending
//     changes. Clients are then told the doc is durable up to that version (DOC_PERSISTED).
//   - Reads (getDocSnapshot, getAnchors) are served from memory. On a miss we hydrate from the
//     snapshot row alone -- the change log is never read while serving. That's safe because
//     `pending` lives inside the cache entry, and an entry is only evicted once it's clean.
//   - Entries idle (not read or written) for IDLE_EVICT_MS are dropped after they're flushed.
//
// Anchors (version-block positions, poll ranges) are tracked here too: mapped through every applied
// change and persisted as JSON with the snapshot, so they never need a change-log replay either.
//
// NOTE: assumes a SINGLE server process (or, later, one process per lecture shard).

export const FLUSH_INTERVAL_MS = 15 * 1000;
export const IDLE_EVICT_MS = 10 * 60 * 1000;
// How many recent ChangeSets to keep per doc, ONLY for mapping a just-created anchor forward when
// the instructor's edits overtook the HTTP request that registers it (socket vs. HTTP race). Not
// used for client catch-up -- clients that fall behind just re-fetch the whole doc.
const RECENT_CHANGES_CAP = 1000;

export function lectureRoom(sessionId) {
  return `lecture-${sessionId}`;
}

// Only sockets verified as the lecture's instructor (JOIN_SESSION with role "instructor") join this
// room -- for messages students shouldn't see, e.g. other students' submissions.
export function instructorRoom(sessionId) {
  return `lecture-${sessionId}-instructor`;
}

let io = null;
let flushTimer = null;

export function initDocStore(socketServer) {
  io = socketServer;
  if (!flushTimer) {
    flushTimer = setInterval(() => {
      flushAll({ evictIdle: true }).catch((err) => console.error("Periodic doc flush failed:", err));
    }, FLUSH_INTERVAL_MS);
  }
}

// MARK: Entries
// docId -> Entry. `state` is null until hydration finishes; changes that arrive before then are
// queued (in order) and applied as soon as it does.
const entries = new Map();

class Entry {
  constructor(docId) {
    this.docId = docId;
    this.state = null;
    this.queued = [];
    this.ready = null; // Promise<state>
    this.flushChain = Promise.resolve(true); // serializes flushes of this doc
    this.lastTouched = Date.now();
  }
}

function emptyAnchors() {
  return { versionBlocks: new Map(), polls: new Map(), pending: [] };
}

function serializeAnchors(anchors) {
  return JSON.stringify({
    versionBlocks: Object.fromEntries([...anchors.versionBlocks].map(([id, pos]) => [id, { pos }])),
    polls: Object.fromEntries(anchors.polls),
    pending: anchors.pending,
  });
}

function deserializeAnchors(json) {
  const anchors = emptyAnchors();
  if (!json) return anchors;
  const parsed = JSON.parse(json);
  for (const [id, { pos }] of Object.entries(parsed.versionBlocks ?? {})) anchors.versionBlocks.set(Number(id), pos);
  for (const [id, range] of Object.entries(parsed.polls ?? {})) anchors.polls.set(Number(id), range);
  anchors.pending = parsed.pending ?? [];
  return anchors;
}

async function hydrate(entry) {
  const row = await Document.findByPk(entry.docId);
  if (!row) throw new Error(`Document #${entry.docId} not found`);
  entry.state = {
    lectureId: row.LectureSessionId,
    variantId: row.VariantId, // null for files
    text: Text.of(row.content.split("\n")),
    version: row.version,
    persistedVersion: row.version,
    pending: [],
    recent: [],
    recentBase: row.version,
    anchors: deserializeAnchors(row.anchors),
    anchorsDirty: false,
    outOfSync: false,
  };
  const queued = entry.queued;
  entry.queued = [];
  for (const { msg, onResult } of queued) onResult?.(applyToState(entry, msg));
  return entry.state;
}

function getEntry(docId) {
  docId = Number(docId);
  let entry = entries.get(docId);
  if (!entry) {
    entry = new Entry(docId);
    entries.set(docId, entry);
    entry.ready = hydrate(entry).catch((err) => {
      // Never leave a broken entry behind -- the next access retries from the DB.
      if (entries.get(docId) === entry) entries.delete(docId);
      if (entry.queued.length > 0) {
        console.error(`Dropped ${entry.queued.length} change(s) for document #${docId}: hydration failed`);
        for (const { onResult } of entry.queued) onResult?.({ ok: false, reason: "error" });
        entry.queued = [];
      }
      throw err;
    });
  }
  entry.lastTouched = Date.now();
  return entry;
}

async function getState(docId) {
  const entry = getEntry(docId);
  return entry.state ?? (await entry.ready);
}

// MARK: Applying changes

function reportOutOfSync(entry, error) {
  const state = entry.state;
  if (state.outOfSync) return; // report once per episode, not once per subsequent keystroke
  state.outOfSync = true;
  console.warn(`Document #${entry.docId} out of sync: ${error}`);
  io?.to(lectureRoom(state.lectureId)).emit(SOCKET_MESSAGE_TYPE.INSTRUCTOR_OUT_OF_SYNC, {
    sessionId: state.lectureId,
    docId: entry.docId,
    error,
  });
}

// Returns {ok: true} if the change was applied, else {ok: false, reason}. A change must apply on top
// of exactly the current version. An older `id` is NOT a duplicate (socket.io never re-sends client
// emits): it means the sender was built on a stale copy -- typically a second tab/window editing the
// same lecture -- and applying it would clobber newer text. The caller fences that sender.
function applyToState(entry, { id, changes, ts }) {
  const state = entry.state;
  if (id < state.version) return { ok: false, reason: "stale" };
  if (id > state.version) {
    reportOutOfSync(entry, `Expected change #${state.version} but got #${id}`);
    return { ok: false, reason: "gap" };
  }

  let cs;
  try {
    cs = ChangeSet.fromJSON(changes);
    state.text = cs.apply(state.text);
  } catch (error) {
    reportOutOfSync(entry, `Could not apply change #${id}: ${error.message}`);
    return { ok: false, reason: "error" };
  }
  state.version++;
  state.outOfSync = false;
  state.pending.push({ id, changes, ts: ts ?? Date.now() });

  state.recent.push(cs);
  if (state.recent.length > RECENT_CHANGES_CAP) {
    state.recent.shift();
    state.recentBase++;
  }

  mapActiveAnchors(state.anchors, cs);
  activateReadyPendingAnchors(state);
  return { ok: true };
}

// Applies one client change ({id, changes, ts}, where `id` is the doc version it applies on top
// of), then calls onResult({ok, reason}). Synchronous when the doc is already in memory, which
// keeps per-doc ordering trivially correct: socket.io delivers one client's messages in order, and
// nothing awaits in between. While the doc is hydrating, changes (and their callbacks) queue up and
// run in arrival order once it's ready.
export function applyChange(docId, msg, onResult = null) {
  const entry = getEntry(docId);
  if (!entry.state) {
    entry.queued.push({ msg, onResult });
    return;
  }
  onResult?.(applyToState(entry, msg));
}

// Server-originated full replace (e.g. seeding a variant with a student's answer). Returns the
// new version.
export async function setContent(docId, content) {
  const state = await getState(docId);
  const entry = entries.get(Number(docId));
  const cs = ChangeSet.of([{ from: 0, to: state.text.length, insert: content }], state.text.length);
  applyToState(entry, { id: state.version, changes: cs.toJSON(), ts: Date.now() });
  return state.version;
}

// MARK: Variant -> document lookup
// VARIANT_EDIT messages carry a variantId, not a docId. Memoized; while a lookup is in flight, that
// variant's changes queue up so they're still applied in order.
const variantDocIds = new Map();
const variantWaiting = new Map();

export function rememberVariantDoc(variantId, docId) {
  variantDocIds.set(Number(variantId), Number(docId));
}

export async function resolveVariantDoc(variantId) {
  variantId = Number(variantId);
  if (variantDocIds.has(variantId)) return variantDocIds.get(variantId);
  const row = await Document.findOne({ where: { VariantId: variantId }, attributes: ["id"] });
  if (!row) throw new Error(`No document for variant #${variantId}`);
  rememberVariantDoc(variantId, row.id);
  return row.id;
}

export function applyVariantChange(variantId, msg, onResult = null) {
  variantId = Number(variantId);
  const docId = variantDocIds.get(variantId);
  if (docId != null) return applyChange(docId, msg, onResult);

  const waiting = variantWaiting.get(variantId);
  if (waiting) {
    waiting.push({ msg, onResult });
    return;
  }
  variantWaiting.set(variantId, [{ msg, onResult }]);
  resolveVariantDoc(variantId)
    .then((resolved) => {
      const pending = variantWaiting.get(variantId) ?? [];
      variantWaiting.delete(variantId);
      for (const p of pending) applyChange(resolved, p.msg, p.onResult);
    })
    .catch((err) => {
      const pending = variantWaiting.get(variantId) ?? [];
      variantWaiting.delete(variantId);
      console.error(`Dropped variant #${variantId} change(s):`, err.message);
      for (const p of pending) p.onResult?.({ ok: false, reason: "error" });
    });
}

// MARK: Reads

// {text: Text, version, persistedVersion} -- latest content, including not-yet-flushed changes.
export async function getDocSnapshot(docId) {
  const { text, version, persistedVersion } = await getState(docId);
  return { text, version, persistedVersion };
}

// Latest {content, version} for a Document row the caller already loaded: uses the live entry if
// one exists (it may have unflushed changes), else the row itself (which is then current, since
// only live entries can hold unflushed changes). Avoids hydrating every variant on every join.
export async function currentContent(row) {
  if (entries.has(row.id)) {
    const { text, version } = await getState(row.id);
    return { content: text.toString(), version };
  }
  return { content: row.content, version: row.version };
}

// Current anchor positions for a doc: {versionBlocks: Map<blockId, pos>, polls: Map<exId, {from, to}>}.
// A poll whose anchored code was entirely deleted is absent. Anchors registered for a version the
// doc hasn't reached yet (in flight) are reported at their raw position, clamped to the doc.
export async function getAnchors(docId) {
  const state = await getState(docId);
  const versionBlocks = new Map(state.anchors.versionBlocks);
  const polls = new Map(state.anchors.polls);
  const clamp = (p) => Math.min(Math.max(p, 0), state.text.length);
  for (const a of state.anchors.pending) {
    if (a.type === "versionBlock") versionBlocks.set(a.id, clamp(a.pos));
    else polls.set(a.id, { from: clamp(a.from), to: clamp(a.to) });
  }
  return { versionBlocks, polls };
}

// MARK: Anchors

function mapActiveAnchors(anchors, cs) {
  for (const [id, pos] of anchors.versionBlocks) anchors.versionBlocks.set(id, cs.mapPos(pos));
  for (const [id, { from, to }] of anchors.polls) {
    // assoc=1 for from / -1 for to: edits landing exactly on a boundary are excluded from the
    // range, matching CodeMirror's non-inclusive Decoration.mark semantics (cm-poll-marker.js).
    const newFrom = cs.mapPos(from, 1);
    const newTo = cs.mapPos(to, -1);
    if (newTo > newFrom) anchors.polls.set(id, { from: newFrom, to: newTo });
    else anchors.polls.delete(id); // anchored code entirely deleted
  }
}

function activateAnchor(anchors, a) {
  if (a.type === "versionBlock") anchors.versionBlocks.set(a.id, a.pos);
  else if (a.to > a.from) anchors.polls.set(a.id, { from: a.from, to: a.to });
}

function activateReadyPendingAnchors(state) {
  const { anchors } = state;
  if (anchors.pending.length === 0) return;
  anchors.pending = anchors.pending.filter((a) => {
    if (a.version > state.version) return true;
    activateAnchor(anchors, a);
    return false;
  });
  state.anchorsDirty = true;
}

// `a.version` is the doc version the client's positions refer to. The instructor is the only
// writer, so it's normally >= the server's version (their edits are still in flight) -- then we
// just wait for the doc to get there. If their later edits overtook this HTTP request, map the
// positions forward through the recent changes.
function placeAnchor(state, a) {
  if (a.version > state.version) {
    state.anchors.pending.push(a);
    return;
  }
  if (a.version < state.recentBase) {
    console.error(`Anchor ${a.type} #${a.id} at version ${a.version} is too old to map (oldest: ${state.recentBase}); using as-is.`);
  } else {
    for (let i = a.version - state.recentBase; i < state.recent.length; i++) {
      const cs = state.recent[i];
      if (a.type === "versionBlock") a.pos = cs.mapPos(a.pos);
      else {
        a.from = cs.mapPos(a.from, 1);
        a.to = cs.mapPos(a.to, -1);
      }
    }
  }
  activateAnchor(state.anchors, a);
}

export async function registerVersionBlockAnchor(docId, blockId, pos, atVersion) {
  const state = await getState(docId);
  placeAnchor(state, { type: "versionBlock", id: Number(blockId), pos, version: atVersion });
  state.anchorsDirty = true;
}

export async function registerPollAnchor(docId, exerciseId, from, to, atVersion) {
  const state = await getState(docId);
  placeAnchor(state, { type: "poll", id: Number(exerciseId), from, to, version: atVersion });
  state.anchorsDirty = true;
}

export async function unregisterVersionBlockAnchor(docId, blockId) {
  const state = await getState(docId);
  blockId = Number(blockId);
  state.anchors.versionBlocks.delete(blockId);
  state.anchors.pending = state.anchors.pending.filter((a) => !(a.type === "versionBlock" && a.id === blockId));
  state.anchorsDirty = true;
}

// MARK: Creating documents

// Creates a Document row. Files start empty at version 0. Variants start at version 1, whose one
// change inserts `initialContent` (possibly "") -- matching what clients expect of a new variant.
export async function createDocument({ lectureId, kind, name = null, variantId = null, initialContent = "" }, transaction) {
  const isVariant = kind === "variant";
  const doc = await Document.create(
    {
      LectureSessionId: lectureId,
      kind,
      name,
      VariantId: variantId,
      content: isVariant ? initialContent : "",
      version: isVariant ? 1 : 0,
      name_history: isVariant ? null : JSON.stringify([{ name, ts: Date.now() }]),
    },
    { transaction },
  );
  if (isVariant) {
    const ts = Date.now();
    const insert = ChangeSet.of([{ from: 0, insert: initialContent }], 0);
    await DocumentChangeBatch.create(
      {
        DocumentId: doc.id,
        from_version: 0,
        to_version: 1,
        first_ts: ts,
        last_ts: ts,
        payload: encodeChangeBatch([{ id: 0, changes: insert.toJSON(), ts }]),
      },
      { transaction },
    );
    rememberVariantDoc(variantId, doc.id);
  }
  return doc;
}

// MARK: Flushing

async function doFlush(entry) {
  let state = entry.state;
  if (!state) {
    try {
      state = await entry.ready;
    } catch {
      return false;
    }
  }
  if (state.pending.length === 0 && !state.anchorsDirty) return true;

  // Capture everything synchronously so content/version/anchors/changes are mutually consistent.
  const batch = state.pending;
  state.pending = [];
  const anchorsWereDirty = state.anchorsDirty;
  state.anchorsDirty = false;
  const content = state.text.toString();
  const version = state.version;
  const anchors = serializeAnchors(state.anchors);

  try {
    await db.transaction(async (t) => {
      await Document.update({ content, version, anchors }, { where: { id: entry.docId }, transaction: t });
      if (batch.length > 0) {
        await DocumentChangeBatch.create(
          {
            DocumentId: entry.docId,
            from_version: batch[0].id,
            to_version: batch[batch.length - 1].id + 1,
            first_ts: batch[0].ts,
            last_ts: batch[batch.length - 1].ts,
            payload: encodeChangeBatch(batch),
          },
          { transaction: t },
        );
      }
    });
  } catch (error) {
    // Put everything back so the next flush retries it (in order, ahead of anything newer).
    state.pending = batch.concat(state.pending);
    state.anchorsDirty = state.anchorsDirty || anchorsWereDirty;
    console.error(`Failed to flush document #${entry.docId}:`, error);
    return false;
  }

  state.persistedVersion = version;
  io?.to(lectureRoom(state.lectureId)).emit(SOCKET_MESSAGE_TYPE.DOC_PERSISTED, {
    docId: entry.docId,
    variantId: state.variantId,
    version,
  });
  return true;
}

// Writes this doc's pending changes + snapshot now. Resolves true on success (or nothing to do).
export function flushDoc(docId) {
  const entry = entries.get(Number(docId));
  if (!entry) return Promise.resolve(true);
  entry.flushChain = entry.flushChain.then(() => doFlush(entry));
  return entry.flushChain;
}

export async function flushAll({ evictIdle = false } = {}) {
  const results = await Promise.all([...entries.keys()].map((docId) => flushDoc(docId)));
  if (evictIdle) {
    const now = Date.now();
    for (const [docId, entry] of entries) {
      const s = entry.state;
      if (s && s.pending.length === 0 && !s.anchorsDirty && now - entry.lastTouched > IDLE_EVICT_MS) {
        entries.delete(docId);
      }
    }
  }
  return results.every(Boolean);
}

function lectureDocIds(lectureId) {
  lectureId = Number(lectureId);
  return [...entries].filter(([, e]) => e.state?.lectureId === lectureId).map(([docId]) => docId);
}

export async function flushLecture(lectureId) {
  const results = await Promise.all(lectureDocIds(lectureId).map((docId) => flushDoc(docId)));
  return results.every(Boolean);
}

// Flushes, then drops from memory (if the flush succeeded) -- e.g. a finished lecture won't be
// edited again; it'll cheaply re-hydrate from its snapshot if it's ever read.
export async function evictDoc(docId) {
  const ok = await flushDoc(docId);
  const entry = entries.get(Number(docId));
  if (ok && entry?.state && entry.state.pending.length === 0) entries.delete(Number(docId));
}

export async function evictLecture(lectureId) {
  await Promise.all(lectureDocIds(lectureId).map((docId) => evictDoc(docId)));
}
