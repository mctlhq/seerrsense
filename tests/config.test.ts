import { test, expect } from "vitest";
import { parseConfig } from "../src/core/config.js";

test("Startup fails if SEERRSENSE_AUTH_TOKEN is missing", () => {
  const badEnv = {
    SEERR_URL: "http://127.0.0.1:5055",
    SEERR_API_KEY: "test",
    // Missing SEERRSENSE_AUTH_TOKEN
  };
  
  expect(() => parseConfig(badEnv)).toThrow();
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
