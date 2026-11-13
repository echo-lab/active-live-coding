import zlib from "node:zlib";
import { DataTypes, Model } from "sequelize";
import { db as sequelize } from "./database.js";
import { getDocSnapshot, getAnchors, currentContent } from "./doc-store.js";
import { DEFAULT_FILE_NAME } from "../shared-constants.js";

/*
LectureSession
  Document (kind="file")          one row per file, e.g. "main.py" -- latest snapshot only
    DocumentChangeBatch           append-only, gzipped log of the raw changes (never read while serving)
  ClassExercise
    ExerciseResponse
    SimulatedExerciseResponse
  StudentSession          (new student interface: student-page.html)
    ExerciseResponse
  VersionBlock            lives in one file Document
    Variant               (paranoid: soft-deleted via deletedAt)
      Document (kind="variant")
*/

export { DEFAULT_FILE_NAME };

// MARK: LectureSession
// NOTE: this class is written for a SINGLE THREADED SERVER!!! Consider rewriting :)
export class LectureSession extends Model {
  // Get the active session w/ the given name
  static async current(name, transaction) {
    let sesh = await LectureSession.findAll({
      where: { isFinished: false, name },
      order: [["id", "DESC"]],
      transaction,
    });
    // TODO: Probably try to make sure there's not more than one session lol.
    return sesh.length > 0 ? sesh[0] : null;
  }

  // Every file in this lecture with its latest content (from the doc store, i.e. snapshot +
  // any not-yet-flushed changes), in the shape the clients consume.
  async getFilesWithContent(transaction) {
    const files = await this.getDocuments({
      where: { kind: "file", deleted_at: null },
      attributes: ["id", "name"],
      order: [["id", "ASC"]],
      transaction,
    });
    return Promise.all(
      files.map(async (f) => {
        const { text, version, persistedVersion } = await getDocSnapshot(f.id);
        return { id: f.id, name: f.name, doc: text.toJSON(), docVersion: version, persistedVersion };
      }),
    );
  }

  // Returns all exercises for this lecture with every student's responses.
  async getExercisesForInstructor(transaction) {
    const exercises = await this.getClassExercises(
      {
        include: [
          {
            model: ExerciseResponse,
            include: [{ model: StudentSession, attributes: ["student_id", "student_identifier"], required: false }],
          },
          {
            model: SimulatedExerciseResponse,
            required: false,
          },
          {
            model: VersionBlock,
            required: false,
          },
        ],
        order: [["start_ts", "ASC"]],
      },
      { transaction },
    );
    return this._resolvePollAnchors(exercises);
  }

  // Resolves each POLL/POLL_MCQ's code_anchor_from/code_anchor_to to its CURRENT position. The
  // doc store tracks every registered anchor live (mapping it through each applied change) and
  // persists it alongside the snapshot, so this never touches the change log.
  async _resolvePollAnchors(exercises) {
    const anchorsByDoc = new Map();
    const deletedFileIds = new Set(
      (await Document.findAll({ where: { LectureSessionId: this.id, kind: "file" }, attributes: ["id", "deleted_at"] }))
        .filter((d) => d.deleted_at != null)
        .map((d) => d.id),
    );
    return Promise.all(
      exercises.map(async (ex) => {
        if ((ex.type !== "POLL" && ex.type !== "POLL_MCQ") || ex.code_anchor_from == null || ex.DocumentId == null) {
          return ex;
        }
        // The poll's file was deleted -- its anchor is gone (the historical view takes over).
        if (deletedFileIds.has(ex.DocumentId)) return { ...ex.toJSON(), code_anchor_from: null, code_anchor_to: null };
        if (!anchorsByDoc.has(ex.DocumentId)) anchorsByDoc.set(ex.DocumentId, getAnchors(ex.DocumentId));
        const anchors = await anchorsByDoc.get(ex.DocumentId);
        const anchor = anchors.polls.get(ex.id);
        // The anchored code was entirely deleted -- report no anchor rather than a collapsed range.
        if (!anchor) return { ...ex.toJSON(), code_anchor_from: null, code_anchor_to: null };
        return { ...ex.toJSON(), code_anchor_from: anchor.from, code_anchor_to: anchor.to };
      }),
    );
  }

