import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Tenant } from "../providers/seerr/tenants.js";
import { notConnectedMessage } from "../providers/seerr/tenants.js";
import { MediaTypeSchema } from "../core/media.js";
import { MediaRequestService } from "../api/service.js";
import { MediaResolver } from "../api/resolver/index.js";
import { NebiusIntentExtractor } from "../api/resolver/intent.js";
import { config } from "../core/config.js";
import { SCOPE_REQUEST } from "../auth/config.js";

/**
 * One MCP server for one caller.
 *
 * `scopes` is what the caller was granted; `tenant` is which Seerr they reach
 * and as whom. Both are undefined in stdio mode, where the client owns the
 * process: there is nothing to scope and only the local instance to talk to.
 */
export function createSeerrSenseMcpServer(scopes?: string[], tenant?: Tenant) {
  const mcpServer = new McpServer({
    name: "SeerrSense",
    version: "1.0.0"
  });

  const client = tenant?.client;
  const notConnected = () => ({
    isError: true as const,
    content: [{ type: "text" as const, text: notConnectedMessage(config.SEERRSENSE_PUBLIC_URL) }],
  });

  const mediaService = client
    ? new MediaRequestService(client, tenant?.attributedUserId)
    : undefined;

  let intentExtractor;
  if (config.NEBIUS_API_KEY) {
    intentExtractor = new NebiusIntentExtractor();
  }
  const mediaResolver = client ? new MediaResolver(client, intentExtractor) : undefined;

  mcpServer.registerTool("search_media",
    {
      description: "Exact or fuzzy Seerr search query (not semantic yet)",
      inputSchema: z.object({ query: z.string() })
    },
    async ({ query }) => {
      try {
        if (!client) return notConnected();
        const results = await client.search(query);
        return {
          content: [{ type: "text", text: JSON.stringify(results.slice(0, 5), null, 2) }]
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }]
        };
      }
    }
  );

  mcpServer.registerTool("resolve_media",
    {
      description: "Semantic search. Resolves a natural language query into a specific media item using LLM extraction and TMDB verification.",
      inputSchema: z.object({ query: z.string() })
    },
    async ({ query }) => {
      try {
        if (!mediaResolver) return notConnected();
        const result = await mediaResolver.resolveMedia(query);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }]
        };
      }
    }
  );

  mcpServer.registerTool("get_media",
    {
      description: "Get canonical media information from TMDB via Seerr",
      inputSchema: z.object({
        mediaType: MediaTypeSchema,
        tmdbId: z.number().int().positive()
      })
    },
    async ({ mediaType, tmdbId }) => {
      try {
        if (!client) return notConnected();
        const result = await client.getMedia(mediaType, tmdbId);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }]
        };
      }
    }
  );

  mcpServer.registerTool("request_media",
    {
      description: "Write action to request media download. Must ask user for confirmation first.",
      inputSchema: z.object({
        mediaType: MediaTypeSchema,
        tmdbId: z.number().int().positive(),
        seasons: z.array(z.number().int().positive()).optional().describe("Specific seasons to download (TV only). Omit to download all seasons.")
      })
    },
    async (payload) => {
      // Reading the catalogue and asking the household to download something
      // are different privileges, so the write tool checks its own scope
      // rather than trusting the transport to have gated it.
      if (scopes && !scopes.includes(SCOPE_REQUEST)) {
        return {
          isError: true,
          content: [{ type: "text", text: `this token is not granted the ${SCOPE_REQUEST} scope` }]
        };
      }
      if (!mediaService) return notConnected();
      try {
        const result = await mediaService.requestMediaSafely(payload);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }]
        };
      }
    }
  );

  return mcpServer;
}
