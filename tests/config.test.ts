import { test, expect } from "vitest";
import { parseConfig, assertHttpConfig } from "../src/core/config.js";

test("Config parses without SEERRSENSE_AUTH_TOKEN (stdio mode needs none)", () => {
  const stdioEnv = {
    SEERR_URL: "http://127.0.0.1:5055",
    SEERR_API_KEY: "test",
    // Missing SEERRSENSE_AUTH_TOKEN
  };

  const config = parseConfig(stdioEnv);
  expect(config.SEERRSENSE_AUTH_TOKEN).toBeUndefined();
});

test("HTTP server startup fails if SEERRSENSE_AUTH_TOKEN is missing or empty", () => {
  const base = { SEERR_URL: "http://127.0.0.1:5055", SEERR_API_KEY: "test" };

  expect(() => assertHttpConfig(parseConfig(base))).toThrow(/SEERRSENSE_AUTH_TOKEN/);
  expect(() => parseConfig({ ...base, SEERRSENSE_AUTH_TOKEN: "" })).toThrow();
  expect(assertHttpConfig(parseConfig({ ...base, SEERRSENSE_AUTH_TOKEN: "secret" })).SEERRSENSE_AUTH_TOKEN).toBe("secret");
});

test("Startup succeeds if SEERRSENSE_AUTH_TOKEN is provided", () => {
  const goodEnv = {
    SEERR_URL: "http://127.0.0.1:5055",
    SEERR_API_KEY: "test",
    SEERRSENSE_AUTH_TOKEN: "secret",
  };
  
  const config = parseConfig(goodEnv);
  expect(config.SEERRSENSE_AUTH_TOKEN).toBe("secret");
});
