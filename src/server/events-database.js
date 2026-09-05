import zlib from "node:zlib";
import { Sequelize, DataTypes, Model } from "sequelize";

const BUSY_TIMEOUT_MS = 5000;

export const eventsDb = new Sequelize({
  dialect: "sqlite",
  storage: "events.sqlite",
  transactionType: Sequelize.Transaction.TYPES.IMMEDIATE,
  logging: false,
});

// See database.js for why this is needed -- same reasoning applies here.
const getConnection = eventsDb.connectionManager.getConnection.bind(eventsDb.connectionManager);
eventsDb.connectionManager.getConnection = async (options) => {
  const connection = await getConnection(options);
  connection.configure("busyTimeout", BUSY_TIMEOUT_MS);
  return connection;
};

await eventsDb.query("PRAGMA journal_mode = WAL;");

// Write-only log for offline analysis -- never read by the app, so no
// association to LectureSession (it also lives in a different physical
// database file, which Sequelize associations can't span anyway).
export class Event extends Model {}
Event.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    isStudent: { type: DataTypes.BOOLEAN, allowNull: false },
    userId: { type: DataTypes.STRING, allowNull: false },
    lectureId: { type: DataTypes.INTEGER, allowNull: false },
    timestamp: { type: DataTypes.INTEGER, allowNull: false },
    payload: { type: DataTypes.BLOB, allowNull: false },
  },
  { sequelize: eventsDb, timestamps: false },
);

// A pagehide-triggered flush (see ClientEventsBuffer._flushOnLeave in shared-interactions.js)
// sends its batch uncompressed, since CompressionStream is async and isn't guaranteed to finish
// before the page is torn down -- so a stored payload may or may not actually be gzip. Detect by
// the gzip magic bytes (1f 8b) rather than assuming, so both encodings read back correctly.
export function decompressEventBatch(payload) {
  const isGzip = payload.length >= 2 && payload[0] === 0x1f && payload[1] === 0x8b;
  const json = isGzip ? zlib.gunzipSync(payload).toString("utf-8") : payload.toString("utf-8");
  return JSON.parse(json);
}