  async getVersionBlocksWithPositions(transaction) {
    const blocks = await this.getVersionBlocks({
      where: { deleted: false },
      include: [{ model: Variant, include: [Document] }],
      order: [["createdAt", "ASC"]],
      transaction,
    });

    if (blocks.length === 0) return [];

    const anchorsByDoc = new Map();
    return Promise.all(
      blocks.map(async (block) => {
        if (!anchorsByDoc.has(block.DocumentId)) anchorsByDoc.set(block.DocumentId, getAnchors(block.DocumentId));
        const anchors = await anchorsByDoc.get(block.DocumentId);
        let from = anchors.versionBlocks.get(block.id);
        if (from == null) {
          console.warn(`Version block #${block.id} has no tracked anchor; falling back to its creation position.`);
          from = block.anchor_pos;
        }

        const sortedVariants = [...block.Variants].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        return {
          id: block.id,
          fileId: block.DocumentId,
          from,
          to: from,
          variants: await Promise.all(
            sortedVariants.map(async (v) => {
              const { content, version } = await currentContent(v.Document);
              return { id: v.id, name: v.name, code: content, docVersion: version };
            }),
          ),
        };
      }),
    );
  }

  // Returns the main doc + the ONE given exercise's anchor exactly as they looked at the moment
  // that exercise's anchor was captured -- for a poll, when it was asked; for a code exercise,
  // when its Version Block was dissolved. Both are captured (by the instructor client) at that
  // moment and stored on the row, so this is a plain read -- no change-log replay. Used to render
  // a read-only "historical view" once an activity's live anchor is gone.
  async getHistoricalContextForExercise(exerciseId, transaction, studentId = null) {
    const exercise = await ClassExercise.findByPk(exerciseId, {
      include: [{ model: VersionBlock, required: false, include: [{ model: Variant, include: [Document] }] }],
      transaction,
    });
    if (!exercise) return { error: `Exercise #${exerciseId} not found` };

    // The name of the file the anchor lived in (its current name, even if it's since been deleted).
    const fileNameOf = async (docId) =>
      docId == null ? null : ((await Document.findByPk(docId, { attributes: ["name"], transaction }))?.name ?? null);

    const isPoll = exercise.type === "POLL" || exercise.type === "POLL_MCQ";
    if (isPoll) {
      if (exercise.context_doc == null || exercise.code_anchor_from == null) {
        return { error: "Exercise has no code anchor" };
      }
      return {
        fileName: await fileNameOf(exercise.DocumentId),
        type: exercise.type,
        doc: exercise.context_doc.split("\n"),
        timestamp: exercise.start_ts,
        anchor: { from: exercise.code_anchor_from, to: exercise.code_anchor_to },
      };
    }
    if (exercise.type !== "CODE_VARIANT") return { error: `Unsupported exercise type: ${exercise.type}` };

    const block = exercise.VersionBlock;
    if (!block || !block.deleted || block.deleted_doc == null) return { error: "Version block is not dissolved" };
    const doc = block.deleted_doc.split("\n");
    const timestamp = block.updatedAt.getTime();
    const from = block.deleted_pos;

    const sortedVariants = [...block.Variants].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const variants = await Promise.all(
      sortedVariants.map(async (v) => ({ id: v.id, name: v.name, code: (await currentContent(v.Document)).content })),
    );

    // Append the viewing student's own submitted answer (if any) as a trailing pseudo-variant,
    // mirroring the "My Answer" tab pinned last in the live StudentVersionBlockWidget.
    if (studentId) {
      const response = await ExerciseResponse.findOne({
        where: { ClassExerciseId: exercise.id, student_id: studentId },
        transaction,
      });
      if (response) {
        variants.push({ id: "own-answer", name: "My Answer", code: response.answer, isOwnAnswer: true });
      }
    }

    return {
      fileName: await fileNameOf(block.DocumentId),
      type: "CODE_VARIANT",
      doc,
      timestamp,
      versionBlock: { from, variants },
    };
  }

