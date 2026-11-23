// One-off, non-destructive migration: adds the `deleted_at` column to ClassExercises (set when the
// instructor deletes an exercise). db.sync() only creates missing tables, never alters existing
// ones, so this is needed to bring an existing (e.g. prod) db.sqlite up to date. Existing rows are
// left with deleted_at = NULL, i.e. not deleted.
import { DataTypes } from "sequelize";
import { db } from "../server/database.js";

const qi = db.getQueryInterface();
const table = await qi.describeTable("ClassExercises");
if (table.deleted_at) {
  console.log("deleted_at column already exists -- nothing to do.");
} else {
  await qi.addColumn("ClassExercises", "deleted_at", { type: DataTypes.DATE, allowNull: true });
  console.log("Added deleted_at column to ClassExercises.");
}
process.exit(0);
