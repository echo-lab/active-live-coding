import "quill/dist/quill.core.css";
import "quill/dist/quill.snow.css";

import {
  CodeSnapshotBlot,
  createHTMLForCopyWorkaround,
} from "./codesnapshot.js";

import Quill from "quill";
import { POST_JSON_REQUEST } from "./utils.js";
Quill.register(CodeSnapshotBlot);

const Delta = Quill.import("delta");

export class NotesEditor {
  constructor({
    nodeId,
    deltas,
    sessionNumber,
    email,
    readOnly = false,
  }) {
    this.queuedDeltas = [];
    this.localVersionNum = deltas.length;
    this.serverVersionNum = deltas.length;
    this.sessionNumber = sessionNumber;
    this.active = true;
    this.email = email;
    this.lastSyncTime = Date.now();

    this.quill = new Quill(nodeId, {
      readOnly,
      modules: {
        clipboard: {
          matchers: [[".code-snapshot", (node, delta) => delta]],
        },
        toolbar: {
          // container: toolbarId,
          container: [[{ header: [1, false] }], ["bold", { list: "bullet" }]],
        },
      },
      placeholder: "Your notes here...",
      theme: "snow", // or 'bubble'
    });

    // Calculate the new document
    let doc = new Delta([{ insert: "\n" }]);
    // console.log("Deltas: ", deltas);
    deltas
      .map(({ change }) => new Delta(JSON.parse(change)))
      .forEach((change) => {
        // console.log("applying delta: ", change);
        doc = doc.compose(change);
      });
    this.quill.setContents(doc, Quill.sources.SILENT);

    this.quill.on("text-change", this.onEditorChange.bind(this));

    // This ensures that we highlight any code snapshots which are selected in the editor.
    this.quill.on("selection-change", (range, oldRange, source) => {
      document.querySelectorAll(".code-snapshot").forEach((el) => {
        let snapshot = Quill.find(el, true);
        if (!(snapshot instanceof CodeSnapshotBlot)) return;
        if (range === null) return;

        let x = snapshot.offset(this.quill.scroll);
        let { index, length } = range;
        if (index <= x && x < index + length) {
          el.classList.add("selected");
        } else {
          el.classList.remove("selected");
        }
      });
    });

    // Borrowed from discussion at: https://github.com/slab/quill/issues/3006
    let copySnapshotWorkaround = (ev, cutting) => {
      if (!ev.copyFromQuill) return;
      // ev.copyFromQuill is true, which means that the copy event originally came from
      // Code Mirror, but no text was selected. Thus, the user is trying to copy the whole code snippet,
      // which doesn't work unless we do something :)
      // What we're doing here is replacing the copy text w/ some HTML which can be matched by
      // our custom matcher because it has the correct class and fields for a CodeSnapshotBlot.
      let ops = this.quill.getContents(this.quill.getSelection()).ops;
      if (ops && ops.length !== 0 && ops[0].insert["codesnapshot"]) {
        let snapshot = ops[0].insert["codesnapshot"];
        ev.clipboardData.setData(
          "text/html",
          createHTMLForCopyWorkaround(snapshot)
        );
        if (cutting) {
          console.log("HI");
          let { index, length } = this.quill.getSelection();
          this.quill.deleteText(index, length, "user");
        }
      }
      ev.preventDefault();
    };

    document
      .querySelector(nodeId)
      .addEventListener("copy", (ev) => copySnapshotWorkaround(ev, false));
    document
      .querySelector(nodeId)
      .addEventListener("cut", (ev) => copySnapshotWorkaround(ev, true));

    // If we click on a code snapshot, we need to manually select it w/ Quill.
    this.quill.root.addEventListener("click", (ev) => {
      let snapshot = Quill.find(ev.target, true);
      if (!(snapshot instanceof CodeSnapshotBlot)) return;
      this.quill.setSelection(snapshot.offset(this.quill.scroll), 1, "user");
    });
  }

