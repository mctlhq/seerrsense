import { z } from "zod";
import { generateObject } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { config } from "../../core/config.js";

export const MediaIntentSchema = z.object({
  mediaType: z.enum(["movie", "tv"]).optional(),
  titleHint: z.string().optional(),
  year: z.number().int().optional(),
  people: z.array(z.string()).optional(),
  director: z.string().optional(),
  genres: z.array(z.string()).optional(),
  plotHint: z.string().optional(),
  similarTo: z.string().optional(),
});

export type MediaIntent = z.infer<typeof MediaIntentSchema>;

export interface IntentExtractor {
  extract(query: string): Promise<MediaIntent>;
}

export class NebiusIntentExtractor implements IntentExtractor {
  private model: ReturnType<typeof createOpenAICompatible>;
  private modelName: string;

  constructor() {
    if (!config.NEBIUS_API_KEY) {
      throw new Error("NEBIUS_API_KEY is not configured");
    }

    this.model = createOpenAICompatible({
      name: "nebius",
      baseURL: "https://api.tokenfactory.nebius.com/v1",
      apiKey: config.NEBIUS_API_KEY,
      supportsStructuredOutputs: true,
    });
    this.modelName = config.NEBIUS_MODEL || "Qwen/Qwen3-30B-A3B-Instruct-2507";
  }

  async extract(query: string): Promise<MediaIntent> {
    const { object } = await generateObject({
      model: this.model(this.modelName),
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

    return object;
  }
}