  // Returns all exercises for this lecture with only the given student's response (if any).
  async getExercisesForStudent(studentId, transaction) {
    const exercises = await this.getClassExercises({
      include: [
        {
          model: ExerciseResponse,
          where: { student_id: studentId },
          required: false,
        },
        {
          model: VersionBlock,
          required: false,
        },
      ],
      order: [["start_ts", "ASC"]],
      transaction,
    });
    return this._resolvePollAnchors(exercises);
  }
}

LectureSession.init(
  {
    // Id is probably added automatically?
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    name: DataTypes.STRING,
    instructor_id: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    isFinished: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    // Unguessable per-lecture id used as the access token for the read-only review page
    // (review-lecture.html?id=<uuid>). Not backfilled for lectures created before this
    // column existed -- those simply have no review link.
    uuid: {
      type: DataTypes.STRING,
      allowNull: true,
    },
  },
  { sequelize },
);

// MARK: StudentSession
// TODO: probably want to refactor this at some point...
// But for now: StudentSession is just a convenient way to aggregate ExerciseResponses and StudentActions.
export class StudentSession extends Model {}
StudentSession.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    student_id: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    student_identifier: {
      type: DataTypes.STRING,
      allowNull: true,
    },
  },
  { sequelize },
);

LectureSession.hasMany(StudentSession, { foreignKey: "LectureSessionId" });
StudentSession.belongsTo(LectureSession);

// MARK: StudentConsent
// One row per student_id (not scoped to a lecture), recording whether the
// student consented to share data with the research team for the study.
export class StudentConsent extends Model {}
StudentConsent.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    student_id: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    consented: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
    },
    consented_ts: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  },
  { sequelize },
);

// MARK: SurveyResponse
// One row per submission of the end-of-lecture survey. Resubmitting never
// updates a prior row -- each submit creates a new one, so the full history
// (with timestamps) is preserved.
export class SurveyResponse extends Model {}
SurveyResponse.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    student_id: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    likert1: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    likert2: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    likert3: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    likert4: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    likert5: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    open1: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    open2: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    submitted_ts: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
  },
  { sequelize },
);

LectureSession.hasMany(SurveyResponse, { foreignKey: "LectureSessionId" });
SurveyResponse.belongsTo(LectureSession);

export const EXERCISE_TYPE = Object.freeze({
  POLL: "POLL",
  POLL_MCQ: "POLL_MCQ",
  CODE_FITB: "CODE_FITB",
  CODE_VARIANT: "CODE_VARIANT",
});

// MARK: ClassExercise
export class ClassExercise extends Model {
  static async createForLecture(
    lectureId,
    {
      type,
      instructions,
      instructor_code,
      default_answer,
      code_line_context_start,
      code_line_context_end,
      code_anchor_from,
      code_anchor_to,
      code_anchor_doc_version,
      version_block_id,
      document_id,
      context_doc,
    } = {},
    transaction,
  ) {
    return ClassExercise.create(
      {
        LectureSessionId: lectureId,
        VersionBlockId: version_block_id ?? null,
        DocumentId: document_id ?? null,
        context_doc: context_doc ?? null,
        type,
        instructions,
        instructor_code,
        default_answer,
        code_line_context_start,
        code_line_context_end,
        code_anchor_from,
        code_anchor_to,
        code_anchor_doc_version,
        start_ts: Date.now(),
      },
      { transaction },
    );
  }

  async finish(transaction) {
    return this.update({ end_ts: Date.now() }, { transaction });
  }
}

