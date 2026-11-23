import { resolve } from "path";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
	  allowedHosts: ["livecoding.cs.vt.edu"],
  },
  // The Pyodide worker is a module worker (it uses an ES `import`), so build workers as ES modules
  // rather than Vite's default IIFE.
  worker: {
    format: "es",
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        instructor: resolve(__dirname, "pages/instructor.html"),
        studentPage: resolve(__dirname, "pages/student-page.html"),
        reviewLecture: resolve(__dirname, "pages/review-lecture.html"),
        lectureList: resolve(__dirname, "pages/lecture-list.html"),
        listSessions: resolve(__dirname, "pages/analysis/sessions.html"),
        sessionDeets: resolve(__dirname, "pages/analysis/session.html"),
      },
    },
  },
});
