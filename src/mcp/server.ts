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
import { describeError } from "../core/errors.js";

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
 * tools are safe to call again with the same arguments. `request_media` is
 * the one write: `readOnlyHint: false` is what makes Claude and ChatGPT
 * confirm with the person before calling it (the description used to ask
 * for that in words, which the directories reject as an instruction to the
 * model). It is *not* destructive in the spec's sense — filing a request
 * adds a row on the person's Seerr and removes or overwrites nothing, and
 * the tool refuses when the title is already there — so `destructiveHint`
 * is false. Annotation accuracy is the thing a reviewer compares against
 * behaviour; caution expressed as a wrong hint reads as mis-annotation.
 *
 * `openWorldHint: false` everywhere: every tool talks to one bounded system,
 * the Seerr the person attached, never the open internet.
 */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

const ResolutionResultSchema = z.object({
  candidate: MediaCandidateSchema,
  confidence: z.number().min(0).max(1).describe("How sure the resolver is, 0 to 1"),
  matchReason: z.string().describe("Why this candidate was chosen"),
});

/**
 * What `whoami` returns: the caller's principal and nothing from the
 * catalogue. It exists for the aggregate portal's identity check (user A and
 * user B must reach this upstream as two different people, mctlhq/.github#44)
 * and is the first tool on that portal's allowlist, so it must stay free of
 * anything a person would not want a shared surface to show.
 */
const WhoamiSchema = z.object({
  subject: z.string().optional().describe("The OAuth subject this session was resolved for; absent in stdio mode"),
  email: z.string().describe("The Google account the session belongs to; empty for the legacy shared token and stdio"),
  source: z.enum(["own", "household", "none"]).describe("Whose Seerr this session reaches: the caller's own, a household member's, or none yet"),
  connected: z.boolean().describe("Whether a Seerr is reachable for this session at all"),
});

const SearchResultSchema = z.object({
  results: z.array(MediaCandidateSchema).describe("Up to five best matches, in Seerr's order"),
});

/** Overseerr's MediaRequestStatus codes, as names a person can read. */
const REQUEST_STATUS: Record<number, string> = { 1: "PENDING", 2: "APPROVED", 3: "DECLINED", 4: "FAILED", 5: "COMPLETED" };

const RequestResultSchema = z.object({
  requestId: z.number().int().positive().optional().describe("The request's id in Seerr, when Seerr returned one"),
  requestStatus: z.string().describe("PENDING, APPROVED, DECLINED, FAILED, COMPLETED, or UNKNOWN when Seerr did not say"),
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
  // What Seerr says it filed wins, but only when it says something: an empty
  // or unparseable list from Seerr must not erase the seasons the caller asked
  // for, which are the better information in that case.
  const fromSeerr = Array.isArray(record.seasons)
    ? record.seasons
        .map((season) => (season && typeof season === "object" ? (season as Record<string, unknown>).seasonNumber : undefined))
        .filter((n): n is number => typeof n === "number" && n > 0)
    : [];
  const seasons = payload.mediaType === "tv" && fromSeerr.length > 0 ? fromSeerr : payload.seasons;
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
/** What explain() needs to know about who asked and what they called. */
export interface ExplainContext {
  accountUrl: string;
  /** The person attached this Seerr themselves, so /account is where to fix it. */
  own: boolean;
  /** Whether the tool takes a TMDB id (a 404 then means "no such title"). */
  byId: boolean;
}

export function explain(error: unknown, ctx: ExplainContext, log: (error: unknown) => void): string {
  const { accountUrl, own, byId } = ctx;
  // The household Seerr is the operator's: a signed-in person using it has no
  // connection of their own, so /account shows them nothing to update — and
  // it is not "your Seerr" to them, so the sentences say whose it is.
  const whose = own ? "Your Seerr" : "The shared Seerr";
  const fixKey = own
    ? `Update the API key on ${accountUrl}.`
    : "Its operator needs to update its API key.";
  const fixAddress = own
    ? `Check that it is running and that the address on ${accountUrl} is the root of your Seerr.`
    : "Its operator needs to check it.";
  if (error instanceof SeerrAccessChallengeError) {
    return own
      ? `Your Seerr is behind Cloudflare Access. Add its service token on ${accountUrl}.`
      : "The shared Seerr is behind Cloudflare Access; its operator needs to add the service token.";
  }
  // A per-user Seerr answers through fetchUntrusted, which folds every failure
  // into this one error and keeps the status only on the side. The status is
  // not always an upstream error: a refused redirect carries its 3xx, and an
  // oversized or non-JSON body carries the 2xx it came with — that is what a
  // login page or a reverse proxy at the wrong path looks like.
  const status =
    error instanceof SeerrUnreachableError
      ? error.upstreamStatus
      : Number(/^Seerr API error: (\d{3})/.exec(error instanceof Error ? error.message : "")?.[1]) || undefined;
  if (status === 401 || status === 403) return `${whose} rejected the API key. ${fixKey}`;
  if (status === 404) {
    return byId
      ? "Seerr does not know that title. Check the media type and TMDB id."
      : `${whose} answered 404 to a search, which usually means the address is not its API root. ${fixAddress}`;
  }
  // Any other 4xx or 5xx is an error on the Seerr side — 429 from a proxy in
  // front of it being the realistic 4xx — and not an address problem.
  if (status !== undefined && status >= 400) {
    return `${whose} answered with an error (${status}). Try again in a moment.`;
  }
  if (error instanceof SeerrUnreachableError) {
    return status !== undefined
      ? `${whose} answered, but not with its API (${status}). ${fixAddress}`
      : `SeerrSense could not reach ${own ? "your" : "the shared"} Seerr. ${fixAddress}`;
  }
  if (error instanceof ResolveBudgetError) return error.message;
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Media is already in status: ")) {
    const state = message.slice("Media is already in status: ".length);
    return `That title is already ${state.toLowerCase().replace(/_/g, " ")} on your Seerr, so nothing was requested.`;
  }
  if (message.startsWith("LLM_UNAVAILABLE")) {
    return "No exact title matched and the language-model fallback is not configured. Try search_media with the exact title.";
  }
  if (message.startsWith("Semantic resolution failed")) {
    return "Could not work out which title was meant. Try search_media with a more specific title, or add the year.";
  }
  // Anything else — a model provider outage, a rejected provider key, a guard
  // refusal — may carry a URL or an upstream response body in its message.
  // That goes to the log, where the operator can read it, and not to the
  // assistant, where the person would.
  log(error);
  return "Something went wrong on SeerrSense's side. Try again in a moment.";
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
export function createSeerrSenseMcpServer(
  scopes?: string[],
  tenant?: Tenant,
  budget?: McpBudget,
  log: (error: unknown) => void = (error) => console.error("tool failed", describeError(error)),
) {
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
  const own = tenant?.source === "own";
  const failed = (error: unknown, byId = false) => ({
    isError: true as const,
    content: [{ type: "text" as const, text: explain(error, { accountUrl, own, byId }, log) }],
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

  mcpServer.registerTool("whoami",
    {
      title: "Who am I",
      description:
        "Returns who this session is authenticated as and whose Seerr it reaches. " +
        "Reads nothing from the catalogue; safe to expose on any surface.",
      inputSchema: z.object({}),
      outputSchema: WhoamiSchema,
      annotations: { title: "Who am I", ...READ_ONLY },
    },
    async () =>
      ok({
        subject: tenant?.subject,
        email: tenant?.email ?? "",
        source: tenant?.source ?? "none",
        connected: Boolean(client),
      })
  );

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
        return failed(error, true);
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
        return failed(error, true);
      }
    }
  );

  return mcpServer;
}
