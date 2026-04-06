import { DataTypes, Model, Op } from "sequelize";
import { Text, ChangeSet } from "@codemirror/state";
import { db as sequelize } from "./database.js";

/*
LectureSession
  InstructorChange
  InstructorAction
  TypealongSession
    TypealongChange
    TypealongAction
  NotesSession
    NotesChange
    PlaygroundCodeChange
    NotesAction
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

// NOTE: this class is written for a SINGLE THREADED SERVER!!! Consider rewriting :)
export class LectureSession extends Model {
  // Get the active session w/ the given name
  static async current(name, transaction) {
    let sesh = await LectureSession.findAll(
      {
        where: { isFinished: false, name },
        order: [["id", "DESC"]],
      },
      { transaction }
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
      { transaction }
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
      { transaction }
    );
    return reconstructCMDoc(changes);
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
    isFinished: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
  },
  { sequelize }
);

export class InstructorChange extends Model {}
InstructorChange.init(CODE_CHANGE_SCHEMA, { sequelize });

LectureSession.hasMany(InstructorChange, { foreignKey: "LectureSessionsId" });
InstructorChange.belongsTo(LectureSession);

export class InstructorAction extends Model {}
InstructorAction.init(USER_ACTION_SCHEMA, { sequelize });
LectureSession.hasMany(InstructorAction, { foreignKey: "LectureSessionsId" });
InstructorAction.belongsTo(LectureSession);

export class TypealongSession extends Model {
  // Get a map: {fileName: {doc, docVersion}}
  async getCurrentDocs(transaction) {
    let changes = await this.getTypealongChanges(
      {
        attributes: ["change", "change_number", "file_name"],
        order: ["change_number"],
      },
      { transaction }
    );
    let changesByFile = {};
    for (let { change, file_name } of changes) {
      if (!changesByFile[file_name]) {
        changesByFile[file_name] = [{ change }];
      } else {
        changesByFile[file_name].push({ change });
      }
    }
    let docsByFile = {};
    Object.entries(changesByFile).forEach(([file, changes]) => {
      let { doc, docVersion } = reconstructCMDoc(changes);
      docsByFile[file] = { doc: doc.toJSON(), docVersion };
    });
    return docsByFile;
  }

  async recordCodeChanges(changes, transaction) {
    let fileAndVersion = await this.getTypealongChanges(
      {
        group: ["file_name"],
        attributes: [
          "file_name",
          [sequelize.fn("COUNT", "file_name"), "docVersion"],
        ],
      },
      { transaction }
    );

    let fileToVersion = {};
    for (let {
      file_name,
      dataValues: { docVersion },
    } of fileAndVersion) {
      fileToVersion[file_name] = docVersion;
    }

    // Stupid hack -- there should only be one file for all the changes.
    let theFileName;

    // Should probs check more lol
    // But: we assume it's in order and that there are no gaps :P
    for (let { fileName, changeNumber, changesetJSON, ts } of changes) {
      theFileName = fileName;
      if (!fileToVersion[fileName]) fileToVersion[fileName] = 0;

      if (changeNumber < fileToVersion[fileName]) {
        console.warn(`Skipping already seen code change: #${changeNumber}`);
        continue;
      } else if (changeNumber > fileToVersion[fileName]) {
        console.warn(
          `Expected typealong change #${fileToVersion[fileName]} but got #${changeNumber}`
        );
        return fileToVersion[fileName];
      }
      await this.createTypealongChange(
        {
          file_name: fileName,
          change_number: changeNumber,
          change: JSON.stringify(changesetJSON),
          change_ts: ts,
        },
        { transaction }
      );
      fileToVersion[fileName]++;
    }
    return fileToVersion[theFileName];
  }
}

TypealongSession.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      allowNull: false,
      primaryKey: true,
    },
    email: {
      type: DataTypes.STRING,
      allowNull: false,
    },
  },
  { sequelize }
);

LectureSession.hasMany(TypealongSession, { foreignKey: "LectureSessionsId" }); // Typo: should not be plural...
TypealongSession.belongsTo(LectureSession);

export class TypealongChange extends Model {}
TypealongChange.init(CODE_CHANGE_SCHEMA, { sequelize });

TypealongSession.hasMany(TypealongChange, { foreignKey: "TypealongChangeId" }); // This should be TypealongSessionId lol
TypealongChange.belongsTo(TypealongSession);

export class TypealongAction extends Model {}
TypealongAction.init(USER_ACTION_SCHEMA, { sequelize });
TypealongSession.hasMany(TypealongAction, { foreignKey: "TypealongChangeId" }); // This is an error lol -- foreignKey should be TypealongSessionId...
TypealongAction.belongsTo(TypealongSession);

export class NotesSession extends Model {
  // Returns all the deltas, in order.
  // TODO: consider calculating the resulting Delta (i.e., the current document)
  // on server-side.
  async getDeltas(transaction) {
    return await this.getNotesChanges(
      {
        attributes: ["change", "change_number"],
        order: ["change_number"],
      },
      { transaction }
    );
  }

  async addChanges(changes, transaction) {
    let currentVersion = await this.countNotesChanges({ transaction });
    // TODO: check more?
    for (let { changeNumber, delta, ts } of changes) {
      if (changeNumber < currentVersion) {
        console.warn(`Skipping already seen notes change: #${changeNumber}`);
        continue;
      } else if (changeNumber > currentVersion) {
        // Missed a change, somehow!
        console.warn(
          `Received notes change #${changeNumber}, but expected ${currentVersion}`
        );
        return currentVersion;
      }
      await this.createNotesChange(
        {
          change_number: changeNumber,
          change: JSON.stringify(delta),
          change_ts: ts,
        },
        { transaction }
      );
      currentVersion++;
    }
    return currentVersion;
  }

  async currentPlaygroundCode(transaction) {
    let changes = await this.getPlaygroundCodeChanges(
      {
        attributes: ["change", "change_number"],
        order: ["change_number"],
      },
      { transaction }
    );
    return reconstructCMDoc(changes);
  }

  async recordCodeChanges(changes, transaction) {
    let currentVersion = await this.countPlaygroundCodeChanges();
    for (let { changeNumber, changesetJSON, ts } of changes) {
      if (changeNumber < currentVersion) {
        console.warn(`Skipping already seen playground change: #${changeNumber}`);
        continue;
      } else if (changeNumber > currentVersion) {
        console.warn(
          `Expected playground code change #${currentVersion}; got #${changeNumber}`
        );
        return currentVersion;
      }
      await this.createPlaygroundCodeChange(
        {
          change_number: changeNumber,
          change: JSON.stringify(changesetJSON),
          change_ts: ts,
        },
        { transaction }
      );
      currentVersion++;
    }
    return currentVersion;
  }
}

NotesSession.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      allowNull: false,
      primaryKey: true,
    },
    email: {
      type: DataTypes.STRING,
      allowNull: false,
    },
  },
  { sequelize }
);

LectureSession.hasMany(NotesSession, { foreignKey: "LectureSessionsId" });
NotesSession.belongsTo(LectureSession);

export class NotesChange extends Model {}

NotesChange.init(CODE_CHANGE_SCHEMA, { sequelize });

NotesSession.hasMany(NotesChange, { foreignKey: "NotesChangeId" });
NotesChange.belongsTo(NotesSession);

export class PlaygroundCodeChange extends Model {}

PlaygroundCodeChange.init(CODE_CHANGE_SCHEMA, { sequelize });

NotesSession.hasMany(PlaygroundCodeChange, { foreignKey: "NotesChangeId" });
PlaygroundCodeChange.belongsTo(NotesSession);

export class NotesAction extends Model {}
NotesAction.init(USER_ACTION_SCHEMA, { sequelize });
NotesSession.hasMany(NotesAction, { foreignKey: "NotesChangeId" });
NotesAction.belongsTo(NotesSession);

export const EXERCISE_TYPE = Object.freeze({
  POLL: "POLL",
  CODE: "CODE",
  CODE_FORK: "CODE_FORK",
});

export class ClassExercise extends Model {
  static async createForLecture(lectureId, { type, instructions } = {}, transaction) {
    return ClassExercise.create(
      { LectureSessionId: lectureId, type, instructions, start_ts: Date.now() },
      { transaction }
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
  },
  { sequelize }
);

LectureSession.hasMany(ClassExercise, { foreignKey: "LectureSessionId" });
ClassExercise.belongsTo(LectureSession);

export class ExerciseResponse extends Model {
  // Creates a new response, or updates the existing one (stashing prior answer in history).
  static async submitOrUpdate(exerciseId, { student_id, answer }, transaction) {
    let existing = await ExerciseResponse.findOne({
      where: { ClassExerciseId: exerciseId, student_id },
      transaction,
    });

    if (!existing) {
      return ExerciseResponse.create(
        { ClassExerciseId: exerciseId, student_id, answer, submitted_ts: Date.now() },
        { transaction }
      );
    }

    let history = existing.history ? JSON.parse(existing.history) : [];
    history.push({ timestamp: existing.submitted_ts, answer: existing.answer });
    return existing.update(
      { answer, submitted_ts: Date.now(), history: JSON.stringify(history) },
      { transaction }
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
  { sequelize }
);

ClassExercise.hasMany(ExerciseResponse, { foreignKey: "ClassExerciseId" });
ExerciseResponse.belongsTo(ClassExercise);
