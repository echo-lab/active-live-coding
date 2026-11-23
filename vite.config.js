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
        main: resolve(import.meta.dirname, "index.html"),
        instructor: resolve(import.meta.dirname, "pages/instructor.html"),
        studentPage: resolve(import.meta.dirname, "pages/student-page.html"),
        reviewLecture: resolve(import.meta.dirname, "pages/review-lecture.html"),
        lectureList: resolve(import.meta.dirname, "pages/lecture-list.html"),
        listSessions: resolve(import.meta.dirname, "pages/analysis/sessions.html"),
        sessionDeets: resolve(import.meta.dirname, "pages/analysis/session.html"),
      },
    },
  },
});
