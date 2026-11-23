// Shared bits for the LLM prompts (group-responses.js, simulate-responses.js).

// Lectures can have multiple files, but we only send the one the exercise lives in.
export const OTHER_FILES_NOTE =
  "The workspace may contain other files that are not included here. They may or may not be relevant; do your best with the code provided.";

export const CONTEXT_OPEN = "<QUESTION_CONTEXT>";
export const CONTEXT_CLOSE = "</QUESTION_CONTEXT>";

// Returns the poll's file as it was when the poll was asked, with the instructor's anchored range
// wrapped in QUESTION_CONTEXT markers. Uses the positions in context_doc (not the highlighted text),
// so a blank or repeated line still points to the right spot. If there's no anchor, returns
// context_doc unchanged (null/undefined if the poll has no saved file).
export function annotatedPollFile(exercise) {
  const { context_doc, code_anchor_from, code_anchor_to } = exercise;
  if (context_doc == null || code_anchor_from == null) return context_doc;

  const from = Math.max(0, Math.min(code_anchor_from, context_doc.length));
  const to = Math.max(from, Math.min(code_anchor_to ?? from, context_doc.length));
  return (
    context_doc.slice(0, from) +
    CONTEXT_OPEN + context_doc.slice(from, to) + CONTEXT_CLOSE +
    context_doc.slice(to)
  );
}
