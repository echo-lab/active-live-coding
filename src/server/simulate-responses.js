import OpenAI from "openai";
import { SimulatedExerciseResponse } from "./models.js";
import { db } from "./database.js";

const client = new OpenAI(); // reads OPENAI_API_KEY from env

export async function createSimulatedResponses(info, exerciseId) {
  // TODO: Replace this dummy prompt with a real one
  // const prompt = `You are simulating student responses to a classroom exercise. Exercise: ${exercise.instructions}`;
  const prompt = `Return the string "hello" and no other text.`;

  let response = await client.responses.create({
    model: "gpt-5.4-nano-2026-03-17",
    input: prompt,
  });

  let output = response.output_text;

  // console.log("OpenAI response details: ", response);
  console.log("OpenAI response: ", output);


  // TODO: parse the results and save them to the DB :) 

  // TODO: Do something meaningful with the results (e.g., parse multiple responses, store each as a SimulatedExerciseResponse)
  // await SimulatedExerciseResponse.create({
  //   ClassExerciseId: exercise.id,
  //   answer: responseText,
  // });
}
