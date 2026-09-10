import { test, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { buildServer } from "../src/api/server.js";
import { seerrClient, SeerrAccessChallengeError, SeerrUnreachableError } from "../src/providers/seerr/client.js";

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

// What the connector directories check before a listing is accepted: every
// tool carries a title, the read/write hints, and an output schema, and no
// description tells the model how to behave.
test("every tool is annotated the way the directories require", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { accept: "application/json, text/event-stream", authorization: "Bearer secret123" },
    payload: { jsonrpc: "2.0", id: 4, method: "tools/list" },
  });
  const tools: any[] = JSON.parse(response.payload.match(/data: ({.*})/)![1]).result.tools;
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  for (const tool of tools) {
    expect(tool.name.length, tool.name).toBeLessThanOrEqual(64);
    expect(tool.title, tool.name).toBeTruthy();
    expect(tool.annotations?.title, tool.name).toBeTruthy();
    expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe("boolean");
    expect(typeof tool.annotations?.destructiveHint, tool.name).toBe("boolean");
    expect(typeof tool.annotations?.openWorldHint, tool.name).toBe("boolean");
    expect(tool.outputSchema?.type, tool.name).toBe("object");
    expect(tool.description, tool.name).not.toMatch(/must ask|confirm|download/i);
  }
  for (const name of ["search_media", "resolve_media", "get_media"]) {
    expect(byName[name].annotations.readOnlyHint, name).toBe(true);
    expect(byName[name].annotations.destructiveHint, name).toBe(false);
  }
  expect(byName.request_media.annotations.readOnlyHint).toBe(false);
  // Additive, not destructive: it files a request and removes nothing.
  expect(byName.request_media.annotations.destructiveHint).toBe(false);
  expect(byName.request_media.annotations.idempotentHint).toBe(false);
});

test("serverInfo carries the package version, not a literal", async () => {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { accept: "application/json, text/event-stream", authorization: "Bearer secret123" },
    payload: {
      jsonrpc: "2.0",
      id: 5,
      method: "initialize",
      params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "test-client", version: "1.0.0" } },
    },
  });
  const body = JSON.parse(response.payload.match(/data: ({.*})/)![1]);
  expect(body.result.serverInfo.version).toBe(version);
  expect(version).not.toBe("1.0.0");
});

// A tool with an output schema must answer with structuredContent or the SDK
// refuses the result; and the write tool must not relay the raw Seerr request
// object, which carries the requesting account's e-mail and avatar.
test("tool results carry structured content and no account details", async () => {
  householdSeerr.search.mockResolvedValueOnce([
    { provider: "tmdb", providerId: 7, mediaType: "movie", title: "Arrival", status: "UNKNOWN" },
  ]);
  householdSeerr.getMedia.mockResolvedValueOnce({
    provider: "tmdb", providerId: 7, mediaType: "movie", title: "Arrival", status: "UNKNOWN",
  });
  householdSeerr.requestMedia.mockResolvedValueOnce({
    id: 42,
    status: 1,
    createdAt: "2026-09-10T00:00:00Z",
    requestedBy: { id: 1, email: "owner@example.com", avatar: "https://gravatar/x" },
    media: { id: 9, tmdbId: 7 },
  });

  const call = async (name: string, args: Record<string, unknown>, id: number) => {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { accept: "application/json, text/event-stream", authorization: "Bearer secret123" },
      payload: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
    });
    expect(response.statusCode).toBe(200);
    return JSON.parse(response.payload.match(/data: ({.*})/)![1]);
  };

  const search = await call("search_media", { query: "arrival" }, 6);
  expect(search.result.isError).toBeFalsy();
  expect(search.result.structuredContent.results[0].title).toBe("Arrival");

  const request = await call("request_media", { mediaType: "movie", tmdbId: 7 }, 7);
  expect(request.error, JSON.stringify(request)).toBeUndefined();
  expect(request.result.isError).toBeFalsy();
  expect(request.result.structuredContent).toEqual({
    requestId: 42,
    requestStatus: "PENDING",
    mediaType: "movie",
    tmdbId: 7,
  });
  expect(JSON.stringify(request.result)).not.toContain("owner@example.com");
  expect(JSON.stringify(request.result)).not.toContain("createdAt");
});

