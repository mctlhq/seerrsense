import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * The ChatGPT app directory proves domain ownership by fetching a token it
 * issued from /.well-known/openai-apps-challenge. The token is configuration:
 * present, it is served byte for byte; absent, the path does not exist.
 */
vi.mock("../src/providers/seerr/client.js", async (importOriginal) => {
  const household = {
    status: vi.fn().mockResolvedValue({ status: 200 }),
    search: vi.fn().mockResolvedValue([]),
    getMedia: vi.fn(),
    requestMedia: vi.fn(),
  };
  return {
    ...(await importOriginal<typeof import("../src/providers/seerr/client.js")>()),
    seerrClient: household,
    createDefaultSeerrClient: () => household,
  };
});

async function freshServer(challenge: string | undefined) {
  vi.resetModules();
  if (challenge === undefined) delete process.env.SEERRSENSE_OPENAI_APPS_CHALLENGE;
  else process.env.SEERRSENSE_OPENAI_APPS_CHALLENGE = challenge;
  const { buildServer } = await import("../src/api/server.js");
  const app = buildServer();
  await app.ready();
  return app;
}

describe("OpenAI apps domain challenge", () => {
  afterEach(() => {
    delete process.env.SEERRSENSE_OPENAI_APPS_CHALLENGE;
  });

  it("serves the configured token verbatim, without a token of its own", async () => {
    const app = await freshServer("openai-apps-challenge-ABC123==");
    const response = await app.inject({ method: "GET", url: "/.well-known/openai-apps-challenge" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.payload).toBe("openai-apps-challenge-ABC123==");
    await app.close();
  });

  it("does not exist when nothing is configured", async () => {
    const app = await freshServer(undefined);
    const response = await app.inject({ method: "GET", url: "/.well-known/openai-apps-challenge" });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
