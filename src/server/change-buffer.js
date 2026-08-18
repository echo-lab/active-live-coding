import { SOCKET_MESSAGE_TYPE } from "../shared-constants.js";
import { LectureSession, Variant, VersionBlock } from "./models.js";
import { ChangeSet, Text } from "@codemirror/state";

// Mirrors the room-naming convention in main.js -- kept local to avoid a
// circular import (main.js imports ChangeBuffer from this file).
function lectureRoom(sessionId) {
  return `lecture-${sessionId}`;
}

// This only supports the Instructor's changes for now.
// TODO: consider using the same pattern for student changes (though probs not necessary).
export class ChangeBuffer {
  constructor(flushIntervalMs, db) {
    this.queue = [];
    this.variantQueue = [];
    this.flushInterval = setInterval(async () => {
      if (this.queue.length === 0) return;
      try {
        await db.transaction(async (t) => {
          await this.flush(t);
        });
      } catch (error) {
        console.log("Failed to flush changes: ", error);
      }
      this.flush.bind(this);
    }, flushIntervalMs);
  }

  initSocket(io) {
    this.io = io;
  }

  // NOTE: queue changes MUST come in order.
  // Dropped changes are recoverable.
  enqueue(change) {
    this.queue.push(change);
  }

  enqueueVariant(change) {
    this.variantQueue.push(change);
  }

  // This should write as much as it can, and should only raise an error for DB issues.
  async flush(transaction) {
    let queue = this.queue;
    this.queue = [];

    // Currently, this is built for a single session.
    for (let [sessionId, changes] of Object.entries(organizeBySession(queue))) {
      let { error } = await flushChangesToSession(
        sessionId,
        changes,
        transaction
      );
      if (error) {
        console.warn("Failed to flush changes: ", error);
        this.io?.to(lectureRoom(sessionId)).emit(SOCKET_MESSAGE_TYPE.INSTRUCTOR_OUT_OF_SYNC, {
          sessionId,
          error,
        });
      }
    }

    let variantQueue = this.variantQueue;
    this.variantQueue = [];

    for (let [variantId, changes] of Object.entries(organizeByVariant(variantQueue))) {
      let { error, sessionId } = await flushChangesToVariant(variantId, changes, transaction);
      if (error) {
        console.warn("Failed to flush variant changes: ", error);
        if (sessionId) {
          this.io?.to(lectureRoom(sessionId)).emit(SOCKET_MESSAGE_TYPE.INSTRUCTOR_OUT_OF_SYNC, {
            sessionId,
            error,
          });
        } else {
          console.warn(`Could not resolve lecture session for variant ${variantId}; dropping out-of-sync broadcast.`);
        }
      }
    }
  }
}

// Returns: {success} or {error} ?
async function flushChangesToSession(sessionId, changeQueue, transaction) {
  // This should be a no-op, but just in case :)
  changeQueue.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let lecture = await LectureSession.findByPk(sessionId, { transaction });
  if (!lecture) return;

  // Fetch the latest version of the doc
  let { doc, docVersion } = await lecture.getDoc(transaction);

  // Now, let's try to apply the changes
  for (let { id, changes, ts } of changeQueue) {
    if (id !== docVersion) {
      return {
        error: new Error(`Expected instructor change #${docVersion} but got #${id}`),
      };
    }

    try {
      doc = ChangeSet.fromJSON(changes).apply(doc);
      docVersion++;
    } catch (error) {
      return { error: error.message };
    }

    // Safe to write :)
    await lecture.createInstructorChange(
      {
        change_number: id,
        change: JSON.stringify(changes),
        change_ts: ts,
      },
      { transaction }
    );
  }
  return { success: true };
  // We might consider also writing the doc to the DB, though eh.
}

function organizeBySession(changes) {
  let res = {};
  for (let change of changes) {
    let { sessionId: id } = change;
    if (!res[id]) {
      res[id] = [change];
    } else {
      res[id].push(change);
    }
  }
  return res;
}

async function flushChangesToVariant(variantId, changeQueue, transaction) {
  changeQueue.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let variant = await Variant.findByPk(variantId, {
    include: [{ model: VersionBlock, attributes: ["LectureSessionId"] }],
    transaction,
  });
  if (!variant) return { error: new Error(`Variant ${variantId} not found`) };
  // Needed to room-scope the INSTRUCTOR_OUT_OF_SYNC broadcast below on error.
  let sessionId = variant.VersionBlock?.LectureSessionId;

  let existingChanges = await variant.getVariantChanges(
    { attributes: ["change", "change_number"], order: ["change_number"] },
    { transaction }
  );

  let doc = Text.empty;
  let docVersion = 0;
  for (let { change } of existingChanges) {
    doc = ChangeSet.fromJSON(JSON.parse(change)).apply(doc);
    docVersion++;
  }

  for (let { id, changes, ts } of changeQueue) {
    if (id !== docVersion) {
      return {
        error: new Error(`Expected variant change #${docVersion} but got #${id}`),
        sessionId,
      };
    }

    try {
      doc = ChangeSet.fromJSON(changes).apply(doc);
      docVersion++;
    } catch (error) {
      return { error: error.message, sessionId };
    }

    await variant.createVariantChange(
      {
        change_number: id,
        change: JSON.stringify(changes),
        change_ts: ts,
      },
      { transaction }
    );
  }
  return { success: true };
}

function organizeByVariant(changes) {
  let res = {};
  for (let change of changes) {
    let { variantId } = change;
    if (!res[variantId]) {
      res[variantId] = [change];
    } else {
      res[variantId].push(change);
    }
  }
  return res;
}
