import "./style.css";

import { getEmail } from "./utils.js";
import { setUpChangeEmail } from "./shared-interactions.js";

setTimeout(() => {
  const email = getEmail();
  const studentDetailsContainer = document.querySelector("#student-email");
  const changeEmailLink = document.querySelector("#change-email");
  if (email) {
    studentDetailsContainer.textContent = `Your email: ${email}`;
    setUpChangeEmail(changeEmailLink);
  }
}, 200);
