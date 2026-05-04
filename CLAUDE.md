Context:
- This web app is a research prototype that support CS lectures that use live coding. 
- Instructors are presented with a code editor where they can write and run Python.
- Students are presented with a read-only version of the instructor's code editor that updates in real time.
- Instructors have an activities/exercises panel where they can create short exercises for the students, which prompts the students to enter a response to the instructor's question.
- Exercise responses can be free text, small code snippets, or larger code changes.
- Once an instructor marks an active exercise as complete, the app shows a summary on the instructor's screen that aggregates student responses.
- Not everything is implemented yet (e.g., aggregation for the exercise summaries).
- The app can host multiple lectures at the same time, although it is not expected this will happen very much in practice.

Important files:
- The instructor's interface is defined in `pages/instructor.html` and runs `src/client/instructor.js`.
- The student's interface is defined in `pages/student-page.html` and runs `src/client/student-page.js`.
- Activity panel logic is defined in `src/client/activities-panel.js`.
- The database schema is defined in `src/server/models.js`.
- The API endpoints live in `src/server/main.js`.

Technical details:
- Written using Vite, vanilla JS, and Node.
- Uses SQLite as the database, with the sequelize library.
- Uses the CodeMirror v6 library on the front end.
- Uses WebSockets (socket.io) to quickly communicate updates between the instructor and student interfaces.
- The app is run using `npm run dev`