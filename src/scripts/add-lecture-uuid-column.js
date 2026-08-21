// One-off, non-destructive migration: adds the `uuid` column to LectureSessions.
// db.sync() only creates missing tables, never alters existing ones, so this is
// needed to bring an existing (e.g. prod) db.sqlite up to date. No backfill --
// existing rows are left with uuid = NULL.
import { DataTypes } from "sequelize";
import { db } from "../server/database.js";

const qi = db.getQueryInterface();
const table = await qi.describeTable("LectureSessions");
if (table.uuid) {
  console.log("uuid column already exists -- nothing to do.");
} else {
  await qi.addColumn("LectureSessions", "uuid", { type: DataTypes.STRING, allowNull: true });
  console.log("Added uuid column to LectureSessions.");
}
process.exit(0);
