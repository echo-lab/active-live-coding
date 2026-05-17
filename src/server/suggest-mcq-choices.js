import OpenAI from "openai";

const client = new OpenAI();

export async function suggestMcqChoices({ instructions, instructor_code, full_instructor_code }) {
  const prompt = buildPrompt({ instructions, instructor_code, full_instructor_code });
  const response = await client.responses.create({
    model: "gpt-5.4-nano-2026-03-17",
    input: prompt,
  });
  try {
    return JSON.parse(response.output_text);
  } catch {
    return [];
  }
}

function buildPrompt({ instructions, instructor_code, full_instructor_code }) {
  let prompt = `You are helping an instructor create a multiple-choice question for a live coding lecture.
Suggest 4 plausible answer choices. Include one correct answer and three plausible but incorrect distractors.
If possible, the incorrect answers should also have educational value (e.g., surfacing common misconceptions, etc.).
Return ONLY a JSON array of exactly 4 strings (the choices). No other text. Don't make the choices longer than they need to be, though make sure they answer the question.
If the response contains a newline, don't escape the backslash (i.e., you should use \\n instead of \\\\n).
Do not return responses that only differ in the amount of whitespace.

Below I will provide more context, namely: INSTRUCTIONS, which are the instructions
for the exercise; SELECTED CODE, which indicates what code the instructor has selected (can be blank); 
and FULL INSTRUCTOR CODE, which is the contents of the instructor's code editor, and which may have irrelevant information.

INSTRUCTIONS: ${instructions || "(none)"}`;
  if (instructor_code) prompt += `\n\nSELECTED CODE:\n\`\`\`\n${instructor_code}\n\`\`\``;
  if (full_instructor_code) prompt += `\n\nFULL INSTRUCTOR CODE (context):\n\`\`\`\n${full_instructor_code}\n\`\`\``;
  return prompt;
}
