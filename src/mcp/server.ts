import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Tenant } from "../providers/seerr/tenants.js";
import { notConnectedMessage } from "../providers/seerr/tenants.js";
import { MediaCandidateSchema, MediaTypeSchema } from "../core/media.js";
import { MediaRequestService } from "../api/service.js";
import { MediaResolver } from "../api/resolver/index.js";
import { NebiusIntentExtractor } from "../api/resolver/intent.js";
import { BudgetedIntentExtractor, ResolveBudgetError, type ResolveBudgetOptions } from "../api/resolver/budget.js";
import { SeerrAccessChallengeError, SeerrUnreachableError } from "../providers/seerr/client.js";
import type { AuthStore } from "../auth/store.js";
import { config } from "../core/config.js";
import { SCOPE_REQUEST } from "../auth/config.js";

export interface McpBudget {
  store: AuthStore;
  options: ResolveBudgetOptions;
}

/**
 * The version a client sees in `serverInfo` is the package version, not a
 * literal that nobody remembers to bump. `package.json` sits two levels above
 * this file both in `src/` and in `dist/`, and the Dockerfile copies it next
 * to `dist/`, so the same relative path works in every mode.
 */
const SERVER_VERSION: string = createRequire(import.meta.url)("../../package.json").version;

/**
 * Tool annotations as the connector directories read them. The three read
 * tools are safe to call again with the same arguments; `request_media` is
 * the one write, and it is marked destructive on purpose: filing a request
 * changes state on the person's own Seerr, and both Claude and ChatGPT use
 * this hint to confirm with the user before calling it. The tool description
 * used to ask for that confirmation in words, which the directories reject as
 * an instruction to the model rather than a description of the tool.
 *
 * `openWorldHint: false` everywhere: every tool talks to one bounded system,
 * the Seerr the person attached, never the open internet.
 */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

const ResolutionResultSchema = z.object({
  candidate: MediaCandidateSchema,
  confidence: z.number().min(0).max(1).describe("How sure the resolver is, 0 to 1"),
  matchReason: z.string().describe("Why this candidate was chosen"),
});

const SearchResultSchema = z.object({
  results: z.array(MediaCandidateSchema).describe("Up to five best matches, in Seerr's order"),
});

/** Overseerr's request status codes, as names a person can read. */
const REQUEST_STATUS: Record<number, string> = { 1: "PENDING", 2: "APPROVED", 3: "DECLINED" };

const RequestResultSchema = z.object({
  requestId: z.number().int().positive().optional().describe("The request's id in Seerr, when Seerr returned one"),
  requestStatus: z.string().describe("PENDING, APPROVED, DECLINED or UNKNOWN"),
  mediaType: MediaTypeSchema,
  tmdbId: z.number().int().positive(),
  seasons: z.array(z.number().int().positive()).optional().describe("The seasons the request covers (TV only)"),
});

/**
 * A raw Seerr request object carries the requesting user's account, e-mail
 * and avatar, timestamps and internal ids. None of that is what the person
 * asked for, and a directory review counts it as data returned without a
 * reason, so the answer is reduced to the request itself.
 */
function summariseRequest(
  raw: unknown,
  payload: { mediaType: "movie" | "tv"; tmdbId: number; seasons?: number[] },
): z.infer<typeof RequestResultSchema> {
  const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const requestId = typeof record.id === "number" && record.id > 0 ? record.id : undefined;
  const requestStatus = typeof record.status === "number" ? (REQUEST_STATUS[record.status] ?? "UNKNOWN") : "UNKNOWN";
  const seasons =
    payload.mediaType === "tv" && Array.isArray(record.seasons)
      ? record.seasons
          .map((season) => (season && typeof season === "object" ? (season as Record<string, unknown>).seasonNumber : undefined))
          .filter((n): n is number => typeof n === "number" && n > 0)
      : payload.seasons;
  return {
    requestId,
    requestStatus,
    mediaType: payload.mediaType,
    tmdbId: payload.tmdbId,
    ...(seasons && seasons.length > 0 ? { seasons } : {}),
  };
}

/**
 * Every failure a tool can meet, said in a way the person can act on. The
 * raw `error.message` used to be relayed verbatim, which for a Seerr outage
 * read "Seerr API error: 502 Bad Gateway" and for a model outage read an
 * internal marker. A reviewer calling each tool expects to learn what to do
 * next, not which layer broke.
 */
function explain(error: unknown, accountUrl: string): string {
  if (error instanceof SeerrAccessChallengeError) {
    return `Your Seerr is behind Cloudflare Access. Add its service token on ${accountUrl}.`;
  }
  if (error instanceof SeerrUnreachableError) {
    return `SeerrSense could not reach your Seerr. Check that it is running and that the address on ${accountUrl} is right.`;
  }
  if (error instanceof ResolveBudgetError) return error.message;
  const message = error instanceof Error ? error.message : String(error);
  const upstream = /^Seerr API error: (\d{3})/.exec(message);
  if (upstream) {
    const status = Number(upstream[1]);
    if (status === 401 || status === 403) {
      return `Your Seerr rejected the API key. Update it on ${accountUrl}.`;
    }
    if (status === 404) return "Seerr does not know that title. Check the media type and TMDB id.";
    return `Your Seerr answered with an error (${status}). Try again in a moment.`;
  }
  if (message.startsWith("Media is already in status: ")) {
    const status = message.slice("Media is already in status: ".length);
    return `That title is already ${status.toLowerCase().replace(/_/g, " ")} on your Seerr, so nothing was requested.`;
  }
  if (message.startsWith("LLM_UNAVAILABLE")) {
    return "No exact title matched and the language-model fallback is not configured. Try search_media with the exact title.";
  }
  if (message.startsWith("Semantic resolution failed")) {
    return "Could not work out which title was meant. Try search_media with a more specific title, or add the year.";
  }
  return message;
}

