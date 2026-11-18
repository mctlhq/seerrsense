import { describe, it, expect, beforeAll, vi } from "vitest";
import { buildServer } from "../src/api/server.js";

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

const jsonLd = (html: string): any[] =>
  [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) =>
    JSON.parse(m[1]),
  );

describe("structured data", () => {
  it("describes the product on the landing page", async () => {
    const { payload } = await app.inject({ method: "GET", url: "/" });
    const blocks = jsonLd(payload);
    const app_ = blocks.find((b) => b["@type"] === "SoftwareApplication");
    expect(app_?.name).toBe("SeerrSense");
    expect(app_?.url).toBe("https://seerrsense.mctl.ai/");
  });

  it("marks the setup guide as a TechArticle", async () => {
    const { payload } = await app.inject({ method: "GET", url: "/setup" });
    expect(jsonLd(payload).some((b) => b["@type"] === "TechArticle")).toBe(true);
  });
});

describe("social tags on secondary pages", () => {
  for (const path of ["/support", "/privacy", "/terms"]) {
    it(`${path} carries its own og and twitter text tags`, async () => {
      const { payload } = await app.inject({ method: "GET", url: path });
      for (const tag of [
        'property="og:title"',
        'property="og:description"',
        `property="og:url" content="https://seerrsense.mctl.ai${path}"`,
        'property="og:image"',
        'name="twitter:card"',
        'name="twitter:title"',
      ]) {
        expect(payload, tag).toContain(tag);
      }
    });
  }
});

describe("security headers", () => {
  for (const url of ["/", "/setup", "/healthz"]) {
    it(`${url} sets transport and sniffing protections`, async () => {
      const response = await app.inject({ method: "GET", url });
      expect(response.headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
      expect(response.headers["x-frame-options"]).toBe("DENY");
    });
  }

  it("also covers a refused request", async () => {
    const response = await app.inject({ method: "POST", url: "/mcp", payload: {} });
    expect(response.statusCode).toBe(401);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });
});
