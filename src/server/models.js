import { DataTypes, Model, Op } from "sequelize";
import { Text, ChangeSet } from "@codemirror/state";
import { db as sequelize } from "./database.js";

/*
LectureSession
  InstructorChange
  InstructorAction
  ClassExercise
    ExerciseResponse
    SimulatedExerciseResponse
  StudentSession          (new student interface: student-page.html)
    StudentAction
    ExerciseResponse
*/

const CODE_CHANGE_SCHEMA = {
  file_name: DataTypes.STRING, // Only for Typealong Changes :)
  change_number: DataTypes.INTEGER,
  change: DataTypes.TEXT,
  change_ts: DataTypes.INTEGER,
};

// Actions that are NOT document/code edits, e.g., running code; copying code into the playground.
const USER_ACTION_SCHEMA = {
  action_ts: DataTypes.INTEGER,
  code_version: DataTypes.INTEGER,
  doc_version: DataTypes.INTEGER,
  action_type: DataTypes.STRING,
  details: DataTypes.STRING,
};

export function reconstructCMDoc(changes) {
  let doc = Text.empty;
  let docVersion = 0;

  changes.forEach(({ change }) => {
    doc = ChangeSet.fromJSON(JSON.parse(change)).apply(doc);
    docVersion++;
  });

  return { doc, docVersion };
}

// MARK: LectureSession
// NOTE: this class is written for a SINGLE THREADED SERVER!!! Consider rewriting :)
export class LectureSession extends Model {
  // Get the active session w/ the given name
  static async current(name, transaction) {
    let sesh = await LectureSession.findAll(
      {
        where: { isFinished: false, name },
        order: [["id", "DESC"]],
      },
      { transaction },
    );
    // TODO: Probably try to make sure there's not more than one session lol.
    return sesh.length > 0 ? sesh[0] : null;
  }

  async changesSinceVersion(docVersion, transaction) {
    // Compose all the changes; return the resulting change and the latest version number
    let changes = await this.getInstructorChanges(
      {
        where: {
          change_number: {
            [Op.gte]: docVersion,
          },
        },
        order: ["change_number"],
      },
      { transaction },
    );
    return changes.map(({ change, change_number }) => ({
      change: JSON.parse(change),
      changeNumber: change_number,
    }));
  }

  async getDoc(transaction) {
    let changes = await this.getInstructorChanges(
      {
        attributes: ["change", "change_number"],
        order: ["change_number"],
      },
      { transaction },
    );
    return reconstructCMDoc(changes);
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
    return this._resolvePollAnchors(exercises, transaction);
  }

  // Given exercises belonging to this lecture, resolves each POLL/POLL_MCQ's
  // code_anchor_from/code_anchor_to to their CURRENT positions by replaying
  // InstructorChanges since code_anchor_doc_version -- same technique as
  // getVersionBlocksWithPositions, just for a [from, to) range instead of a point.
  async _resolvePollAnchors(exercises, transaction) {
    const needsResolution = exercises.some(
      (ex) => (ex.type === "POLL" || ex.type === "POLL_MCQ") && ex.code_anchor_from != null,
    );
    if (!needsResolution) return exercises;

    const allChanges = await this.getInstructorChanges(
      { attributes: ["change_number", "change"], order: ["change_number"] },
      { transaction },
    );

    return exercises.map((ex) => {
      if ((ex.type !== "POLL" && ex.type !== "POLL_MCQ") || ex.code_anchor_from == null) return ex;

      let from = ex.code_anchor_from;
      let to = ex.code_anchor_to;
      for (const { change_number, change } of allChanges) {
        if (change_number >= ex.code_anchor_doc_version) {
          const cs = ChangeSet.fromJSON(JSON.parse(change));
          // assoc=1 for from / -1 for to: edits landing exactly on a boundary are excluded
          // from the range, matching CodeMirror's own non-inclusive Decoration.mark semantics
          // (the same convention used by the live client-side marker in cm-poll-marker.js).
          from = cs.mapPos(from, 1);
          to = cs.mapPos(to, -1);
        }
      }
      // The anchored code was entirely deleted -- report no anchor rather than a collapsed range.
      if (to <= from) return { ...ex.toJSON(), code_anchor_from: null, code_anchor_to: null };
      return { ...ex.toJSON(), code_anchor_from: from, code_anchor_to: to };
    });
  }

