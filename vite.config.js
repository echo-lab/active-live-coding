import { resolve } from "path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        instructor: resolve(__dirname, "pages/instructor.html"),
        studentPage: resolve(__dirname, "pages/student-page.html"),
        listSessions: resolve(__dirname, "pages/analysis/sessions.html"),
        sessionDeets: resolve(__dirname, "pages/analysis/session.html"),
      },
    },
  },
});
