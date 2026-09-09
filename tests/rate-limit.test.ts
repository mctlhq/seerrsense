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

  it("keys on the subject, not the address: two IPs share one subject's bucket", async () => {
    // Without this the file could not tell per-subject keying from the plugin
    // default: every request in the case above comes from one address with one
    // token, so req.ip and subjectOf(req) are both constant and either keying
    // produces the same 200/200/429. Here the address changes and the subject
    // does not, so an IP-keyed limiter would hand out a fresh bucket and the
    // third call would be a 200.
    const app = buildServer();
    await app.ready();

    const call = (remoteAddress: string) =>
      app.inject({
        method: "GET",
        url: "/api/v1/search?query=x",
        remoteAddress,
        headers: { authorization: "Bearer secret123" },
      });

    expect((await call("203.0.113.1")).statusCode).toBe(200);
    expect((await call("203.0.113.2")).statusCode).toBe(200);
    expect((await call("203.0.113.3")).statusCode).toBe(429);
    await app.close();
  });

  it("meters unauthenticated requests, which never reach the route limiter", async () => {
    // The route limiters run at preHandler, after the bearer gate, so a wrong
    // token short-circuits with 401 before any of them sees the request. The
    // pre-auth onRequest limiter is what stops that being an unbounded number
    // of guesses at a fixed shared secret.
    process.env.SEERRSENSE_RATE_LIMIT_GATE_MAX = "3";
    const { buildServer: build } = await import("../src/api/server.js?gate");
    const app = build();
    await app.ready();

    const call = () =>
      app.inject({
        method: "GET",
        url: "/api/v1/search?query=x",
        headers: { authorization: "Bearer wrong-token" },
      });

    expect((await call()).statusCode).toBe(401);
    expect((await call()).statusCode).toBe(401);
    expect((await call()).statusCode).toBe(401);
    expect((await call()).statusCode).toBe(429);
    await app.close();
    delete process.env.SEERRSENSE_RATE_LIMIT_GATE_MAX;
  });

  it("does not let a forged X-Forwarded-For mint a fresh pre-auth bucket", async () => {
    // With trustProxy: true, proxy-addr trusts every hop and request.ip becomes
    // the left-most, caller-supplied X-Forwarded-For entry — so rotating that
    // header hands out a new bucket on every request and every IP limit here
    // becomes decorative. Trusting a hop count instead keeps request.ip the
    // address the ingress actually saw.
    process.env.SEERRSENSE_RATE_LIMIT_GATE_MAX = "2";
    const { buildServer: build } = await import("../src/api/server.js?xff");
    const app = build();
    await app.ready();

    // What the pod actually receives: the ingress appends the address it saw
    // the request come from, so the caller's own invention sits to the LEFT of
    // the one address that is real. Trusting one hop makes request.ip that
    // real address; trusting the whole chain makes it the invention.
    const call = (forged: string) =>
      app.inject({
        method: "GET",
        url: "/api/v1/search?query=x",
        remoteAddress: "10.1.1.1",
        headers: {
          authorization: "Bearer wrong-token",
          "x-forwarded-for": `${forged}, 203.0.113.9`,
        },
      });

    expect((await call("1.2.3.1")).statusCode).toBe(401);
    expect((await call("1.2.3.2")).statusCode).toBe(401);
    expect((await call("1.2.3.3")).statusCode).toBe(429);
    await app.close();
    delete process.env.SEERRSENSE_RATE_LIMIT_GATE_MAX;
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
