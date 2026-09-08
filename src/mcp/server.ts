import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { seerrClient } from "../providers/seerr/client.js";
import { MediaTypeSchema } from "../core/media.js";
import { MediaRequestService } from "../api/service.js";
import { MediaResolver } from "../api/resolver/index.js";
import { NebiusIntentExtractor } from "../api/resolver/intent.js";
import { config } from "../core/config.js";
import { SCOPE_REQUEST } from "../auth/config.js";

/**
 * `scopes` is the authenticated caller's granted scopes, when the request came
 * through the OAuth gate. `undefined` means no authorization context at all —
 * stdio mode, where the client owns the process and there is nothing to scope.
 */
export function createSeerrSenseMcpServer(scopes?: string[]) {
  const mcpServer = new McpServer({
    name: "SeerrSense",
    version: "1.0.0"
  });

  const mediaService = new MediaRequestService();
  
  let intentExtractor;
  if (config.NEBIUS_API_KEY) {
    intentExtractor = new NebiusIntentExtractor();
  }
  const mediaResolver = new MediaResolver(seerrClient, intentExtractor);

  mcpServer.registerTool("search_media",
    {
      description: "Exact or fuzzy Seerr search query (not semantic yet)",
      inputSchema: z.object({ query: z.string() })
    },
    async ({ query }) => {
      try {
        const results = await seerrClient.search(query);
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
        const result = await seerrClient.getMedia(mediaType, tmdbId);
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