  async getVersionBlocksWithPositions(transaction) {
    const blocks = await this.getVersionBlocks(
      {
        where: { deleted: false },
        include: [{ model: Variant, include: [VariantChange] }],
        order: [["createdAt", "ASC"]],
      },
      { transaction },
    );

    if (blocks.length === 0) return [];

    const allChanges = await this.getInstructorChanges(
      { attributes: ["change_number", "change"], order: ["change_number"] },
      { transaction },
    );

    return blocks.map((block) => {
      const v0 = block.Variants.find((v) => v.name === "v0") ?? block.Variants[0];
      const variantChanges = v0
        ? [...v0.VariantChanges].sort((a, b) => a.change_number - b.change_number)
        : [];
      const { doc: variantDoc } = reconstructCMDoc(variantChanges);
      const variantCode = variantDoc.toString();

      let from = block.anchor_pos;

      for (const { change_number, change } of allChanges) {
        if (change_number >= block.anchor_change_number) {
          const cs = ChangeSet.fromJSON(JSON.parse(change));
          from = cs.mapPos(from);
        }
      }
      const to = from;

      let sortedVariants = [...block.Variants].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      return {
        id: block.id,
        from,
        to,
        variants: sortedVariants.map((v) => {
          const vChanges = [...v.VariantChanges].sort((a, b) => a.change_number - b.change_number);
          return {
            id: v.id,
            name: v.name,
            code: reconstructCMDoc(vChanges).doc.toString(),
            docVersion: vChanges.length,
          };
        }),
      };
    });
  }

