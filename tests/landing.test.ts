import { readFileSync } from "node:fs";
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
      ["/favicon.ico", "icon"],
      ["/apple-touch-icon.png", "image/png"],
      ["/og.png", "image/png"],
      ["/assets/tokens.css", "text/css"],
      ["/assets/components.css", "text/css"],
      ["/assets/site.css", "text/css"],
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
    // Assert the contract, not the palette: which hex the design system picks
    // is its business, but the page needs these three things to be true.
    expect(tokens.payload).toMatch(/--surface-bg:/);
    expect(tokens.payload).toContain("prefers-color-scheme: light");
    expect(tokens.payload).toMatch(/\[data-theme=['"]light['"]\]/);
  });

  it("renders the shared site header with a burger drawer on every page that has a header", async () => {
    for (const path of ["/", "/setup", "/account", "/support", "/privacy", "/terms"]) {
      const { payload, statusCode } = await app.inject({ method: "GET", url: path });
      expect(statusCode, path).toBe(200);
      expect(payload, path).toContain('href="/assets/site.css"');
      expect(payload, path).toContain('class="mctl-site-header mctl-site-header--app"');
      expect(payload, path).toContain('class="mctl-site-nav" id="site-nav"');
      expect(payload, path).toMatch(
        /<button class="mctl-site-burger" id="nav-burger"[^>]*aria-controls="site-nav" aria-expanded="false"/,
      );
      expect(payload, path).not.toContain("topbar");
    }
    // The 404 page carries the same header and sheet.
    const missing = await app.inject({
      method: "GET",
      url: "/does-not-exist",
      headers: { accept: "text/html" },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.payload).toContain('href="/assets/site.css"');
    expect(missing.payload).toContain('class="mctl-site-header mctl-site-header--app"');
    expect(missing.payload).not.toContain("topbar");
  });

  it("depends on no third-party stylesheet at all", async () => {
    const { payload } = await app.inject({ method: "GET", url: "/" });
    // The tokens are vendored from a pinned CDN path, so there is nothing to be
    // unreachable and no unversioned URL that can change the page without a
    // commit. Fonts are the one remaining external request.
    expect(payload).not.toContain("ui.mctl.ai");
    const localTokens = payload.indexOf('href="/assets/tokens.css"');
    const components = payload.indexOf('href="/assets/components.css"');
    expect(localTokens).toBeGreaterThan(-1);
    expect(components).toBeGreaterThan(localTokens);
  });

  it("serves tokens that were generated, not hand-written", async () => {
    const { payload } = await app.inject({ method: "GET", url: "/assets/tokens.css" });
    expect(payload).toContain("Generated by scripts/sync-tokens.mjs from https://ui.mctl.ai/");
    expect(payload).toContain("Do not edit");
  });

  it("takes the tokens from a pinned version, not the floating sheet", async () => {
    // The floating https://ui.mctl.ai/mctl.css has no version in it and a four
    // hour cache, so it can change under this page between deploys. A pinned
    // path is served immutable and mctl-design's CI refuses to edit, move or
    // delete a published version directory, which is what makes the vendored
    // copy stable rather than merely committed (mctlhq/mctl-design#75).
    const { payload } = await app.inject({ method: "GET", url: "/assets/tokens.css" });
    expect(payload).toMatch(
      /Generated by scripts\/sync-tokens\.mjs from https:\/\/ui\.mctl\.ai\/\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?\/mctl\.css/,
    );
    // The sheet names the version it was built from, so the vendored copy
    // records what it was taken from rather than only where.
    expect(payload).toMatch(/@mctlhq\/css \d+\.\d+\.\d+/);
  });

  it("serves the version the sync script pins, and the sheet agrees", async () => {
    // Moving SOURCE without regenerating (or regenerating from a different
    // URL by hand) would leave the header and the script disagreeing.
    const script = readFileSync(new URL("../scripts/sync-tokens.mjs", import.meta.url), "utf8");
    const pinned = script.match(/const VERSION = "([^"]+)";/);
    expect(pinned).not.toBeNull();
    const version = pinned![1];
    const url = `https://ui.mctl.ai/${version}/mctl.css`;
    const siteUrl = `https://ui.mctl.ai/${version}/site.css`;
    const { payload } = await app.inject({ method: "GET", url: "/assets/tokens.css" });
    expect(payload).toContain(`Generated by scripts/sync-tokens.mjs from ${url}.`);
    expect(payload).toContain(`@mctlhq/css ${version} `);
    // The shared header sheet is vendored from the same pinned version.
    const site = await app.inject({ method: "GET", url: "/assets/site.css" });
    expect(site.payload).toContain(`Generated by scripts/sync-tokens.mjs from ${siteUrl}.`);
  });

  it("derives the endpoint from the origin instead of hardcoding it", async () => {
    const script = await app.inject({ method: "GET", url: "/assets/site.js" });
    expect(script.statusCode).toBe(200);
    expect(script.payload).toContain('window.location.origin + "/mcp"');
    const { payload } = await app.inject({ method: "GET", url: "/" });
    expect(payload).toContain('<script src="/assets/site.js"></script>');
  });

  it("answers a browser at an unknown address with the 404 page, not the landing page", async () => {
    // No catch-all: an unknown path is never served the landing page. A plain
    // GET without a token — how a person arrives at a mistyped address — gets
    // an HTML 404 that links the real pages; a missing asset 404s inside the
    // assets prefix.
    const browser = { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };
    for (const path of ["/not-a-page", "/index.html", "/privacy//", "/api/v1/unknown", "/docs"]) {
      const response = await app.inject({ method: "GET", url: path, headers: browser });
      expect(response.statusCode, path).toBe(404);
      expect(response.headers["content-type"], path).toContain("text/html");
      expect(response.payload, path).toContain("<title>Page not found");
      expect(response.payload, path).not.toContain("<title>SeerrSense");
      expect(response.payload, path).toContain('href="/support"');
    }
    const asset = await app.inject({ method: "GET", url: "/assets/missing.css" });
    expect(asset.statusCode).toBe(404);
    expect(asset.payload).not.toContain("<title>SeerrSense");
  });

  const browserAccept = { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };

  it("keeps the token challenge for anything that is not a browser at a page", async () => {
    // An MCP client with the endpoint slightly wrong POSTs, or carries a token;
    // both must still meet the gate and its WWW-Authenticate challenge, which is
    // what makes the client start OAuth rather than fail on a 404.
    const post = await app.inject({ method: "POST", url: "/mcp.", payload: {} });
    expect(post.statusCode).toBe(401);
    expect(post.headers["www-authenticate"]).toContain("Bearer");
    // The browser test is Accept: text/html, not merely "a GET without a
    // token": curl, a prober, a JSON fetch() at a mistyped path and an MCP
    // client's GET stream at /mcp/ all arrive without a token too, and must get
    // the same 401 for an undeclared path as for a declared one, so that an
    // anonymous caller cannot tell the two apart.
    for (const [path, accept] of [
      ["/not-a-page", "application/json"],
      ["/api/v1/searchx", "*/*"],
      ["/mcp/", "text/event-stream"],
    ] as const) {
      const response = await app.inject({ method: "GET", url: path, headers: { accept } });
      expect(response.statusCode, `${path} ${accept}`).toBe(401);
      expect(response.headers["www-authenticate"], path).toContain("Bearer");
      expect(response.json().error, path).toBe("invalid_token");
    }
    const noAccept = await app.inject({ method: "GET", url: "/not-a-page" });
    expect(noAccept.statusCode).toBe(401);
    // And the other conjunct: a DECLARED gated route asked for as HTML, with no
    // token, is still refused. Only an undeclared path may skip the gate; if
    // is404 were dropped from the predicate, a browser could open the API and
    // the MCP endpoint without a token.
    for (const path of ["/api/v1/search?query=x", "/mcp"]) {
      const response = await app.inject({ method: "GET", url: path, headers: browserAccept });
      expect(response.statusCode, path).toBe(401);
      expect(response.headers["www-authenticate"], path).toContain("Bearer");
    }
    const badToken = await app.inject({ method: "GET", url: "/not-a-page", headers: { authorization: "Bearer nope" } });
    expect(badToken.statusCode).toBe(401);
    expect(badToken.json().error).toBe("invalid_token");
    // A valid token at a route that does not exist is a 404 for a client, not a page.
    const goodToken = await app.inject({ method: "GET", url: "/api/v1/unknown", headers: { authorization: "Bearer secret123" } });
    expect(goodToken.statusCode).toBe(404);
    expect(goodToken.headers["content-type"]).toContain("application/json");
    expect(goodToken.json()).toEqual({ error: "not found" });
  });

  it("redirects a trailing slash on a page to the page, and nowhere else", async () => {
    for (const page of ["/account", "/privacy", "/terms", "/support", "/setup"]) {
      const response = await app.inject({ method: "GET", url: `${page}/` });
      expect(response.statusCode, page).toBe(301);
      expect(response.headers.location, page).toBe(page);
      const withQuery = await app.inject({ method: "GET", url: `${page}/?a=1&b=2` });
      expect(withQuery.statusCode, page).toBe(301);
      expect(withQuery.headers.location, page).toBe(`${page}?a=1&b=2`);
    }
    // Exactly those paths, not the subtrees under them. A sibling of the
    // redirect, asked for without a token and without an HTML Accept (so the
    // browser 404 exception does not apply), must meet the gate; this is what
    // fails if they ever become prefixes in PUBLIC_PREFIXES again.
    for (const path of ["/account/x", "/privacy/anything", "/terms/2026", "/support/faq", "/setup/x", "/account//"]) {
      const response = await app.inject({ method: "GET", url: path, headers: { accept: "application/json" } });
      expect(response.statusCode, path).toBe(401);
      expect(response.headers["www-authenticate"], path).toContain("Bearer");
    }
    // The endpoints keep exact matching: a slash there is an undeclared
    // path and meets the gate like any other.
    for (const path of ["/mcp/", "/api/v1/"]) {
      const response = await app.inject({ method: "POST", url: path, payload: {} });
      expect(response.statusCode, path).toBe(401);
    }
  });

  it("serves robots.txt without a token and keeps crawlers off the endpoints", async () => {
    const response = await app.inject({ method: "GET", url: "/robots.txt" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.payload).toContain("Allow: /");
    for (const path of ["/mcp", "/api/", "/oauth/", "/account"]) {
      expect(response.payload).toContain(`Disallow: ${path}`);
    }
    expect(response.payload).toMatch(/^Sitemap: https:\/\/seerrsense\.mctl\.ai\/sitemap\.xml$/m);
  });

  describe("sitemap", () => {
    const ORIGIN = "https://seerrsense.mctl.ai";
    const locations = (xml: string) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);

    it("answers GET and HEAD with public XML and no token", async () => {
      const get = await app.inject({ method: "GET", url: "/sitemap.xml" });
      expect(get.statusCode).toBe(200);
      expect(get.headers["content-type"]).toContain("application/xml");
      expect(get.payload.startsWith('<?xml version="1.0"')).toBe(true);
      expect(get.payload).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
      expect(get.payload.trimEnd().endsWith("</urlset>")).toBe(true);

      const head = await app.inject({ method: "HEAD", url: "/sitemap.xml" });
      expect(head.statusCode).toBe(200);
      expect(head.headers["content-type"]).toContain("application/xml");
      expect(head.payload).toBe("");
    });

    it("lists exactly the public pages, each one indexable and self-canonical", async () => {
      const { payload } = await app.inject({ method: "GET", url: "/sitemap.xml" });
      expect(locations(payload)).toEqual(["/", "/setup", "/support", "/privacy", "/terms"].map((path) => `${ORIGIN}${path}`));

      for (const location of locations(payload)) {
        const page = await app.inject({ method: "GET", url: location.slice(ORIGIN.length) });
        expect(page.statusCode, location).toBe(200);
        expect(page.headers["content-type"], location).toContain("text/html");
        expect(page.payload, location).not.toMatch(/<meta name="robots"[^>]*noindex/);
        expect(page.payload, location).toContain(`<link rel="canonical" href="${location}">`);
      }
    });

    it("opens only its own exact path", async () => {
      // A near match must not inherit the exemption: without an HTML Accept,
      // these are undeclared paths, and an anonymous caller meets the gate.
      for (const path of ["/sitemap.xml/", "/sitemap.xml/x", "/sitemap.xmlx", "/sitemap", "/setup/x", "/setupx"]) {
        const response = await app.inject({ method: "GET", url: path, headers: { accept: "application/json" } });
        expect(response.statusCode, path).toBe(401);
        expect(response.headers["www-authenticate"], path).toContain("Bearer");
      }
      // GET and HEAD only: like the other public paths, it has no POST route.
      expect((await app.inject({ method: "POST", url: "/sitemap.xml", payload: {} })).statusCode).toBe(404);
    });
  });

  describe("setup guide", () => {
    it("is complete in the server's HTML, with its own title and description", async () => {
      const response = await app.inject({ method: "GET", url: "/setup" });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      const { payload } = response;
      expect(payload).toContain("<title>Seerr MCP setup: connect your media requests to an AI assistant</title>");
      expect(payload).toMatch(/<meta name="description" content="[^"]*Overseerr or Jellyseerr[^"]*">/);
      expect(payload.match(/<h1>/g)?.length).toBe(1);
      // The outline, in the order a reader has to follow it.
      const headings = [
        "What runs where", "Before you start", "1. Add the connector", "2. Sign in with Google",
        "3. Attach your Seerr", "4. Run a read-only check", "5. Resolve an imprecise title",
        "6. Verify the candidate", "7. Confirm the request", "Troubleshooting", "Disconnect",
      ].map((heading) => payload.indexOf(`<h2>${heading}</h2>`));
      expect(headings.every((position) => position > -1)).toBe(true);
      expect(headings).toEqual([...headings].sort((a, b) => a - b));
      for (const tool of ["whoami", "search_media", "resolve_media", "get_media", "request_media"]) {
        expect(payload, tool).toContain(`<code>${tool}</code>`);
      }
      for (const link of ["/account", "/privacy", "/support"]) {
        expect(payload.slice(payload.indexOf("<main"), payload.indexOf("</main>")), link).toContain(`href="${link}"`);
      }
    });

    it("publishes no credential and no real account", async () => {
      const { payload } = await app.inject({ method: "GET", url: "/setup" });
      for (const forbidden of [
        "Authorization: Bearer", "SEERRSENSE_AUTH_TOKEN", "SEERR_API_KEY", "NEBIUS_API_KEY",
        "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "gmail.com", "google:",
      ]) {
        expect(payload, forbidden).not.toContain(forbidden);
      }
      expect(payload).toContain("you@example.com");
      expect(payload).toContain("https://seerr.example.com");
    });

    it("is linked from the landing and support pages", async () => {
      for (const path of ["/", "/support"]) {
        const { payload } = await app.inject({ method: "GET", url: path });
        expect(payload, path).toContain('href="/setup"');
      }
    });

    it("states the same client paths as the landing page", async () => {
      const landing = (await app.inject({ method: "GET", url: "/" })).payload;
      const guide = (await app.inject({ method: "GET", url: "/setup" })).payload;
      const normal = (html: string) => html.replace(/\s+/g, " ");
      for (const needle of [
        "Customize → Connectors → + Add → Add custom connector",
        "Add custom MCP server",
        "claude mcp add --transport http seerrsense https://seerrsense.mctl.ai/mcp",
      ]) {
        expect(normal(landing), needle).toContain(needle);
        expect(normal(guide), needle).toContain(needle);
      }
    });
  });

  it("gives every public page the same header, fonts, theme toggle and contact", async () => {
    // The inner pages used to be a second site: system font, no logo, no theme
    // toggle, a different set of links on each. One header and one footer now,
    // so a theme chosen on the landing page is what /account renders, and every
    // page reaches every other page.
    const pages = ["/", "/account", "/privacy", "/terms", "/support", "/setup"];
    for (const path of pages) {
      const { payload } = await app.inject({ method: "GET", url: path });
      expect(payload, path).toContain("fonts.googleapis.com/css2?family=Onest");
      expect(payload, path).toContain('class="mctl-site-brand__mark"');
      expect(payload, path).toMatch(/<button[^>]*id="theme-toggle"[^>]*hidden/);
      expect(payload, path).toContain('<script src="/assets/site.js"></script>');
      // The stored theme is applied inline in <head>, before the stylesheets,
      // so the choice is on the first paint rather than after site.js arrives.
      const head = payload.slice(0, payload.indexOf("</head>"));
      const boot = head.indexOf('localStorage.getItem("seerrsense-theme")');
      expect(boot, path).toBeGreaterThan(-1);
      expect(boot, path).toBeLessThan(head.indexOf("<link rel=\"stylesheet\""));
      // The header carries Account · Support · GitHub; Privacy and Terms are in
      // the footer of every page, so every page still reaches every other.
      const header = payload.slice(payload.indexOf("<header"), payload.indexOf("</header>"));
      expect(header, path).toContain('href="/account"');
      expect(header, path).toContain('href="/support"');
      expect(header, path).not.toContain('href="/privacy"');
      expect(header, path).not.toContain('href="/terms"');
      const footer = payload.slice(payload.indexOf("<footer"), payload.indexOf("</footer>"));
      for (const link of ["/privacy", "/terms", "/support"]) {
        expect(footer, `${path} footer links ${link}`).toContain(`href="${link}"`);
      }
      expect(payload, path).toContain('class="mctl-site-brand" href="/"');
    }
    // Wherever the sign-in rule is stated it is stated whole: Google's
    // email_verified is refused outright (src/auth/google.ts), so "verified"
    // is a condition, not a detail, and every page that states the rule must
    // say it the same way. Privacy deliberately does not state the rule, which
    // which is why it is the one shared-shell page missing from this loop.
    for (const path of ["/", "/account", "/terms", "/support", "/setup"]) {
      const { payload } = await app.inject({ method: "GET", url: path });
      expect(payload, path).toMatch(/On\s+this server, any(one with a)? Google\s+account (and|with) a verified\s+e-mail address can sign in/);
    }
    for (const path of ["/privacy", "/terms", "/support"]) {
      const { payload } = await app.inject({ method: "GET", url: path });
      expect(payload, path).toContain("mailto:support@mctl.ai");
      // The pages that state an address state only this one.
      expect(payload, path).not.toContain("gmail.com");
      expect(payload.match(/mailto:/g)?.length, path).toBe(1);
    }
    const css = await app.inject({ method: "GET", url: "/assets/components.css" });
    expect(css.payload).toMatch(/\.btn\[hidden\]\s*\{\s*display: none;/);
    // /account/callback is registered only with OAuth configured, which this
    // suite is not, so the file is read from disk: an inject() here would
    // assert against the 404 page and pass whatever the file said.
    const callback = readFileSync(new URL("../public/account-callback.html", import.meta.url), "utf8");
    expect(callback).toContain('localStorage.getItem("seerrsense-theme")');
    expect(callback).not.toContain('<script src="/assets/site.js"');
    // The account page's own <style> must come after the shared sheets, or
    // its narrower column loses to main.page in components.css on source order.
    const account = await app.inject({ method: "GET", url: "/account" });
    expect(account.payload.indexOf("<style>")).toBeGreaterThan(account.payload.indexOf('href="/assets/components.css"'));
    expect(account.payload).toContain("main.page { max-width: 560px; }");
    // The theme icon names the theme that is showing, so it must be two icons
    // swapped by the same rules the tokens use, not one moon for both.
    const sheet = await app.inject({ method: "GET", url: "/assets/components.css" });
    expect(sheet.payload).toMatch(/:root\[data-theme="light"\] \.theme-toggle \.icon-moon \{ display: none; \}/);
    expect(sheet.payload).toContain("prefers-color-scheme: light");
  });

  it("describes the current ChatGPT path and names the model provider", async () => {
    const { payload } = await app.inject({ method: "GET", url: "/" });
    // OpenAI's current path, per its help and developer pages on 2026-11-06.
    // The earlier "Apps & Connectors" and "Developer mode" path is gone.
    expect(payload).toContain("<em>Plugins</em>");
    expect(payload).toContain("Add custom MCP server");
    expect(payload).not.toContain("Apps &amp; Connectors");
    expect(payload).not.toContain("Developer mode");
    expect(payload).toContain("claude mcp add --transport http seerrsense");
    // The sign-in rule belongs to the sign-in step, not to the connector step.
    const signIn = payload.slice(payload.indexOf("<strong>Sign in with Google.</strong>"), payload.indexOf("<strong>Attach your Seerr.</strong>"));
    expect(signIn).toContain("verified e-mail address");
    // The REST surface exists but is undocumented; the page must not send a
    // reader to a URL that answers 401.
    expect(payload).not.toContain("/api/v1");
    const privacy = await app.inject({ method: "GET", url: "/privacy" });
    expect(privacy.payload).toContain("Nebius");
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
    // The flow diagram was removed with the audience split; the tools table is
    // what still needs the box on a phone. The .flow-scroll rule is asserted
    // above and stays in the sheet for whatever uses it next.
    const page = await app.inject({ method: "GET", url: "/" });
    expect(page.payload).toContain('class="table-scroll"');
  });

  it("serves the privacy and terms pages without a token", async () => {
    // Google will not let the OAuth app leave testing without these two links,
    // and a service holding other people's API keys owes them the statement.
    for (const path of ["/privacy", "/terms"]) {
      const response = await app.inject({ method: "GET", url: path });
      expect(response.statusCode, path).toBe(200);
      expect(response.headers["content-type"], path).toContain("text/html");
    }
  });

  it("says what it stores and does not claim it cannot look", async () => {
    const { payload } = await app.inject({ method: "GET", url: "/privacy" });
    // The claim that matters: the operator can technically read what is stored.
    // Saying "we cannot access your data" would be false for a hosted service
    // that holds the encryption key, and both connector reviews reject it.
    expect(payload).toContain("technically able to read");
    expect(payload).not.toMatch(/we cannot (access|read|see)/i);
    expect(payload).toContain("AES-256-GCM");
    expect(payload).toContain("Disconnect");
  });

  it("links both pages from the landing page footer", async () => {
    const { payload } = await app.inject({ method: "GET", url: "/" });
    expect(payload).toContain('href="/privacy"');
    expect(payload).toContain('href="/terms"');
    expect(payload).toContain('href="/support"');
  });

  // Both connector directories ask for a support URL, a listing icon and
  // example prompts; a listing without them is sent back before review.
  it("serves the support page and the listing icon without a token", async () => {
    const support = await app.inject({ method: "GET", url: "/support" });
    expect(support.statusCode).toBe(200);
    expect(support.headers["content-type"]).toContain("text/html");
    expect(support.payload).toContain("github.com/mctlhq/seerrsense/issues");
    expect(support.payload).toContain("mailto:");
    for (const page of ["/privacy", "/terms", "/account"]) {
      expect((await app.inject({ method: "GET", url: page })).payload, page).toContain('href="/support"');
    }
    const icon = await app.inject({ method: "GET", url: "/icon-512.png" });
    expect(icon.statusCode).toBe(200);
    expect(icon.headers["content-type"]).toContain("image/png");
    // PNG header, then the IHDR chunk: width and height at bytes 16-23.
    const png = icon.rawPayload;
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(512);
    expect(png.readUInt32BE(20)).toBe(512);
    // Colour type 2 = RGB without an alpha channel.
    expect(png[25]).toBe(2);
  });

  it("gives example prompts that exercise each tool", async () => {
    const { payload } = await app.inject({ method: "GET", url: "/" });
    expect(payload).toContain('id="prompts"');
    for (const tool of ["search_media", "resolve_media", "get_media", "request_media"]) {
      const section = payload.slice(payload.indexOf('id="prompts"'), payload.indexOf('id="setup"'));
      expect(section, tool).toContain(tool);
    }
  });

  it("offers self-service deletion on the privacy page", async () => {
    const { payload } = await app.inject({ method: "GET", url: "/privacy" });
    expect(payload).toContain("Delete my account");
    // Deletion must not be deferred to e-mail: the page names the button
    // first, and e-mail is only the fallback for when the button fails.
    const removing = payload.slice(payload.indexOf("Removing your data"), payload.indexOf("<h2>Contact</h2>"));
    expect(removing.indexOf("Delete my account")).toBeGreaterThan(-1);
    expect(removing.indexOf("Delete my account")).toBeLessThan(removing.indexOf("write to the address below"));
    expect(removing).not.toMatch(/to have everything .* removed, write/i);
  });

  it("keeps the health probes unauthenticated", async () => {
    for (const path of ["/healthz", "/readyz", "/health", "/ready"]) {
      expect((await app.inject({ method: "GET", url: path })).statusCode, path).toBe(200);
    }
  });

  it("never instructs a token or an environment variable", async () => {
    const { payload } = await app.inject({ method: "GET", url: "/" });
    for (const forbidden of [
      "Authorization: Bearer", "Bearer &lt;your token&gt;", "bearer token",
      "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET",
      "NEBIUS_API_KEY", "SEERRSENSE_AUTH_TOKEN", "SEERR_API_KEY",
    ]) {
      expect(payload, forbidden).not.toContain(forbidden);
    }
  });

  it("gives the three steps and both client paths", async () => {
    const { payload } = await app.inject({ method: "GET", url: "/" });
    expect(payload).toContain('id="setup"');
    for (const needle of [
      "Add custom connector", "Add custom MCP server",
      "Settings, then General, then API Key",
    ]) {
      expect(payload, needle).toContain(needle);
    }
    const [connector, signIn, seerr] = ["Add the connector", "Sign in with Google", "Attach your Seerr"]
      .map((h) => payload.indexOf(h));
    expect(connector).toBeGreaterThan(-1);
    expect(signIn).toBeGreaterThan(connector);
    expect(seerr).toBeGreaterThan(signIn);
  });

  it("includes privacy-friendly Umami analytics on public pages and excludes it from account pages", async () => {
    const publicPaths = ["/", "/privacy", "/terms", "/support", "/setup"];
    for (const path of publicPaths) {
      const { payload } = await app.inject({ method: "GET", url: path });
      expect(payload, path).toContain("https://stats.mctl.ai/insights.js");
      expect(payload, path).toContain('data-website-id="5ee11000-8b07-4d27-98e6-0b611eeaa707"');
      expect(payload, path).toContain('data-domains="seerrsense.mctl.ai"');
    }

    const { payload: accountPayload } = await app.inject({ method: "GET", url: "/account" });
    expect(accountPayload).not.toContain("https://stats.mctl.ai/insights.js");
  });
});
