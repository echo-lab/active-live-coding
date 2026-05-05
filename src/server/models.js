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

function reconstructCMDoc(changes) {
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
    return this.getClassExercises(
      {
        include: [
          {
            model: ExerciseResponse,
            include: [{ model: StudentSession, attributes: ["student_id", "student_identifier"], required: false }],
          },
        ],
        order: [["start_ts", "ASC"]],
      },
      { transaction },
    );
  }

  // Returns all exercises for this lecture with only the given student's response (if any).
  async getExercisesForStudent(studentId, transaction) {
    return this.getClassExercises(
      {
        include: [
          {
            model: ExerciseResponse,
            where: { student_id: studentId },
            required: false,
          },
        ],
        order: [["start_ts", "ASC"]],
      },
      { transaction },
    );
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
      allowNull: false,
    },
  },
  { sequelize },
);

LectureSession.hasMany(StudentSession, { foreignKey: "LectureSessionId" });
StudentSession.belongsTo(LectureSession);

export const EXERCISE_TYPE = Object.freeze({
  POLL: "POLL",
  CODE: "CODE",
  CODE_FORK: "CODE_FORK",
  CODE_FITB: "CODE_FITB",
});

// MARK: ClassExercise
export class ClassExercise extends Model {
  static async createForLecture(
    lectureId,
    { type, instructions, instructor_code, default_answer, code_line_context_start, code_line_context_end } = {},
    transaction,
  ) {
    return ClassExercise.create(
      {
        LectureSessionId: lectureId,
        type,
        instructions,
        instructor_code,
        default_answer,
        code_line_context_start,
        code_line_context_end,
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
    }
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
  { sequelize },
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
LectureSession.hasMany(InstructorChange, { foreignKey: "LectureSessionsId" });
InstructorChange.belongsTo(LectureSession);

// MARK: Action Logging
export class InstructorAction extends Model {}
InstructorAction.init(USER_ACTION_SCHEMA, { sequelize });
LectureSession.hasMany(InstructorAction, { foreignKey: "LectureSessionsId" });
InstructorAction.belongsTo(LectureSession);

// TODO: Figure out if this is used, and possibly NIX/edit
export class StudentAction extends Model {}
StudentAction.init(USER_ACTION_SCHEMA, { sequelize });
StudentSession.hasMany(StudentAction, { foreignKey: "StudentSessionId" });
StudentAction.belongsTo(StudentSession);
