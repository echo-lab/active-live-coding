import "./style.css";
import { GET_JSON_REQUEST, getUserID } from "./utils.js";

const list = document.querySelector("#lecture-list");

function initialize({ lectures }) {
  if (!lectures.length) {
    list.innerHTML = "<li>No lectures yet.</li>";
    return;
  }
  for (const { uuid, name, createdAt } of lectures) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = `/pages/review-lecture.html?id=${uuid}`;
    a.textContent = `${name} — ${new Date(createdAt).toLocaleString()}`;
    li.appendChild(a);
    list.appendChild(li);
  }
}

async function fetchData() {
  const userId = getUserID();
  const params = new URLSearchParams({ userId });
  const res = await fetch(`/my-lectures?${params}`, GET_JSON_REQUEST).then((r) => r.json());
  if (res.error) {
    list.innerHTML = `<li>${res.error}</li>`;
    return;
  }
  initialize(res);
}

fetchData();
