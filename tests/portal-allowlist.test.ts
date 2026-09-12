import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createSeerrSenseMcpServer } from "../src/mcp/server.js";

/**
 * Drift guard for the Cloudflare MCP portal mapping of server `seerrsense`
 * (mctlhq/.github#35; finding 6 of mctlhq/.github#44). The portal hides only
 * what it has an explicit entry for, so a tool added to this server without a
 * decision in docs/portal-allowlist.json would surface on the shared aggregate
 * the moment the portal re-syncs. Failing the build is the decision being
 * asked for.
 *
 * The sibling upstreams carry the same guard in Go (mctlhq/mctl-telegram,
 * mctlhq/mctl-api). This is the TypeScript half, written when the portal was
 * opened to every tool and seerrsense turned out to be the one upstream with
 * no pinned file at all.
 *
 * The tool set comes from a real server instance rather than from a scan of
 * the source: a registration is what the server registers, and no regular
 * expression over the file can be as true as asking it.
 */

const ALLOWLIST = "docs/portal-allowlist.json";

/** A floor on the decision, not a quality bar: it rejects a placeholder. */
const MIN_REASON_LEN = 40;

/**
 * writeToolsOnPortal names the tools that change something outside this server
 * and are exposed on the shared portal anyway, by owner decision 2026-09-12.
 *
 * This is visibility, not permission: the portal switch is per-server and
 * user-blind, and the tool's own scope check is what decides whether the call
 * succeeds. The value says what the tool changes, for whoever would have to
 * undo it.
 */
const writeToolsOnPortal: Record<string, string> = {
  request_media:
    "files a request in the household's Seerr, which fetches media and consumes their storage and bandwidth; gated by the tool's own seerr:request check",
};

type Entry = { name: string; enabled?: boolean; reason?: string };
type Allowlist = {
  portal: string;
  server: string;
  default_disabled: boolean;
  tools: Entry[];
};

const list = JSON.parse(readFileSync(ALLOWLIST, "utf8")) as Allowlist;

const registered = createSeerrSenseMcpServer() as unknown as {
  _registeredTools: Record<string, { annotations?: { readOnlyHint?: boolean } }>;
};
const names = Object.keys(registered._registeredTools);
const isWrite = (name: string): boolean =>
  registered._registeredTools[name]?.annotations?.readOnlyHint !== true;

describe("portal allowlist", () => {
  it("targets the right mapping and stays fail-closed", () => {
    expect(list.portal).toBe("mcp");
    expect(list.server).toBe("seerrsense");
    // The half of the mapping that hides a tool the file does not know about.
    expect(list.default_disabled).toBe(true);
  });

  it("enumerates the tools it is guarding", () => {
    // A guard that found nothing would make every assertion below vacuous.
    expect(names.length).toBeGreaterThan(0);
    expect(names.some(isWrite)).toBe(true);
  });

  it("carries an explicit decision for every registered tool, and no stale entry", () => {
    const listed = list.tools.map((t) => t.name);
    expect(new Set(listed).size, "a tool is listed twice").toBe(listed.length);
    expect([...listed].sort()).toEqual([...names].sort());
    for (const tool of list.tools) {
      // A missing key must fail rather than read as false: "an explicit
      // decision for every tool" is enforced here or nowhere.
      expect(typeof tool.enabled, `${tool.name}: no "enabled" key`).toBe("boolean");
    }
  });

  it("requires a reason that says what an enabled tool exposes", () => {
    for (const tool of list.tools.filter((t) => t.enabled)) {
      expect(
        (tool.reason ?? "").length,
        `${tool.name}: enabled but the reason is a placeholder`,
      ).toBeGreaterThanOrEqual(MIN_REASON_LEN);
    }
  });

  it("lets a write tool be enabled only with a reviewed vouch", () => {
    for (const tool of list.tools.filter((t) => t.enabled && isWrite(t.name))) {
      expect(
        writeToolsOnPortal[tool.name],
        `${tool.name}: enabled on the shared portal and not read-only, but writeToolsOnPortal does not name it`,
      ).toBeTruthy();
    }
  });

  it("keeps no vouch that has stopped describing an enabled write tool", () => {
    const enabled = new Set(list.tools.filter((t) => t.enabled).map((t) => t.name));
    for (const name of Object.keys(writeToolsOnPortal)) {
      expect(names, `${name}: vouched for but no longer registered`).toContain(name);
      expect(enabled.has(name), `${name}: vouched for but disabled in the file`).toBe(true);
      expect(isWrite(name), `${name}: vouched for as a write but is now read-only`).toBe(true);
    }
  });
});
