import { Sequelize } from "sequelize";

const BUSY_TIMEOUT_MS = 5000;

export const db = new Sequelize({
  dialect: "sqlite",
  storage: "db.sqlite",
  // The following is necessary to prevent deadlock in certain situations! Ugh!
  // See: https://github.com/sequelize/sequelize/issues/10304
  transactionType: Sequelize.Transaction.TYPES.IMMEDIATE,
  logging: false, // TODO: consider turning back on?
});

// Sequelize's sqlite dialect opens a brand-new physical connection for every
// db.transaction() call (not just once at startup), and busy_timeout is a
// per-connection sqlite setting. So it has to be applied here, on every
// connection as it's created, rather than via a single PRAGMA query at
// startup -- otherwise transactions silently fall back to the driver's
// default (1000ms) and concurrent writers hit SQLITE_BUSY instead of waiting.
const getConnection = db.connectionManager.getConnection.bind(db.connectionManager);
db.connectionManager.getConnection = async (options) => {
  const connection = await getConnection(options);
  connection.configure("busyTimeout", BUSY_TIMEOUT_MS);
  return connection;
};

// journal_mode is stored in the database file's header, so this only needs
// to be set once -- it applies to every future connection automatically.
await db.query("PRAGMA journal_mode = WAL;");