// A per-user Seerr answers through fetchUntrusted, which folds every non-2xx
// into SeerrUnreachableError with the status on the side. A rotated key must
// come out as "update the key", not as "the host is down".
test("a rejected key and an Access challenge from a per-user Seerr are named", async () => {
  const call = async (id: number) => {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { accept: "application/json, text/event-stream", authorization: "Bearer secret123" },
      payload: { jsonrpc: "2.0", id, method: "tools/call", params: { name: "search_media", arguments: { query: "x" } } },
    });
    return JSON.parse(response.payload.match(/data: ({.*})/)![1]).result;
  };

  // The legacy token reaches the household Seerr: the fix is the operator's,
  // and the person is not sent to a page with nothing to update.
  householdSeerr.search.mockRejectedValueOnce(new SeerrUnreachableError("could not reach that Seerr", 401));
  const rejected = await call(9);
  expect(rejected.isError).toBe(true);
  expect(rejected.content[0].text).toMatch(/^The shared Seerr rejected the API key/);
  expect(rejected.content[0].text).toMatch(/operator/);
  expect(rejected.content[0].text).not.toMatch(/account|Your Seerr/);

  householdSeerr.search.mockRejectedValueOnce(new SeerrUnreachableError("could not reach that Seerr"));
  const down = await call(10);
  expect(down.content[0].text).toMatch(/could not reach the shared Seerr/);

  // A proxy's 429 is an error on that side, not a wrong address.
  householdSeerr.search.mockRejectedValueOnce(new SeerrUnreachableError("could not reach that Seerr", 429));
  const throttled = await call(17);
  expect(throttled.content[0].text).toMatch(/error \(429\)/);
  expect(throttled.content[0].text).not.toMatch(/API root|not with its API/);

  householdSeerr.search.mockRejectedValueOnce(new SeerrUnreachableError("could not reach that Seerr", 503));
  const failing = await call(11);
  expect(failing.content[0].text).toMatch(/answered with an error \(503\)/);

  householdSeerr.search.mockRejectedValueOnce(new SeerrAccessChallengeError());
  const access = await call(12);
  expect(access.content[0].text).toMatch(/Cloudflare Access/);
  expect(access.content[0].text).toMatch(/operator/);

  // A 2xx with a body that is not the API (a login page) is not "an error (200)".
  householdSeerr.search.mockRejectedValueOnce(new SeerrUnreachableError("could not reach that Seerr", 200));
  const notApi = await call(13);
  expect(notApi.content[0].text).toMatch(/not with its API \(200\)/);
  expect(notApi.content[0].text).not.toMatch(/error \(200\)/);

  // A 404 to a search is an address problem; a 404 by id is an unknown title.
  householdSeerr.search.mockRejectedValueOnce(new SeerrUnreachableError("could not reach that Seerr", 404));
  const searchMissing = await call(14);
  expect(searchMissing.content[0].text).toMatch(/API root/);
  expect(searchMissing.content[0].text).not.toMatch(/TMDB id/);
});

// The same sentences, addressed to a person who attached the Seerr themselves.
test("explain() sends an attached user to /account and a household user to the operator", async () => {
  const { explain } = await import("../src/mcp/server.js");
  const quiet = () => {};
  const own = { accountUrl: "https://s.test/account", own: true, byId: false };
  const household = { ...own, own: false };
  expect(explain(new SeerrUnreachableError("x", 401), own, quiet)).toBe(
    "Your Seerr rejected the API key. Update the API key on https://s.test/account.",
  );
  expect(explain(new SeerrUnreachableError("x", 401), household, quiet)).toMatch(/operator/);
  expect(explain(new SeerrUnreachableError("x", 302), own, quiet)).toMatch(/not with its API \(302\).*root of your Seerr/);
  expect(explain(new SeerrUnreachableError("x", 404), { ...own, byId: true }, quiet)).toMatch(/TMDB id/);
  expect(explain(new SeerrUnreachableError("x"), own, quiet)).toMatch(/could not reach your Seerr.*https:\/\/s.test\/account/);
  expect(explain(new SeerrUnreachableError("x", 404), household, quiet)).toMatch(/^The shared Seerr answered 404.*operator/);
  expect(explain(new SeerrAccessChallengeError(), own, quiet)).toMatch(/service token on https:\/\/s.test\/account/);
});