  // Reconstructs the main doc + the ONE given exercise's anchor exactly as they looked at the
  // moment that exercise's anchor was captured -- for a poll, when it was asked
  // (code_anchor_doc_version); for a code exercise, when its Version Block was dissolved
  // (deleted_change_number). Used to render a read-only "historical view" once an activity's
  // live anchor is gone. Same bounded ChangeSet-replay technique as getVersionBlocksWithPositions
  // above, just stopping at a fixed past point instead of walking forward to "now".
  async getHistoricalContextForExercise(exerciseId, transaction, studentId = null) {
    const exercise = await ClassExercise.findByPk(exerciseId, {
      include: [{ model: VersionBlock, required: false, include: [{ model: Variant, include: [VariantChange] }] }],
      transaction,
    });
    if (!exercise) return { error: `Exercise #${exerciseId} not found` };

    const isPoll = exercise.type === "POLL" || exercise.type === "POLL_MCQ";
    let targetChangeNumber, timestamp;
    if (isPoll) {
      if (exercise.code_anchor_doc_version == null) return { error: "Exercise has no code anchor" };
      targetChangeNumber = exercise.code_anchor_doc_version;
      timestamp = exercise.start_ts;
    } else if (exercise.type === "CODE_VARIANT") {
      const block = exercise.VersionBlock;
      if (!block || block.deleted_change_number == null) return { error: "Version block is not dissolved" };
      targetChangeNumber = block.deleted_change_number;
      timestamp = block.updatedAt.getTime();
    } else {
      return { error: `Unsupported exercise type: ${exercise.type}` };
    }

    const priorChanges = await this.getInstructorChanges(
      {
        attributes: ["change_number", "change"],
        where: { change_number: { [Op.lt]: targetChangeNumber } },
        order: ["change_number"],
      },
      { transaction },
    );
    const { doc } = reconstructCMDoc(priorChanges);

    if (isPoll) {
      return {
        type: exercise.type,
        doc: doc.toJSON(),
        timestamp,
        anchor: { from: exercise.code_anchor_from, to: exercise.code_anchor_to },
      };
    }

    // CODE_VARIANT: map the block's creation-time anchor forward, but only up through the
    // moment of deletion (not all the way to "now", unlike getVersionBlocksWithPositions).
    const block = exercise.VersionBlock;
    let from = block.anchor_pos;
    for (const { change_number, change } of priorChanges) {
      if (change_number >= block.anchor_change_number) {
        from = ChangeSet.fromJSON(JSON.parse(change)).mapPos(from);
      }
    }

    const sortedVariants = [...block.Variants].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const variants = sortedVariants.map((v) => {
      const vChanges = [...v.VariantChanges].sort((a, b) => a.change_number - b.change_number);
      return { id: v.id, name: v.name, code: reconstructCMDoc(vChanges).doc.toString() };
    });

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
      type: "CODE_VARIANT",
      doc: doc.toJSON(),
      timestamp,
      versionBlock: { from, variants },
    };
  }

  // Returns all exercises for this lecture with only the given student's response (if any).
  async getExercisesForStudent(studentId, transaction) {
    const exercises = await this.getClassExercises(
      {
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
      },
      { transaction },
    );
    return this._resolvePollAnchors(exercises, transaction);
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
    } = {},
    transaction,
  ) {
    return ClassExercise.create(
      {
        LectureSessionId: lectureId,
        VersionBlockId: version_block_id ?? null,
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

// MARK: Code Changes
export class InstructorChange extends Model {}
InstructorChange.init(CODE_CHANGE_SCHEMA, { sequelize });
LectureSession.hasMany(InstructorChange, { foreignKey: "LectureSessionId" });
InstructorChange.belongsTo(LectureSession);

// MARK: Action Logging
export class InstructorAction extends Model {}
InstructorAction.init(USER_ACTION_SCHEMA, { sequelize });
LectureSession.hasMany(InstructorAction, { foreignKey: "LectureSessionId" });
InstructorAction.belongsTo(LectureSession);

// TODO: Figure out if this is used, and possibly NIX/edit
export class StudentAction extends Model {}
StudentAction.init(USER_ACTION_SCHEMA, { sequelize });
StudentSession.hasMany(StudentAction, { foreignKey: "StudentSessionId" });
StudentAction.belongsTo(StudentSession);

// MARK: VersionBlock
export class VersionBlock extends Model {
  static async createWithVariant(lectureId, { anchor_pos, anchor_change_number, variantCode }, transaction) {
    const block = await VersionBlock.create(
      { LectureSessionId: lectureId, anchor_pos, anchor_change_number },
      { transaction },
    );
    const variant = await Variant.create({ VersionBlockId: block.id, name: "v0" }, { transaction });
    const insertCs = ChangeSet.of([{ from: 0, insert: variantCode }], 0);
    await VariantChange.create(
      { VariantId: variant.id, change_number: 0, change: JSON.stringify(insertCs.toJSON()), change_ts: Date.now() },
      { transaction },
    );
    return { block, variant };
  }
}
VersionBlock.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    anchor_pos: { type: DataTypes.INTEGER, allowNull: false },
    anchor_change_number: { type: DataTypes.INTEGER, allowNull: false },
    deleted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // InstructorChange.change_number the lecture was at right when this block was dissolved --
    // i.e. reconstructing the main doc from changes strictly before this value shows the widget
    // still present (not yet flattened into literal text). Null until dissolved.
    deleted_change_number: { type: DataTypes.INTEGER, allowNull: true },
  },
  { sequelize },
);

// MARK: Variant
export class Variant extends Model {}
Variant.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    name: { type: DataTypes.STRING, allowNull: false },
  },
  { sequelize },
);

// MARK: VariantChange
export class VariantChange extends Model {}
VariantChange.init(CODE_CHANGE_SCHEMA, { sequelize });

LectureSession.hasMany(VersionBlock, { foreignKey: "LectureSessionId" });
VersionBlock.belongsTo(LectureSession);

VersionBlock.hasMany(Variant, { foreignKey: "VersionBlockId" });
Variant.belongsTo(VersionBlock);

Variant.hasMany(VariantChange, { foreignKey: "VariantId" });
VariantChange.belongsTo(Variant);

VersionBlock.hasOne(ClassExercise, { foreignKey: "VersionBlockId" });
ClassExercise.belongsTo(VersionBlock);
