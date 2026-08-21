import { resolve } from "path";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
	  allowedHosts: ["livecoding.cs.vt.edu"],
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