ClassExercise.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    type: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    start_ts: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    end_ts: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    instructions: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    summary: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    instructor_code: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    default_answer: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    code_line_context_start: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    code_line_context_end: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    code_anchor_from: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    code_anchor_to: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    code_anchor_doc_version: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    VersionBlockId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    // The file a poll's code anchor lives in. Null for exercises with no code anchor.
    DocumentId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    // Full text of the anchor's file at the moment the poll was asked (captured client-side), so
    // the "historical view" is a plain read instead of a change-log replay. code_anchor_* are
    // positions in THIS text; their live positions are tracked by the doc store.
    context_doc: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  },
  { sequelize },
);

LectureSession.hasMany(ClassExercise, { foreignKey: "LectureSessionId" });
ClassExercise.belongsTo(LectureSession);

// MARK: ExerciseResponse
export class ExerciseResponse extends Model {
  // Creates a new response, or updates the existing one (stashing prior answer in history).
  static async submitOrUpdate(
    exerciseId,
    { student_id, answer, studentSessionId },
    transaction,
  ) {
    let existing = await ExerciseResponse.findOne({
      where: { ClassExerciseId: exerciseId, student_id },
      transaction,
    });

    if (!existing) {
      return ExerciseResponse.create(
        {
          ClassExerciseId: exerciseId,
          StudentSessionId: studentSessionId ?? null,
          student_id,
          answer,
          submitted_ts: Date.now(),
        },
        { transaction },
      );
    }

    let history = existing.history ? JSON.parse(existing.history) : [];
    history.push({ timestamp: existing.submitted_ts, answer: existing.answer });
    return existing.update(
      {
        answer,
        submitted_ts: Date.now(),
        history: JSON.stringify(history),
        ...(studentSessionId != null && { StudentSessionId: studentSessionId }),
      },
      { transaction },
    );
  }
}
ExerciseResponse.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    student_id: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    submitted_ts: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    answer: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    history: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  },
  {
    sequelize,
    // Matches the (ClassExerciseId, student_id) lookup in submitOrUpdate above.
    indexes: [{ fields: ["ClassExerciseId", "student_id"] }],
  },
);

ClassExercise.hasMany(ExerciseResponse, { foreignKey: "ClassExerciseId" });
ExerciseResponse.belongsTo(ClassExercise);

StudentSession.hasMany(ExerciseResponse, { foreignKey: "StudentSessionId" });
ExerciseResponse.belongsTo(StudentSession);

// MARK: SimulatedExerciseResponse
export class SimulatedExerciseResponse extends Model {}
SimulatedExerciseResponse.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    student_name: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    answer: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
  },
  { sequelize },
);

ClassExercise.hasMany(SimulatedExerciseResponse, { foreignKey: "ClassExerciseId" });
SimulatedExerciseResponse.belongsTo(ClassExercise);

// MARK: VersionBlock
export class VersionBlock extends Model {}
VersionBlock.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    // Immutable creation record (used by the offline replay): position in the file at version
    // anchor_change_number. The LIVE position is tracked by the doc store, not stored here.
    anchor_pos: { type: DataTypes.INTEGER, allowNull: false },
    anchor_change_number: { type: DataTypes.INTEGER, allowNull: false },
    deleted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // The file's version right when this block was dissolved -- i.e. the doc at this version
    // shows the widget still present (not yet flattened into literal text). Null until dissolved.
    deleted_change_number: { type: DataTypes.INTEGER, allowNull: true },
    // The file's full text + the widget's position in it right before dissolving (captured
    // client-side), for the "historical view". Null until dissolved.
    deleted_doc: { type: DataTypes.TEXT, allowNull: true },
    deleted_pos: { type: DataTypes.INTEGER, allowNull: true },
  },
  { sequelize },
);

// MARK: Variant
// Metadata only -- the code lives in this variant's Document (kind="variant"). Paranoid: destroy()
// just sets deletedAt, so a variant's creation/edits/deletion can all be replayed later. Normal
// queries/includes skip soft-deleted variants; pass `paranoid: false` to see them.
export class Variant extends Model {}
Variant.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    name: { type: DataTypes.STRING, allowNull: false },
  },
  { sequelize, paranoid: true },
);