// The two schemas not exercised elsewhere: a mismatch would not degrade to
// text, the SDK refuses the whole result.
test("get_media and resolve_media answer within their output schemas", async () => {
  const candidate = { provider: "tmdb", providerId: 27205, mediaType: "movie", title: "Inception", year: 2010, status: "AVAILABLE" };
  householdSeerr.getMedia.mockResolvedValueOnce(candidate);
  householdSeerr.search.mockResolvedValueOnce([candidate]);
  const call = async (name: string, args: Record<string, unknown>, id: number) => {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { accept: "application/json, text/event-stream", authorization: "Bearer secret123" },
      payload: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
    });
    return JSON.parse(response.payload.match(/data: ({.*})/)![1]);
  };
  const got = await call("get_media", { mediaType: "movie", tmdbId: 27205 }, 15);
  expect(got.error, JSON.stringify(got)).toBeUndefined();
  expect(got.result.structuredContent).toMatchObject({ providerId: 27205, status: "AVAILABLE" });

  const resolved = await call("resolve_media", { query: "Inception" }, 16);
  expect(resolved.error, JSON.stringify(resolved)).toBeUndefined();
  expect(resolved.result.isError).toBeFalsy();
  expect(resolved.result.structuredContent).toMatchObject({ candidate: { providerId: 27205 }, confidence: 0.9 });
  expect(typeof resolved.result.structuredContent.matchReason).toBe("string");
});

// Anything unrecognised may carry a provider URL or an upstream body; the
// assistant gets a generic sentence and the detail goes to the log.
test("an unknown failure is not relayed to the caller", async () => {
  householdSeerr.search.mockRejectedValueOnce(new Error("APICallError: https://api.provider.example/v1 answered 500: {\"secret\":true}"));
  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { accept: "application/json, text/event-stream", authorization: "Bearer secret123" },
    payload: { jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "search_media", arguments: { query: "x" } } },
  });
  const body = JSON.parse(response.payload.match(/data: ({.*})/)![1]);
  expect(body.result.isError).toBe(true);
  expect(body.result.content[0].text).toMatch(/Something went wrong on SeerrSense's side/);
  expect(body.result.content[0].text).not.toContain("api.provider.example");
});

test("a TV request keeps the seasons asked for when Seerr returns none", async () => {
  householdSeerr.getMedia.mockResolvedValueOnce({
    provider: "tmdb", providerId: 95396, mediaType: "tv", title: "Severance", status: "UNKNOWN",
  });
  householdSeerr.requestMedia.mockResolvedValueOnce({ id: 43, status: 4, seasons: [] });
  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { accept: "application/json, text/event-stream", authorization: "Bearer secret123" },
    payload: {
      jsonrpc: "2.0", id: 14, method: "tools/call",
      params: { name: "request_media", arguments: { mediaType: "tv", tmdbId: 95396, seasons: [3] } },
    },
  });
  const body = JSON.parse(response.payload.match(/data: ({.*})/)![1]);
  expect(body.result.structuredContent).toEqual({ requestId: 43, requestStatus: "FAILED", mediaType: "tv", tmdbId: 95396, seasons: [3] });
});

// Errors are for the person, not the operator: an outage on the Seerr side
// says what to check rather than which HTTP status the upstream produced.
test("a Seerr failure is explained in actionable terms", async () => {
  householdSeerr.search.mockRejectedValueOnce(new Error("Seerr API error: 502 Bad Gateway"));
  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { accept: "application/json, text/event-stream", authorization: "Bearer secret123" },
    payload: { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "search_media", arguments: { query: "x" } } },
  });
  const body = JSON.parse(response.payload.match(/data: ({.*})/)![1]);
  expect(body.result.isError).toBe(true);
  expect(body.result.content[0].text).toMatch(/answered with an error \(502\)/);
  expect(body.result.content[0].text).not.toContain("Bad Gateway");
});

// The tenant has to survive the trip into the MCP handler. It travels on the
// AuthInfo, not on the Node request: the SDK hands the factory a WHATWG Request
// rebuilt from the incoming one, so anything hung off `request.raw` is lost and
// every tool call answers "no Seerr is connected". Only a call through /mcp
// catches that — resolving the tenant in isolation always looked correct.
test("a tool call over /mcp reaches the household Seerr", async () => {
  householdSeerr.search.mockClear();
  householdSeerr.search.mockResolvedValueOnce([
    { provider: "tmdb", providerId: 7, mediaType: "movie", title: "Arrival", status: "UNKNOWN" },
  ]);

  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: "Bearer secret123",
    },
    payload: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "search_media", arguments: { query: "arrival" } },
    },
  });

  expect(response.statusCode).toBe(200);
  const body = JSON.parse(response.payload.match(/data: ({.*})/)![1]);
  expect(body.result.isError).toBeFalsy();
  expect(body.result.content[0].text).toContain("Arrival");
  expect(householdSeerr.search).toHaveBeenCalledWith("arrival");
});