  reset() {
    this.quill.deleteText(0, this.quill.getLength());
  }

  applyChange(jsonChange) {
    let delta = new Delta(JSON.parse(jsonChange));
    this.quill.updateContents(delta, "silent");
  }

  getDocVersion() {
    return this.localVersionNum;
  }

  endSession() {
    this.active = false;
  }

  createAnchor(
    source,
    {
      id,
      selection,
      selectionPosition,
      fullCode,
      context,
      relativeSelectionPosition,
    }
  ) {
    // handleCodeAnchor && handleCodeAnchor({ selection, context, relativeSelectionPosition, fullCode, id });
    let { from: highlightStart, to: highlightEnd } = relativeSelectionPosition;
    let { from: selectionStart, to: selectionEnd } = selectionPosition;

    const range = this.quill.getSelection(true);
    let snippet = context;
    let title = `${source} (${new Date().toLocaleTimeString()})`;
    this.quill.insertText(range.index, "\n", Quill.sources.USER);
    this.quill.insertEmbed(
      range.index + 1,
      "codesnapshot",
      {
        id,
        snippet,
        highlightStart,
        highlightEnd,
        selectionStart,
        selectionEnd,
        fullCode,
        title,
      },
      Quill.sources.USER
    );
    this.quill.setSelection(range.index + 1, 1, Quill.sources.USER);
    this.quill.scrollSelectionIntoView();
  }

  onEditorChange(delta, oldDelta, source) {
    // console.log({ delta, oldDelta, source });
    // console.log(delta);
    this.queuedDeltas.push({
      delta,
      ts: Date.now(),
      changeNumber: this.localVersionNum,
    });
    this.localVersionNum++;
  }

  async flushChangesToServer() {
    if (this.queuedDeltas.length === 0 || !this.active) {
      this.lastSyncTime = Date.now();
      return;
    }

    let payload = {
      sessionNumber: this.sessionNumber,
      changes: this.queuedDeltas,
      email: this.email,
    };

    const response = await fetch("/record-notes-changes", {
      body: JSON.stringify(payload),
      ...POST_JSON_REQUEST,
    });
    const res = await response.json();

    if (res.error) {
      console.warn("Could not flush changes to server: ", res.error);
      if (Date.now() > this.lastSyncTime + 30 * 1000 && !this.alreadyAlerted) {
        this.alreadyAlerted = true;
        alert(
          "Warning: changes not syncing with the server. \n" +
            "You may want to consider copying your notes and refreshing the page."
        );
      }
      return;
    }

    console.log("Successfully flushed notes changes to server!");

    this.serverVersionNum = res.committedVersion;
    this.queuedDeltas = this.queuedDeltas.filter(
      (d) => d.changeNumber >= this.serverVersionNum
    );
    this.lastSyncTime = Date.now();
  }
}

export class ReadOnlyNotesEditor {
  constructor({ nodeId, deltas }) {
    this.quill = new Quill(nodeId, {
      readOnly: true,
      modules: {
        clipboard: {
          matchers: [[".code-snapshot", (node, delta) => delta]],
        },
        toolbar: null,
      },
      placeholder: "Your notes here...",
      theme: "snow", // or 'bubble'
    });

    // Calculate the new document
    let doc = new Delta([{ insert: "\n" }]);
    deltas
      .map(({ change }) => new Delta(JSON.parse(change)))
      .forEach((change) => {
        doc = doc.compose(change);
      });
    this.quill.setContents(doc, Quill.sources.SILENT);

    // If we click on a code snapshot, select it and scroll to it.
    this.quill.root.addEventListener("click", (ev) => {
      let snapshot = Quill.find(ev.target, true);
      if (!(snapshot instanceof CodeSnapshotBlot)) return;
      this.quill.setSelection(snapshot.offset(this.quill.scroll), 1, "user");
    });
  }
}
