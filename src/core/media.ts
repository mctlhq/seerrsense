import { z } from "zod";

export const MediaTypeSchema = z.enum(["movie", "tv"]);
export type MediaType = z.infer<typeof MediaTypeSchema>;

export const MediaStatusSchema = z.enum([
  "UNKNOWN",
  "PENDING",
  "PROCESSING",
  "PARTIALLY_AVAILABLE",
  "AVAILABLE",
  "BLOCKLISTED",
  "DELETED"
]);
export type MediaStatus = z.infer<typeof MediaStatusSchema>;

export const MediaCandidateSchema = z.object({
  provider: z.literal("tmdb").default("tmdb"),
  providerId: z.number().int().positive(),
  mediaType: MediaTypeSchema,
  title: z.string(),
  originalTitle: z.string().optional().nullable(),
  year: z.number().int().positive().optional().nullable(),
  posterUrl: z.string().optional().nullable(),
  overview: z.string().optional().nullable(),
  status: MediaStatusSchema.default("UNKNOWN")
});
export type MediaCandidate = z.infer<typeof MediaCandidateSchema>;

// Request parameters schemas for REST / API
export const MediaParamsSchema = z.object({
  mediaType: MediaTypeSchema,
  tmdbId: z.coerce.number().int().positive(),
});

export const RequestBodySchema = z.object({
  mediaType: MediaTypeSchema,
  tmdbId: z.number().int().positive(),
  seasons: z.array(z.number().int().positive()).optional(),
});

// Seerr raw response schemas (simplified)
export const SeerrMediaInfoSchema = z.object({
  status: z.number().optional()
}).passthrough().optional();

export const SeerrResultItemSchema = z.object({
  id: z.number().int().positive(),
  mediaType: z.string().optional(),
  title: z.string().optional(),
  name: z.string().optional(),
  originalTitle: z.string().optional(),
  originalName: z.string().optional(),
  releaseDate: z.string().optional(),
  firstAirDate: z.string().optional(),
  backdropPath: z.string().nullable().optional(),
  posterPath: z.string().nullable().optional(),
  overview: z.string().optional(),
  mediaInfo: SeerrMediaInfoSchema
}).passthrough();

export const SeerrSearchResponseSchema = z.object({
  results: z.array(SeerrResultItemSchema).optional()
}).passthrough();