// MARK: Document
// One row per editable text buffer: a lecture file (kind="file", e.g. "main.py") or a variant's
// code (kind="variant"). Holds only the LATEST snapshot; written by the doc store's periodic flush
// (see doc-store.js), together with the DocumentChangeBatch that got it there, in one transaction.
export class Document extends Model {}
Document.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    kind: { type: DataTypes.STRING, allowNull: false },
    // File path for kind="file"; null for variants.
    name: { type: DataTypes.STRING, allowNull: true },
    content: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    // Number of changes applied to reach `content` (the next change's id).
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // JSON: live anchor positions at `version` -- see doc-store.js serializeAnchors().
    anchors: { type: DataTypes.TEXT, allowNull: true },
    // Files only: set when the instructor deletes the file. The row (and its change log) is kept
    // so the lecture can still be replayed; live queries skip it.
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    // Files only: JSON [{name, ts}] -- the name at creation, then one entry per rename (the new
    // name and when), so replay can show a file's name at any point in time.
    name_history: { type: DataTypes.TEXT, allowNull: true },
  },
  {
    sequelize,
    indexes: [
      // A live file path is unique within a lecture. Partial (live files only): variants have
      // name=NULL, and a deleted file's name may be reused.
      { unique: true, fields: ["LectureSessionId", "name"], where: { kind: "file", deleted_at: null } },
      { unique: true, fields: ["VariantId"] },
    ],
  },
);

// MARK: DocumentChangeBatch
// Append-only log of every change applied to a Document: one row per document per flush, the raw
// changes gzipped together (like the events table). Covers versions [from_version, to_version).
// Never read while serving -- only for offline analysis / replay.
export class DocumentChangeBatch extends Model {}
DocumentChangeBatch.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    from_version: { type: DataTypes.INTEGER, allowNull: false },
    to_version: { type: DataTypes.INTEGER, allowNull: false },
    first_ts: { type: DataTypes.INTEGER, allowNull: false },
    last_ts: { type: DataTypes.INTEGER, allowNull: false },
    payload: { type: DataTypes.BLOB, allowNull: false },
  },
  {
    sequelize,
    timestamps: false,
    indexes: [{ unique: true, fields: ["DocumentId", "from_version"] }],
  },
);

// changes: [{id, changes (ChangeSet JSON), ts}]
export function encodeChangeBatch(changes) {
  return zlib.gzipSync(JSON.stringify(changes));
}

export function decodeChangeBatch(payload) {
  return JSON.parse(zlib.gunzipSync(payload).toString("utf-8"));
}

// Offline-only: every change ever applied to a document, in order: [{id, changes, ts}].
export async function loadChangeLog(documentId, transaction) {
  const batches = await DocumentChangeBatch.findAll({
    where: { DocumentId: documentId },
    order: [["from_version", "ASC"]],
    transaction,
  });
  return batches.flatMap((b) => decodeChangeBatch(b.payload));
}

LectureSession.hasMany(Document, { foreignKey: "LectureSessionId" });
Document.belongsTo(LectureSession);

Document.hasMany(DocumentChangeBatch, { foreignKey: "DocumentId" });
DocumentChangeBatch.belongsTo(Document);

LectureSession.hasMany(VersionBlock, { foreignKey: "LectureSessionId" });
VersionBlock.belongsTo(LectureSession);

Document.hasMany(VersionBlock, { foreignKey: "DocumentId" });
VersionBlock.belongsTo(Document);

VersionBlock.hasMany(Variant, { foreignKey: "VersionBlockId" });
Variant.belongsTo(VersionBlock);

Variant.hasOne(Document, { foreignKey: "VariantId" });
Document.belongsTo(Variant);

VersionBlock.hasOne(ClassExercise, { foreignKey: "VersionBlockId" });
ClassExercise.belongsTo(VersionBlock);

Document.hasMany(ClassExercise, { foreignKey: "DocumentId" });
ClassExercise.belongsTo(Document);
