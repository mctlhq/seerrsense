import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { encryptionKeyFrom, open, seal } from "../src/auth/crypto.js";

const KEY = randomBytes(32);

describe("sealing a Seerr API key", () => {
  it("round-trips the value", () => {
    const sealed = seal("overseerr-api-key", KEY);
    expect(sealed).not.toContain("overseerr-api-key");
    expect(open(sealed, KEY)).toBe("overseerr-api-key");
  });

  it("produces a different ciphertext every time", () => {
    // A fixed nonce would make two identical keys visibly identical in the
    // database, which leaks that two people use the same Seerr.
    const first = seal("same", KEY);
    const second = seal("same", KEY);
    expect(first).not.toBe(second);
    expect(open(first, KEY)).toBe(open(second, KEY));
  });

  it("refuses a value that was tampered with", () => {
    const sealed = seal("overseerr-api-key", KEY);
    const [version, nonce, tag, ciphertext] = sealed.split(".");
    const flipped = ciphertext.slice(0, -2) + (ciphertext.endsWith("AA") ? "BB" : "AA");
    expect(() => open([version, nonce, tag, flipped].join("."), KEY)).toThrow();
  });

  it("refuses the wrong key", () => {
    const sealed = seal("overseerr-api-key", KEY);
    expect(() => open(sealed, randomBytes(32))).toThrow();
  });

  it("refuses a value that is not in the expected format", () => {
    expect(() => open("not-sealed", KEY)).toThrow(/format/);
    expect(() => open("v2.a.b.c", KEY)).toThrow(/format/);
  });

  it("accepts a 32-byte key as hex or base64 and rejects anything shorter", () => {
    const raw = randomBytes(32);
    expect(encryptionKeyFrom(raw.toString("hex"))).toEqual(raw);
    expect(encryptionKeyFrom(raw.toString("base64"))).toEqual(raw);
    // A short key must fail loudly rather than be padded into a weaker one.
    expect(() => encryptionKeyFrom("too-short")).toThrow(/32 bytes/);
    expect(() => encryptionKeyFrom(randomBytes(16).toString("hex"))).toThrow(/32 bytes/);
  });
});
