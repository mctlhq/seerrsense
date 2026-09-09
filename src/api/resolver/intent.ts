import { z } from "zod";
import { generateObject, NoObjectGeneratedError } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { config } from "../../core/config.js";

/**
 * How the title in `titleHint` was arrived at. The resolver reports a lower
 * confidence for a title it inferred than for one the user typed, and lower
 * still for one that is only a restatement of the query, so a caller can tell
 * a recognition from a guess. Optional because a model may omit it; a title
 * with no stated provenance is treated as inferred.
 */
export const TitleSourceSchema = z.enum(["stated", "recognised", "unknown"]);
export type TitleSource = z.infer<typeof TitleSourceSchema>;

export const MediaIntentSchema = z.object({
  mediaType: z.enum(["movie", "tv"]).optional(),
  titleHint: z.string().optional(),
  titleSource: TitleSourceSchema.optional(),
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

/**
 * Naming the work is the task, not a liberty.
 *
 * The previous prompt ended with "return only information supported or
 * strongly implied by the query", and the model obeyed it literally: asked for
 * "a programmer learns the world is a simulation" it put that whole sentence in
 * titleHint rather than answering "The Matrix", and the resolver then searched
 * Seerr for the sentence. The Russian phrasing produced titleHint "программист"
 * with the real answer stranded in similarTo. So the prompt has to say plainly
 * that identifying a described work is what is wanted, and that the answer goes
 * in titleHint as a canonical English title.
 */
const SYSTEM_PROMPT = `
You identify films and television series from a description.

A query may name a work outright, or it may only describe it: its plot, its
characters, its premise, its ending. Either way your job is to say which work
it is.

titleHint is the work's canonical English title, the one The Movie Database
lists it under. Never put the user's own words there, and never put a
description there. A query written in another language still gets an English
title back.

titleSource says how you arrived at it:
  stated      the query named the work; you are repeating that name
  recognised  the query only described it and you identified it
  unknown     you cannot tell which work is meant, so titleHint stays empty

Recognising a work from its description is the point of this task. "A
programmer learns the world is a simulation" is The Matrix. Say so.

If more than one work fits, put your best answer in titleHint and the next best
in similarTo. If you genuinely cannot tell, set titleSource to unknown and fill
in whatever mediaType, year, genres and plotHint the query supports.

titleHint and similarTo each hold one bare title and nothing else: no release
year, no parentheses, no "or", no explanation. The year goes in the year field.

year is the release year of the work you identified.

Never invent or return TMDB, IMDb or other provider IDs.
`;

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
    try {
      const { object } = await generateObject({
        model: this.model(this.modelName),
        schema: MediaIntentSchema,
        temperature: 0,
        system: SYSTEM_PROMPT,
        prompt: query,
        // A filled-in intent is a few dozen tokens. Asked "that film with the
        // thing in it" the model instead ran to 8514 tokens without ever
        // closing the object, the SDK retried, and the caller's request hung
        // for minutes. These three bounds turn that into a fast, ordinary
        // "could not determine which work this is".
        maxOutputTokens: 400,
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(20_000),
      });

      return object;
    } catch (error) {
      // The model failing to produce an intent is an answer: this query does
      // not identify a work. A transport or credential failure is not, and
      // must keep surfacing as an error rather than as a shrug.
      if (NoObjectGeneratedError.isInstance(error)) return {};
      throw error;
    }
  }
}