/**
 * One MCP server for one caller.
 *
 * `scopes` is what the caller was granted; `tenant` is which Seerr they reach
 * and as whom. Both are undefined in stdio mode, where the client owns the
 * process: there is nothing to scope and only the local instance to talk to.
 * `budget`, likewise, is undefined in stdio mode and whenever there is no
 * database-backed store to count against — the daily resolve ceiling then
 * simply does not apply.
 */
export function createSeerrSenseMcpServer(scopes?: string[], tenant?: Tenant, budget?: McpBudget) {
  const mcpServer = new McpServer({
    name: "SeerrSense",
    title: "SeerrSense",
    version: SERVER_VERSION,
  });

  const accountUrl = config.SEERRSENSE_PUBLIC_URL ? `${config.SEERRSENSE_PUBLIC_URL}/account` : "the account page";
  const client = tenant?.client;
  const notConnected = () => ({
    isError: true as const,
    content: [{ type: "text" as const, text: notConnectedMessage(config.SEERRSENSE_PUBLIC_URL) }],
  });
  const failed = (error: unknown) => ({
    isError: true as const,
    content: [{ type: "text" as const, text: explain(error, accountUrl) }],
  });
  const ok = <T extends Record<string, unknown>>(structuredContent: T) => ({
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  });

  const mediaService = client
    ? new MediaRequestService(client, tenant?.attributedUserId)
    : undefined;

  let intentExtractor;
  if (config.NEBIUS_API_KEY) {
    intentExtractor = new NebiusIntentExtractor();
    if (budget) {
      intentExtractor = new BudgetedIntentExtractor(intentExtractor, budget.store, tenant?.subject, budget.options);
    }
  }
  const mediaResolver = client ? new MediaResolver(client, intentExtractor) : undefined;

  mcpServer.registerTool("search_media",
    {
      title: "Search media",
      description:
        "Searches the person's Overseerr or Jellyseerr for films and series by title. " +
        "Returns up to five matches with their TMDB id and whether each is already available or requested.",
      inputSchema: z.object({ query: z.string().min(1).describe("A title, or part of one") }),
      outputSchema: SearchResultSchema,
      annotations: { title: "Search media", ...READ_ONLY },
    },
    async ({ query }) => {
      try {
        if (!client) return notConnected();
        const results = await client.search(query);
        return ok({ results: results.slice(0, 5) });
      } catch (error) {
        return failed(error);
      }
    }
  );

  mcpServer.registerTool("resolve_media",
    {
      title: "Resolve a description to a title",
      description:
        "Works out which film or series a plain-language description refers to, such as " +
        "\"the Nolan film about dreams\", and returns one verified candidate from the person's Seerr " +
        "with a confidence score. Use search_media when the exact title is already known.",
      inputSchema: z.object({ query: z.string().min(1).describe("A description or an approximate title") }),
      outputSchema: ResolutionResultSchema,
      annotations: { title: "Resolve a description to a title", ...READ_ONLY },
    },
    async ({ query }) => {
      try {
        if (!mediaResolver) return notConnected();
        return ok(await mediaResolver.resolveMedia(query));
      } catch (error) {
        return failed(error);
      }
    }
  );

  mcpServer.registerTool("get_media",
    {
      title: "Get media details",
      description:
        "Returns the canonical record for one film or series by TMDB id from the person's Seerr, " +
        "including its availability and request status there.",
      inputSchema: z.object({
        mediaType: MediaTypeSchema,
        tmdbId: z.number().int().positive().describe("The TMDB id, as returned by search_media or resolve_media"),
      }),
      outputSchema: MediaCandidateSchema,
      annotations: { title: "Get media details", ...READ_ONLY },
    },
    async ({ mediaType, tmdbId }) => {
      try {
        if (!client) return notConnected();
        return ok(await client.getMedia(mediaType, tmdbId));
      } catch (error) {
        return failed(error);
      }
    }
  );

  mcpServer.registerTool("request_media",
    {
      title: "Request media",
      description:
        "Files a request for a film or series in the person's own Overseerr or Jellyseerr, " +
        "optionally for named seasons. Refuses when the title is already available, pending or blocklisted there. " +
        "Requires the seerr:request scope.",
      inputSchema: z.object({
        mediaType: MediaTypeSchema,
        tmdbId: z.number().int().positive().describe("The TMDB id, as returned by search_media or resolve_media"),
        seasons: z.array(z.number().int().positive()).optional().describe("Specific seasons to request (TV only). Omit to request all seasons."),
      }),
      outputSchema: RequestResultSchema,
      annotations: { title: "Request media", ...WRITE },
    },
    async (payload) => {
      // Reading the catalogue and asking the household to fetch something are
      // different privileges, so the write tool checks its own scope rather
      // than trusting the transport to have gated it.
      if (scopes && !scopes.includes(SCOPE_REQUEST)) {
        return {
          isError: true,
          content: [{ type: "text", text: `this token is not granted the ${SCOPE_REQUEST} scope` }]
        };
      }
      if (!mediaService) return notConnected();
      try {
        const raw = await mediaService.requestMediaSafely(payload);
        return ok(summariseRequest(raw, payload));
      } catch (error) {
        return failed(error);
      }
    }
  );

  return mcpServer;
}
