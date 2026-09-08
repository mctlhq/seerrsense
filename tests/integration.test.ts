import { test, expect, beforeAll } from "vitest";
import Fastify from "fastify";
import { buildServer } from "../src/api/server.js";
import { seerrClient } from "../src/providers/seerr/client.js";

// Mock the network calls
import { vi } from "vitest";
// The household Seerr. Both the singleton and the factory are stubbed: the
// server builds its default client through the factory now.
const householdSeerr = vi.hoisted(() => ({
  status: vi.fn().mockResolvedValue({ status: 200 }),
  search: vi.fn().mockResolvedValue([]),
  getMedia: vi.fn(),
  requestMedia: vi.fn(),
  findUserIdByEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/providers/seerr/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/providers/seerr/client.js")>()),
  seerrClient: householdSeerr,
  createDefaultSeerrClient: () => householdSeerr,
}));

let app: any;

beforeAll(async () => {
  app = buildServer();
  await app.ready();
});

test("GET /ready returns ready", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/ready"
  });
  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.payload)).toEqual({ status: "ready" });
});

test("POST /api/v1/request requires auth token", async () => {
  const expectedToken = "secret123"; // set in vitest script
  
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/request",
    payload: {
      mediaType: "movie",
      tmdbId: 123
    }
  });
  
  expect(response.statusCode).toBe(401);

  const authorized = await app.inject({
    method: "POST",
    url: "/api/v1/request",
    headers: {
      authorization: `Bearer ${expectedToken}`
    },
    payload: {
      mediaType: "movie",
      tmdbId: 123
    }
  });
  
  expect(authorized.statusCode).not.toBe(401);
});

test("MCP POST /mcp endpoint handles JSONRPC initialize", async () => {
  const expectedToken = "secret123";
  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${expectedToken}`
    },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2026-07-28",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" }
      }
    }
  });

  if (response.statusCode !== 200) {
     console.error(response.payload);
  }

  expect(response.statusCode).toBe(200);
  const dataMatch = response.payload.match(/data: ({.*})/);
  expect(dataMatch).toBeTruthy();
  const body = JSON.parse(dataMatch![1]);
  expect(body.result.protocolVersion).toBeDefined();
  expect(body.result.serverInfo.name).toBe("SeerrSense");
});

test("MCP POST /mcp listTools", async () => {
  const expectedToken = "secret123";
  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${expectedToken}`
    },
    payload: {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list"
    }
  });

  expect(response.statusCode).toBe(200);
  const dataMatch = response.payload.match(/data: ({.*})/);
  expect(dataMatch).toBeTruthy();
  const body = JSON.parse(dataMatch![1]);
  const tools = body.result.tools;
  expect(tools).toHaveLength(4);
  expect(tools.find((t: any) => t.name === "search_media")).toBeDefined();
  expect(tools.find((t: any) => t.name === "request_media")).toBeDefined();
  expect(tools.find((t: any) => t.name === "resolve_media")).toBeDefined();
});
