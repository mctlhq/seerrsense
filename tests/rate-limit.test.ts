import { describe, it, expect, beforeAll, vi } from "vitest";

// No OAuth configured in this file: only the legacy shared token, which is
// enough to exercise the per-subject limiter on /api/v1/* without the
// overhead of a full Google sign-in flow.
const householdSeerr = vi.hoisted(() => ({
  status: vi.fn().mockResolvedValue({ status: 200 }),
  search: vi.fn().mockResolvedValue([]),
  getMedia: vi.fn(),
  requestMedia: vi.fn(),
}));
vi.mock("../src/providers/seerr/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/providers/seerr/client.js")>()),
  seerrClient: householdSeerr,
  createDefaultSeerrClient: () => householdSeerr,
}));

let buildServer: typeof import("../src/api/server.js").buildServer;

beforeAll(async () => {
  process.env.SEERRSENSE_RATE_LIMIT_SUBJECT_MAX = "2";
  process.env.SEERRSENSE_RATE_LIMIT_SUBJECT_WINDOW_MS = "60000";
  ({ buildServer } = await import("../src/api/server.js"));
});

describe("per-subject rate limiting", () => {
  it("answers 429 on the (N+1)th request for one subject, naming the same key", async () => {
    const app = buildServer();
    await app.ready();

    const call = () =>
      app.inject({
        method: "GET",
        url: "/api/v1/search?query=x",
        headers: { authorization: "Bearer secret123" },
      });

    expect((await call()).statusCode).toBe(200);
    expect((await call()).statusCode).toBe(200);
    expect((await call()).statusCode).toBe(429);
    await app.close();
  });

  it("leaves health probes unlimited even after the cap is hit", async () => {
    const app = buildServer();
    await app.ready();
    const call = () =>
      app.inject({
        method: "GET",
        url: "/api/v1/search?query=x",
        headers: { authorization: "Bearer secret123" },
      });
    await call();
    await call();
    expect((await call()).statusCode).toBe(429);

    for (let i = 0; i < 5; i++) {
      expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    }
    await app.close();
  });
});
