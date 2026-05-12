import OpenAI from "openai";
import { EXERCISE_TYPE } from "./models.js";

const client = new OpenAI(); // reads OPENAI_API_KEY from env

export async function createGroupSummary(exercise, realResponses, simulatedResponses) {
  const allResponses = [
    ...realResponses.map((r) => ({ id: `real_${r.id}`, answer: r.answer })),
    ...simulatedResponses.map((r) => ({ id: `sim_${r.id}`, answer: r.answer })),
  ];

  if (allResponses.length <= 3) return;  // Not worth grouping just 3!
  if (exercise.type !== EXERCISE_TYPE.CODE_VARIANT) return;

  const prompt = buildPrompt(exercise, allResponses);
  if (!prompt) return;

  const response = await client.responses.create({
    model: "gpt-5.4-nano-2026-03-17",
    input: prompt,
  });

  let groups;
  try {
    groups = JSON.parse(response.output_text);
  } catch (error) {
    console.log("Failed to parse group summary response:", error);
  }

  return groups;
}

function buildPrompt(exercise, allResponses) {
  if (exercise.type === EXERCISE_TYPE.CODE_VARIANT) {
    return buildPromptVariant(exercise, allResponses);
  }
  return;
}

function buildPromptVariant(exercise, allResponses) {
  const { instructor_code, default_answer } = exercise;

  return `You are analyzing student responses to an in-class coding exercise and coming up with reasonable groupings.
I will explain all the inputs ("Instructor code", "Default fill", and "Student responses") and provide them with HTML-style tags.
After, I will give detailed instructions on the output format.

This is a fill-in-the-blank coding exercise.
The instructor's code has a blank (shown as {{ANSWER}}) where students must fill in code.
Here is the instructor's code:
<Instructor code>
${instructor_code}
</Instructor code>

The blank slot in the code editor is originally filled with a default value, which may have additional instructions or may be meaningless or even empty.
Here is the default fill:
<Default fill>
${default_answer}
</Default fill>

Here are the student responses, each with an unique ID and their given answer.
<Student responses>
${allResponses.map((r) => `ID: ${r.id}\nAnswer: ${r.answer}`).join("\n\n")}
</Student responses>


Group these responses into approximately 2-5 groups based on their conceptual approach or common theme (e.g., same strategy, same mistake, same pattern).
Each group should have a very short description (<6 words) and a list of the response IDs that belong to it.
Every response should appear in exactly one group, and it's okay if the last group is "misc".

Return your answer as a JSON array with no additional text. Each element should be an object with:
- "description": a short string (a few words) describing what this group of responses has in common
- "response_ids": an array of response ID strings (e.g. ["S03", "Danny"])

Example format:
[
  { "description": "for loop", "response_ids": ["real_1", "sim_3"] },
  { "description": "list comprehension", "response_ids": ["real_2", "sim_1", "sim_2"] }
]
`;
}
