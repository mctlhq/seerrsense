import { describe, it, expect, beforeAll, vi } from "vitest";
import { buildServer } from "../src/api/server.js";

// The household Seerr. Both the singleton and the factory are stubbed:
// the server builds its default client through the factory now.
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

let app: any;

beforeAll(async () => {
  app = buildServer();
  await app.ready();
});

describe("landing page", () => {
  it("serves the page at / without a token", async () => {
    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.payload).toContain("<title>SeerrSense");
    expect(response.payload).toContain("seerr:request");
  });

  it("carries OpenGraph and Twitter card metadata", async () => {
    const { payload } = await app.inject({ method: "GET", url: "/" });
    for (const tag of [
      'property="og:title"',
      'property="og:description"',
      'property="og:image"',
      'property="og:url"',
      'name="twitter:card"',
      'name="twitter:image"',
    ]) {
      expect(payload, tag).toContain(tag);
    }
  });

  it("serves the icon, the card image and the stylesheets", async () => {
    for (const [path, type] of [
      ["/favicon.svg", "image/svg+xml"],
      ["/og.png", "image/png"],
      ["/assets/tokens.css", "text/css"],
      ["/assets/components.css", "text/css"],
    ]) {
      const response = await app.inject({ method: "GET", url: path });
      expect(response.statusCode, path).toBe(200);
      expect(response.headers["content-type"], path).toContain(type);
    }
  });

  it("renders correctly before any script runs", async () => {
    const { payload } = await app.inject({ method: "GET", url: "/" });
    // Dark is the CSS default and the toggle is hidden until the script shows
    // it, so a reader with no JavaScript still gets a styled, complete page
    // rather than a dead control.
    expect(payload).toContain('id="theme-toggle"');
    expect(payload).toMatch(/<button[^>]*id="theme-toggle"[^>]*hidden/);
    // The endpoint is printed server-side too, so it is readable without JS.
    expect(payload).toContain("https://seerrsense.mctl.ai/mcp");

    const tokens = await app.inject({ method: "GET", url: "/assets/tokens.css" });
    expect(tokens.payload).toContain("--surface-bg: #0a0b0d");
    expect(tokens.payload).toContain("prefers-color-scheme: light");
    expect(tokens.payload).toContain('[data-theme="light"]');
  });

  it("keeps working when the CDN is unreachable", async () => {
    const { payload } = await app.inject({ method: "GET", url: "/" });
    // The canonical sheet is an enhancement loaded after a same-origin copy of
    // the tokens the page actually uses.
    const localTokens = payload.indexOf('href="/assets/tokens.css"');
    const cdn = payload.indexOf("https://ui.mctl.ai/mctl.css");
    const components = payload.indexOf('href="/assets/components.css"');
    expect(localTokens).toBeGreaterThan(-1);
    expect(cdn).toBeGreaterThan(localTokens);
    expect(components).toBeGreaterThan(cdn);
  });

  it("derives the endpoint from the origin instead of hardcoding it", async () => {
    const { payload } = await app.inject({ method: "GET", url: "/" });
    expect(payload).toContain('window.location.origin + "/mcp"');
  });

  it("never answers an undeclared path with the page", async () => {
    // No catch-all: an unknown path is refused, not served the landing page.
    // A missing asset 404s inside the assets prefix; everything else outside
    // the public list meets the token gate.
    const cases: Array<[string, number]> = [
      ["/not-a-page", 401],
      ["/index.html", 401],
      ["/api/v1/unknown", 401],
      ["/assets/missing.css", 404],
    ];
    for (const [path, status] of cases) {
      const response = await app.inject({ method: "GET", url: path });
      expect(response.statusCode, path).toBe(status);
      expect(response.payload, path).not.toContain("<title>SeerrSense");
    }
  });

  it("leaves the API and MCP endpoints behind the token gate", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/search?query=x" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/mcp", payload: {} })).statusCode).toBe(401);

    const authorised = await app.inject({
      method: "GET",
      url: "/api/v1/search?query=x",
      headers: { authorization: "Bearer secret123" },
    });
    expect(authorised.statusCode).toBe(200);
  });

  it("gives the shared container only horizontal padding", async () => {
    // .wrap is carried by the sections, the top bar and the footer. Setting it
    // with the padding shorthand zeroed their vertical padding and collapsed
    // the whole page into one block — caught by looking at it, not by a test,
    // so this is the regression guard.
    const { payload } = await app.inject({ method: "GET", url: "/assets/components.css" });
    const wrapRule = payload.slice(payload.indexOf(".wrap {"), payload.indexOf(".wrap {") + 220);
    expect(wrapRule).toContain("padding-inline");
    expect(wrapRule).not.toMatch(/padding:\s/);
    expect(payload).toMatch(/section \{[^}]*padding-block/);
  });

  it("keeps wide content inside its own scroll box", async () => {
    // The flow diagram and the tools table are wider than a phone; they must
    // scroll inside their container so the page itself never does.
    const { payload } = await app.inject({ method: "GET", url: "/assets/components.css" });
    for (const selector of [".flow-scroll", ".table-scroll"]) {
      const rule = payload.slice(payload.indexOf(selector + " {"), payload.indexOf(selector + " {") + 200);
      expect(rule, selector).toContain("overflow-x: auto");
    }
    const page = await app.inject({ method: "GET", url: "/" });
    expect(page.payload).toContain('class="flow-scroll"');
    expect(page.payload).toContain('class="table-scroll"');
  });

  it("keeps the health probes unauthenticated", async () => {
    for (const path of ["/healthz", "/readyz", "/health", "/ready"]) {
      expect((await app.inject({ method: "GET", url: path })).statusCode, path).toBe(200);
    }
  });
});
