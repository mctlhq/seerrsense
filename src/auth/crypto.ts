import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

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

/**
 * Symmetric encryption for the one secret this server has to be able to read
 * back: a person's Seerr API key. Everything else here is one-way on purpose —
 * a token is compared by hash and never recovered — but a stored API key must
 * be usable to call their Seerr, so it is sealed rather than hashed.
 *
 * AES-256-GCM: the tag detects tampering, so a row edited in the database fails
 * to open instead of quietly changing which server we talk to. The nonce is
 * random per seal and carried with the ciphertext; the format is
 * v1.<nonce>.<tag>.<ciphertext>, all base64url, and the version prefix is there
 * so a future scheme can be told apart from this one.
 */
export function seal(plaintext: string, key: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", base64url(nonce), base64url(cipher.getAuthTag()), base64url(ciphertext)].join(".");
}

export function open(sealed: string, key: Buffer): string {
  const [version, nonce, tag, ciphertext] = sealed.split(".");
  if (version !== "v1" || !nonce || !tag || !ciphertext) {
    throw new Error("sealed value is not in the expected format");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, fromBase64url(nonce));
  decipher.setAuthTag(fromBase64url(tag));
  return Buffer.concat([decipher.update(fromBase64url(ciphertext)), decipher.final()]).toString("utf8");
}

function fromBase64url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * The encryption key, from an environment variable holding 32 bytes as hex or
 * base64. Rejecting anything else at startup is deliberate: a short key would
 * be accepted by AES only after padding, which would silently weaken it.
 */
export function encryptionKeyFrom(raw: string): Buffer {
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("SEERRSENSE_ENCRYPTION_KEY must be 32 bytes, as 64 hex characters or base64");
  }
  return key;
}
