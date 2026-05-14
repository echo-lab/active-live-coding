Context:
- This web app is a research prototype that support CS lectures that use live coding. 
- Instructors are presented with a code editor where they can write and run Python.
- Students are presented with a read-only version of the instructor's code editor that updates in real time.
- We are building off of an older app, so there may be some legacy code around.
- Instructors can create short exercises for the students, where the student have to enter code or text.
- Once an instructor marks an active exercise as complete, the app shows a summary on the instructor's screen that aggregates student responses.
- To create a text-input exercise, the instructor clicks "poll" and enters a prompt in the instructor activities panel sidebar. Students answer in their own acitvity panel sidebar.
- To create a code exercise, instructors select one or more lines of code in the editor, right click, and then select "Create exercise". This creates a "Version Block", and gives each student their own variant they can edit and submit. Instructors can view student responses in the activities panel, and they can walk through different solutions by adding them as variants in the version block.
- The students have a read-only copy of the instructor's editor that updates in real time. The student editor reflects all of the instructor's Version Blocks, including all variants the instructor has authored, as well as their own variant (i.e., the student response to that exercise). 
- The app can host multiple lectures at the same time, although it is not expected this will happen very much in practice.

Important files and classes:
- The instructor's interface is defined in `pages/instructor.html` and runs `src/client/instructor.js`.
- The student's interface is defined in `pages/student-page.html` and runs `src/client/student-page.js`.
- The file `code-editors.js` contains classes that represent the various code editors, including:
  - InstructorCodeEditor: which is in charge of broadcasting instructor edits and creating/destroying embedded VersionBlockWidget objects.
  - VariantCodeEditor: which is in charge of broadcasting instructor edits to variants (which live in side of the VersionBlockWidget).
  - StudentCodeEditor: which is in charge of receiving instructor edits, including those that create new version blocks. 
- The file `cm-version-widget.js` has the code for the VersionBlockWidget class.
- The activity panel display logic is defined in `src/client/activities-panel.js`.
- `activities-manager.js` defines an InstructorActivitiesManager and StudentActivitiesManager which both act as a model-controller for activities.
- The database schema is defined in `src/server/models.js`.
- The API endpoints live in `src/server/main.js`.

Technical details:
- Written using Vite, vanilla JS, and Node.
- Uses SQLite as the database, with the sequelize library.
- Uses the CodeMirror v6 library on the front end.
- Uses WebSockets (socket.io) to quickly communicate updates between the instructor and student interfaces.
- The app is run using `npm run dev`