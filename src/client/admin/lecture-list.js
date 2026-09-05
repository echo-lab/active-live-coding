import "../style.css";
import "./style-admin.css";
import { GET_JSON_REQUEST } from "../utils.js";

const tbody = document.querySelector("#admin-lecture-table-body");

function render(lectures) {
  if (lectures.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="6">No lectures found.</td>`;
    tbody.appendChild(tr);
    return;
  }
  for (const { id, name, instructor_id, createdAt, isFinished } of lectures) {
    const tr = document.createElement("tr");
    const status = isFinished ? "CLOSED" : "OPEN";
    tr.classList.add(status);
    tr.innerHTML = `
      <td>${id}</td>
      <td>${instructor_id}</td>
      <td>${name ?? ""}</td>
      <td>${new Date(createdAt).toLocaleString()}</td>
      <td>${status}</td>
      <td><a href="/pages/admin/lecture-replay.html?id=${id}">Analyze &rarr;</a></td>
    `;
    tbody.appendChild(tr);
  }
}

async function fetchData() {
  const res = await fetch("/api/admin/lectures", GET_JSON_REQUEST).then((r) => r.json());
  if (res.error) {
    tbody.innerHTML = `<tr><td colspan="6">Error: ${res.error}</td></tr>`;
    return;
  }
  render(res.lectures);
}

fetchData();
