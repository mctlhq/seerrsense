import { describe, it, expect } from "vitest";
import { loadAuthSettings } from "../src/auth/config.js";

const BASE_ENV = {
  SEERRSENSE_PUBLIC_URL: "https://seerrsense.test",
  GOOGLE_OAUTH_CLIENT_ID: "client",
  GOOGLE_OAUTH_CLIENT_SECRET: "secret",
  SEERRSENSE_OAUTH_JWT_SIGNING_KEY: "x".repeat(48),
};

describe("openSignup", () => {
  it("is false when unset", () => {
    const settings = loadAuthSettings(BASE_ENV, undefined);
    expect(settings.oauth?.openSignup).toBe(false);
  });

  it.each(["TRUE", "1", "yes", "True ", " true"])("treats %j as closed, not open", (value) => {
    const settings = loadAuthSettings({ ...BASE_ENV, SEERRSENSE_OPEN_SIGNUP: value }, undefined);
    expect(settings.oauth?.openSignup).toBe(false);
  });

  it("is true only for the exact string 'true'", () => {
    const settings = loadAuthSettings({ ...BASE_ENV, SEERRSENSE_OPEN_SIGNUP: "true" }, undefined);
    expect(settings.oauth?.openSignup).toBe(true);
  });
});

describe("householdEmails", () => {
  it("is empty when unset", () => {
    const settings = loadAuthSettings(BASE_ENV, undefined);
    expect(settings.oauth?.householdEmails.size).toBe(0);
  });

  it("trims, lowercases and filters, like allowedEmails", () => {
    const settings = loadAuthSettings(
      { ...BASE_ENV, SEERRSENSE_HOUSEHOLD_EMAILS: " Owner@Example.com , ,second@example.com" },
      undefined,
    );
    expect(settings.oauth?.householdEmails).toEqual(new Set(["owner@example.com", "second@example.com"]));
  });
});

describe("dcrRedirectUris", () => {
  it("is [] when the variable is unset", () => {
    const settings = loadAuthSettings(BASE_ENV, undefined);
    expect(settings.oauth?.dcrRedirectUris).toEqual([]);
  });

  it("is [] when set to the empty string", () => {
    const settings = loadAuthSettings({ ...BASE_ENV, SEERRSENSE_DCR_REDIRECT_URIS: "" }, undefined);
    expect(settings.oauth?.dcrRedirectUris).toEqual([]);
  });

  it("is the parsed list when set", () => {
    const settings = loadAuthSettings(
      { ...BASE_ENV, SEERRSENSE_DCR_REDIRECT_URIS: " https://mcp.mctl.ai/servers-callback , https://other.test/cb" },
      undefined,
    );
    expect(settings.oauth?.dcrRedirectUris).toEqual([
      "https://mcp.mctl.ai/servers-callback",
      "https://other.test/cb",
    ]);
  });

  it("throws on a malformed entry", () => {
    expect(() =>
      loadAuthSettings({ ...BASE_ENV, SEERRSENSE_DCR_REDIRECT_URIS: "not a url" }, undefined),
    ).toThrow();
  });
});

describe("legacy token default", () => {
  it("stays on when OAuth is not configured: it is the only way in", () => {
    const settings = loadAuthSettings({}, "shared");
    expect(settings.oauth).toBeUndefined();
    expect(settings.legacyToken).toBe("shared");
  });

  it("turns off by itself once OAuth is configured", () => {
    const settings = loadAuthSettings(BASE_ENV, "shared");
    expect(settings.oauth).toBeDefined();
    expect(settings.legacyToken).toBeUndefined();
  });

  it("with OAuth, is on only for the exact string 'true'", () => {
    expect(loadAuthSettings({ ...BASE_ENV, SEERRSENSE_LEGACY_TOKEN_ENABLED: "true" }, "shared").legacyToken).toBe("shared");
    for (const value of ["yes", "1", "TRUE", ""]) {
      expect(loadAuthSettings({ ...BASE_ENV, SEERRSENSE_LEGACY_TOKEN_ENABLED: value }, "shared").legacyToken, value).toBeUndefined();
    }
  });

  it("without OAuth, keeps the old rule: anything but 'false' is on", () => {
    for (const value of ["yes", "1", "TRUE", "", "true"]) {
      expect(loadAuthSettings({ SEERRSENSE_LEGACY_TOKEN_ENABLED: value }, "shared").legacyToken, value).toBe("shared");
    }
    expect(loadAuthSettings({ SEERRSENSE_LEGACY_TOKEN_ENABLED: "false" }, "shared").legacyToken).toBeUndefined();
  });
});
