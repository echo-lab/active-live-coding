// Read-only CLI for exploring the offline events log (events.sqlite).
// Each Event row holds one compressed batch (not one row per event), so
// listing events for a user decompresses every matching row and flattens
// them into a single list, sorted by each event's own timestamp.
//
// Usage:
//   node src/scripts/query-events.js lectures
//   node src/scripts/query-events.js users <lectureId>
//   node src/scripts/query-events.js events <lectureId> <userId>
import zlib from "node:zlib";
import { Event } from "../server/events-database.js";

function usage() {
  console.log(`Usage:
  node src/scripts/query-events.js lectures
  node src/scripts/query-events.js users <lectureId>
  node src/scripts/query-events.js events <lectureId> <userId>`);
}

async function listLectures() {
  let rows = await Event.findAll({
    attributes: ["lectureId"],
    group: ["lectureId"],
    order: [["lectureId", "ASC"]],
  });
  return rows.map((r) => r.lectureId);
}

async function listUsers(lectureId) {
  let rows = await Event.findAll({
    attributes: ["isStudent", "userId"],
    where: { lectureId },
    group: ["isStudent", "userId"],
    order: [["isStudent", "ASC"], ["userId", "ASC"]],
  });
  return rows.map((r) => ({ isStudent: !!r.isStudent, userId: r.userId }));
}

// Most rows are gzip (the normal batched flush); rows written by the pagehide/sendBeacon
// leave-flush are stored uncompressed since compression there isn't guaranteed to finish
// before the page unloads -- payload is self-describing via the gzip magic bytes.
function isGzip(payload) {
  return payload.length >= 2 && payload[0] === 0x1f && payload[1] === 0x8b;
}

async function listEvents(lectureId, userId) {
  let rows = await Event.findAll({ where: { lectureId, userId } });
  let events = [];
  for (let row of rows) {
    let json = isGzip(row.payload)
      ? zlib.gunzipSync(row.payload).toString("utf-8")
      : row.payload.toString("utf-8");
    let batch = JSON.parse(json);
    events.push(...batch);
  }
  events.sort((a, b) => a.timestamp - b.timestamp);
  return events;
}

const [, , command, ...args] = process.argv;

let result;
if (command === "lectures") {
  result = await listLectures();
} else if (command === "users" && args[0]) {
  result = await listUsers(Number(args[0]));
} else if (command === "events" && args[0] && args[1]) {
  result = await listEvents(Number(args[0]), args[1]);
} else {
  usage();
  process.exit(1);
}

console.log(JSON.stringify(result, null, 2));
process.exit(0);
