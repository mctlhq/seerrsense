import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateObject } from "ai";
import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const MediaIntentSchema = z.object({
  mediaType: z.enum(["movie", "tv"]).optional(),
  titleHint: z.string().optional(),
  year: z.number().int().optional(),
  people: z.array(z.string()).optional(),
  director: z.string().optional(),
  genres: z.array(z.string()).optional(),
  plotHint: z.string().optional(),
  similarTo: z.string().optional(),
});

const nebius = createOpenAICompatible({
  name: "nebius",
  baseURL: "https://api.tokenfactory.nebius.com/v1",
  apiKey: process.env.NEBIUS_API_KEY,
  supportsStructuredOutputs: true,
});

const routingCorpus = [
  "1+1",
  "Остров проклятых",
  "Брат 2",
  "Дюна",
  "Inception",
  "Dune 2021"
];

const semanticCorpus = [
  "фильм Нолана про сон во сне",
  "комедия с Джимом Керри где он адвокат и не может врать",
  "фильм Финчера где жена исчезает",
  "фильм про остров с психиатрической больницей с ДиКаприо",
  "фильм где человек проживает один и тот же день снова и снова",
  "сериал про сотрудников которым разделили рабочие и личные воспоминания"
];

const models = [
  "Qwen/Qwen3-30B-A3B-Instruct-2507",
  "Qwen/Qwen3-32B-fast"
];

async function runBakeOff() {
  if (!process.env.NEBIUS_API_KEY) {
    console.error("NEBIUS_API_KEY is required to run bake-off.");
    process.exit(1);
  }

  console.log("=== Semantic Bake-Off ===");
  console.log("| Query | Model | Latency | Tokens | Intent |");
  console.log("|-------|-------|---------|--------|--------|");

  for (const query of semanticCorpus) {
    for (const modelName of models) {
      const start = Date.now();
      try {
        const { object, usage } = await generateObject({
          model: nebius(modelName),
          schema: MediaIntentSchema,
          temperature: 0,
          system: `
Extract media search intent from the user's query.
Never invent or return TMDB, IMDb or other provider IDs.
Titles and years are hints only.
Return only information supported or strongly implied by the query.
`,
          prompt: query,
        });
        const latency = Date.now() - start;
        const tokens = (usage.promptTokens || 0) + (usage.completionTokens || 0);
        console.log(`| ${query.substring(0, 20)}... | ${modelName.replace("Qwen/Qwen3-", "")} | ${latency}ms | ${tokens} | ${object.titleHint} |`);
      } catch (e: any) {
        console.log(`| ${query.substring(0, 20)}... | ${modelName.replace("Qwen/Qwen3-", "")} | ERROR | ERROR | ${e.message} |`);
      }
    }
  }
}

runBakeOff().catch(console.error);
