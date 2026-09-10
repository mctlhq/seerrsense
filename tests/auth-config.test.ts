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

  it("is on only for the exact string 'true', in either mode", () => {
    expect(loadAuthSettings({ ...BASE_ENV, SEERRSENSE_LEGACY_TOKEN_ENABLED: "true" }, "shared").legacyToken).toBe("shared");
    expect(loadAuthSettings({ SEERRSENSE_LEGACY_TOKEN_ENABLED: "false" }, "shared").legacyToken).toBeUndefined();
    expect(loadAuthSettings({ ...BASE_ENV, SEERRSENSE_LEGACY_TOKEN_ENABLED: "yes" }, "shared").legacyToken).toBeUndefined();
  });
});
