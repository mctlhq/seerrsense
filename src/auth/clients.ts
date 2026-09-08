import { z } from "zod";

/**
 * A resolved OAuth client. Under Client ID Metadata Documents the client_id is
 * itself an https URL naming a document that lists the allowed redirect URIs,
 * so there is no client registry to keep.
 */
export interface ResolvedClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  source: "cimd" | "pre-registered";
}

/** MCP 2026-07-28 requires client_id, client_name and redirect_uris. */
const ClientMetadataSchema = z.object({
  client_id: z.string(),
  client_name: z.string(),
  redirect_uris: z.array(z.string()).min(1),
});

export class ClientResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientResolutionError";
  }
}

interface CacheEntry {
  client: ResolvedClient;
  expiresAt: number;
}

/**
 * Resolves a client_id to its metadata.
 *
 * Pre-registered clients win: they are configured by the operator and need no
 * network call. Anything else must be a Client ID Metadata Document URL, which
 * is fetched and validated per the 2026-07-28 client-registration spec.
 * Dynamic Client Registration is deprecated there and is not implemented.
 */
export class ClientResolver {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private readonly preRegistered: ResolvedClient[] = [],
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly maxBodyBytes = 64 * 1024,
  ) {}

  async resolve(clientId: string): Promise<ResolvedClient> {
    const preset = this.preRegistered.find((c) => c.clientId === clientId);
    if (preset) return preset;

    if (!clientId.startsWith("https://")) {
      throw new ClientResolutionError(
        "client_id must be a pre-registered identifier or an https Client ID Metadata Document URL",
      );
    }

    const cached = this.cache.get(clientId);
    if (cached && cached.expiresAt > Date.now()) return cached.client;

    const client = await this.fetchMetadata(clientId);
    // Cache respecting the document's own freshness, bounded so a long
    // max-age cannot pin stale redirect URIs for the process lifetime.
    this.cache.set(clientId, { client, expiresAt: Date.now() + 10 * 60 * 1000 });
    return client;
  }

  private async fetchMetadata(clientId: string): Promise<ResolvedClient> {
    let url: URL;
    try {
      url = new URL(clientId);
    } catch {
      throw new ClientResolutionError("client_id is not a valid URL");
    }
    // The spec requires an https URL with a path component; a bare origin is
    // not a metadata document and would let any host claim an identity.
    if (url.protocol !== "https:" || url.pathname === "/" || url.pathname === "") {
      throw new ClientResolutionError("client_id must be an https URL with a path component");
    }

    let response: Response;
    try {
      response = await this.fetchImpl(clientId, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new ClientResolutionError("could not fetch the client metadata document");
    }
    if (!response.ok) {
      throw new ClientResolutionError(
        `client metadata document returned ${response.status}`,
      );
    }

    const body = await response.text();
    if (body.length > this.maxBodyBytes) {
      throw new ClientResolutionError("client metadata document is too large");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new ClientResolutionError("client metadata document is not valid JSON");
    }

    const metadata = ClientMetadataSchema.safeParse(parsed);
    if (!metadata.success) {
      throw new ClientResolutionError(
        "client metadata document is missing client_id, client_name or redirect_uris",
      );
    }
    // The document must claim exactly the URL it was fetched from, or one host
    // could serve a document naming another host's client_id.
    if (metadata.data.client_id !== clientId) {
      throw new ClientResolutionError("client metadata client_id does not match its URL");
    }

    return {
      clientId,
      clientName: metadata.data.client_name,
      redirectUris: metadata.data.redirect_uris,
      source: "cimd",
    };
  }
}

/**
 * Redirect URI check: exact match, except that a loopback address matches
 * without its port.
 *
 * No prefix or wildcard matching — a prefix rule lets `https://good.example/cb`
 * authorize `https://good.example/cb.evil.test`.
 *
 * The loopback exception is required, not a convenience. A native client binds
 * an ephemeral port and cannot know it in advance, so RFC 8252 section 7.3 tells
 * the authorization server to ignore the port for `127.0.0.1`. Claude Code
 * declares exactly `http://localhost/callback` and `http://127.0.0.1/callback`
 * in its Client ID Metadata Document and then arrives on a random port, so the
 * same port-agnostic rule has to cover `localhost` too.
 */
export function isAllowedRedirectUri(client: ResolvedClient, redirectUri: string): boolean {
  // Parse first: a URI carrying userinfo is refused even when the client's own
  // document lists it, so no later comparison can be fooled by it.
  const requested = parseRedirectUri(redirectUri);
  if (!requested) return false;

  if (client.redirectUris.includes(redirectUri)) return true;
  if (!isLoopback(requested)) return false;

  return client.redirectUris.some((registered) => {
    const candidate = parseRedirectUri(registered);
    return (
      candidate !== undefined &&
      isLoopback(candidate) &&
      candidate.protocol === requested.protocol &&
      candidate.hostname === requested.hostname &&
      candidate.pathname === requested.pathname &&
      candidate.search === requested.search
    );
  });
}

function parseRedirectUri(value: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  // Userinfo in a redirect target defeats every host check downstream:
  // https://evil.test@claude.ai/cb parses with hostname claude.ai but reads as
  // evil.test to anything that splits on the first "@".
  if (url.username !== "" || url.password !== "") return undefined;
  return url;
}

function isLoopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

/** Parses SEERRSENSE_OAUTH_CLIENTS: `client_id=redirect_uri[,redirect_uri...];...` */
export function parsePreRegisteredClients(raw: string | undefined): ResolvedClient[] {
  if (!raw) return [];
  return raw
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf("=");
      if (separator < 0) {
        throw new Error(`SEERRSENSE_OAUTH_CLIENTS entry is missing '=': ${entry}`);
      }
      const clientId = entry.slice(0, separator).trim();
      const redirectUris = entry
        .slice(separator + 1)
        .split(",")
        .map((uri) => uri.trim())
        .filter(Boolean);
      if (!clientId || redirectUris.length === 0) {
        throw new Error(`SEERRSENSE_OAUTH_CLIENTS entry is incomplete: ${entry}`);
      }
      return { clientId, clientName: clientId, redirectUris, source: "pre-registered" as const };
    });
}
