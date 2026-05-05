import OpenAI from "openai";
import { EXERCISE_TYPE, SimulatedExerciseResponse } from "./models.js";
import { db } from "./database.js";

const N = 10; // How many simulated responses to create :)

const client = new OpenAI(); // reads OPENAI_API_KEY from env

export async function createSimulatedResponses(exercise) {
  let prompt;

  if (exercise.type === EXERCISE_TYPE.CODE_FITB) {
    prompt = createFITBPrompt(exercise);
  }
  // TODO: make the prompt for other exercise types.

  if (!prompt) return;

  let response = await client.responses.create({
    model: "gpt-5.4-nano-2026-03-17",
    input: prompt,
  });

  let simulatedAnswers;
  try {
    simulatedAnswers = JSON.parse(response.output_text);
  } catch(error) {
    console.log("Failed to get simulated answers: ", error);
  }

  if (!simulatedAnswers) {
    console.log("No answers!");
    return;
  }

  const records = await SimulatedExerciseResponse.bulkCreate(
    simulatedAnswers.map((answer, i) => ({
      ClassExerciseId: exercise.id,
      student_name: `S${String(i + 1).padStart(2, "0")}`,
      answer,
    }))
  );
  return records;
}

function createFITBPrompt(exercise) {
  const { instructor_code, code_line_context_start, code_line_context_end } = exercise;
  const allLines = instructor_code.split('\n');

  let prefix = allLines.slice(0, code_line_context_start - 1).join('\n');
  let middle = allLines.slice(code_line_context_start - 1, code_line_context_end).join('\n');
  let suffix = allLines.slice(code_line_context_end).join('\n');

  let code = `${prefix}\n{{ANSWER}}\n${suffix}`;

  return `Your job is to simulate student responses to an in-class coding exercise.
  In this exercise, the instructor has shared their code and left a portion blank for students to fill in.
  I will provide for you the instructor's code (INSTRUCTOR CODE), which will have the string '{{ANSWER}}' where the student should fill in their own code.
  I will also provide for you what the instructor originally had in their editor where {{ANSWER}} is. We will call that ORIGINAL.
  We don't have access to the actual exercise instructions, so you have to infer it from INSTRUCTOR_CODE and from ORIGINAL.
  
  Give your response in JSON format as a list of strings which contain possible student responses. You should produce ${N} responses in total.
  Try to vary the responses if possible, but keep them plausible (even if incorrect or incomplete) -- it's okay if some are very simialr or the same.
  Make sure you only respond with the JSON-parsable list of responses.
  If it is absolutely impossible to infer the intent of the question, you can return an empty JSON list.

  Here is the instructor's code and the code being replaced.
  <INSTRUCTOR_CODE>
  ${code}
  </ INSTRUCTOR_CODE>
  <ORIGINAL>
  ${middle}
  </ ORIGINAL>
  `;
}
