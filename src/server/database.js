import { AsyncLocalStorage } from "node:async_hooks";
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

// MARK: In-process write lock
// Every write transaction (the IMMEDIATE default) waits here for the previous one to finish before
// it even sends BEGIN IMMEDIATE. Without this, N concurrent writers each open their own connection
// and N-1 of them sit in SQLite's busy handler -- and node-sqlite3 runs that busy-wait ON A libuv
// THREAD-POOL THREAD. Once the waiters fill the pool, the lock holder's own next statement (its
// INSERT, its COMMIT) can't get a thread until a waiter times out, so everything stalls in 5s
// waves and joins start failing with SQLITE_BUSY (src/scripts/load-test/join-reload-stress.js:
// ~100 simultaneous first joins with 64 threads, ~10 with the default 4). This server is a single
// process (see doc-store.js), so serializing our own writers here is free: they each hold the lock
// for a millisecond or two. busy_timeout above stays as the safety net for autocommit writes made
// outside a transaction and for other processes (e.g. the analysis scripts).
//
// DEFERRED (read) transactions skip the queue -- in WAL mode they never block or wait on a writer.
// So do savepoints (options.transaction) and unmanaged transactions (no callback, e.g. Sequelize's
// own findOrCreate), which aren't used for top-level writes here.
//
// RULES for code inside a write transaction: never start another top-level write transaction (it
// would wait on the lock its caller holds -- caught below and thrown instead of deadlocking), and
// never await anything slow (LLM calls, network) -- it holds up every other writer.
const writeLockHolder = new AsyncLocalStorage();
let writeQueue = Promise.resolve();
const rawTransaction = db.transaction.bind(db);

db.transaction = function (options, autoCallback) {
  if (typeof options === "function") {
    autoCallback = options;
    options = {};
  }
  const type = options?.type ?? db.options.transactionType;
  if (!autoCallback || options?.transaction || type === Sequelize.Transaction.TYPES.DEFERRED) {
    return rawTransaction(options, autoCallback);
  }
  if (writeLockHolder.getStore()) {
    return Promise.reject(
      new Error("Nested write transaction: pass the outer transaction ({ transaction: t }) instead of starting a new one"),
    );
  }
  const run = writeQueue.then(() => writeLockHolder.run(true, () => rawTransaction(options, autoCallback)));
  writeQueue = run.catch(() => {});
  return run;
};

// journal_mode is stored in the database file's header, so this only needs
// to be set once -- it applies to every future connection automatically.
await db.query("PRAGMA journal_mode = WAL;");
