import OpenAI from "openai";
import { EXERCISE_TYPE, SimulatedExerciseResponse } from "./models.js";
import { db } from "./database.js";

const N = 10; // How many simulated responses to create :)

const client = new OpenAI(); // reads OPENAI_API_KEY from env

export async function createSimulatedResponses(exercise, additionalContext) {
  let prompt;

  if (exercise.type === EXERCISE_TYPE.CODE_VARIANT) {
    prompt = createVariantPrompt(exercise);
  }

  if (exercise.type === EXERCISE_TYPE.POLL) {
    prompt = createPollPrompt(exercise, additionalContext);
  }

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

function createPollPrompt(exercise, additionalContext) {
  const { instructions, instructor_code } = exercise;

  return `Your job is to simulate student responses to an in-class poll exercise.
  The instructor has posed a question or prompt to students during a live coding lecture.
  I will provide the instructor's question (INSTRUCTIONS), the instructor's full code at the time of the poll (INSTRUCTOR_CODE), and optionally the specific code the instructor had selected when creating the poll (SELECTED_CODE).

  Give your response in JSON format as a list of strings which contain possible student responses. You should produce ${N} responses in total.
  Try to vary the responses somewhat, but keep them plausible -- it's okay if some are very similar.
  Some responses should display common misconceptions or partial understanding.
  Make sure you only respond with the JSON-parsable list of responses.
  If it is absolutely impossible to infer the intent of the question, return an empty JSON list.

  <INSTRUCTIONS>
  ${instructions}
  </INSTRUCTIONS>
  ${additionalContext ? `<INSTRUCTOR_CODE>\n  ${additionalContext}\n  </INSTRUCTOR_CODE>` : ""}
  ${instructor_code ? `<SELECTED_CODE>\n  ${instructor_code}\n  </SELECTED_CODE>` : ""}
  `;
}

function createVariantPrompt(exercise) {
  const { instructor_code, default_answer } = exercise;

  return `Your job is to simulate student responses to an in-class coding exercise.
  In this exercise, the instructor has shared their code and left a portion blank for students to fill in.
  I will provide for you the instructor's code (INSTRUCTOR CODE), which will have the string '{{ANSWER}}' where the student should fill in their own code.
  I will also provide for you what the instructor originally had in their editor where {{ANSWER}} is. We will call that ORIGINAL.
  We don't have access to the actual exercise instructions, so you have to infer it from INSTRUCTOR_CODE and from ORIGINAL.

  Give your response in JSON format as a list of strings which contain possible student responses. You should produce ${N} responses in total.
  Try to vary the responses somewhat, but keep them plausible (even if incorrect or incomplete) -- it's okay if some are very similar or the same.
  Some responses should display common misconceptions that a student might have, though only when it is relevant and feels like a plausible student response.
  Make sure you only respond with the JSON-parsable list of responses.
  If it is absolutely impossible to infer the intent of the question, you can return an empty JSON list.

  Here is the instructor's code and the code being replaced.
  <INSTRUCTOR_CODE>
  ${instructor_code}
  </ INSTRUCTOR_CODE>
  <ORIGINAL>
  ${default_answer}
  </ ORIGINAL>
  `;
}
