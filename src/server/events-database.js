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
