import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** URL-safe base64 without padding, per RFC 7636 appendix A. */
export function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A high-entropy opaque token: 32 random bytes, base64url-encoded. */
export function randomToken(): string {
  return base64url(randomBytes(32));
}

export function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Refresh tokens are stored hashed, so a database read never yields a usable token. */
export function hashToken(token: string): string {
  return sha256(token).toString("hex");
}

/**
 * Constant-time string comparison. Length is compared first and leaks, which is
 * why both sides are hashed to a fixed width before the timing-safe compare.
 */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

/** RFC 7636 §4.6: S256 challenge verification. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!isValidPkceString(verifier)) return false;
  return safeEqual(base64url(sha256(verifier)), challenge);
}

/**
 * RFC 7636 §4.1: the verifier is 43-128 characters from the unreserved set.
 * Rejecting the shape before hashing keeps a malformed value from being
 * silently accepted as "some string that hashes to something".
 */
export function isValidPkceString(value: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(value);
}
