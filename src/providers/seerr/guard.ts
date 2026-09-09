import dns from "node:dns";

/**
 * Guards against a submitted Seerr address being used to reach something it
 * should not: the pod's own neighbours, cloud metadata endpoints, or anything
 * else that is not a public Seerr instance.
 *
 * Used both at submission time (`PUT /api/v1/account/connection`, before any
 * network call) and at dial time (`SeerrClient`, on every request for an
 * untrusted connection), because a hostname can resolve publicly when it is
 * checked and privately when it is used.
 */

export class BlockedAddressError extends Error {
  constructor(message = "that address cannot be used") {
    super(message);
    this.name = "BlockedAddressError";
  }
}

export interface GuardOptions {
  /** Injectable for tests. Defaults to a real DNS lookup of every address. */
  lookup?: (host: string) => Promise<string[]>;
}

async function defaultLookup(host: string): Promise<string[]> {
  const results = await dns.promises.lookup(host, { all: true, verbatim: true });
  return results.map((entry) => entry.address);
}

/**
 * Parses a candidate IPv4 or IPv6 address string, however it was written,
 * into the form the range checks below operate on. Delegates to the WHATWG
 * URL host parser rather than reimplementing it, so "0x7f.1", "2130706433"
 * and "127.0.0.1" all land on the same representation. Returns undefined for
 * a string that is not an IP literal at all (an ordinary hostname).
 */
function parseAddress(raw: string): { family: 4; octets: number[] } | { family: 6; groups: number[] } | undefined {
  let hostname: string;
  try {
    const wrapped = raw.includes(":") && !raw.startsWith("[") ? `[${raw}]` : raw;
    hostname = new URL(`http://${wrapped}/`).hostname;
  } catch {
    return undefined;
  }

  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return { family: 6, groups: parseIPv6Groups(hostname.slice(1, -1)) };
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    return { family: 4, octets: hostname.split(".").map(Number) };
  }
  return undefined;
}

function parseIPv6Groups(addr: string): number[] {
  const expand = (parts: string[]): number[] =>
    parts.flatMap((part) => {
      if (part.includes(".")) {
        const octets = part.split(".").map(Number);
        return [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
      }
      return [parseInt(part, 16) || 0];
    });

  if (addr.includes("::")) {
    const [head, tail] = addr.split("::");
    const headParts = head ? head.split(":").filter(Boolean) : [];
    const tailParts = tail ? tail.split(":").filter(Boolean) : [];
    const headGroups = expand(headParts);
    const tailGroups = expand(tailParts);
    const missing = Math.max(8 - headGroups.length - tailGroups.length, 0);
    return [...headGroups, ...Array(missing).fill(0), ...tailGroups];
  }
  return expand(addr.split(":").filter(Boolean));
}

function ipv4ToInt(octets: number[]): number {
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

function inCidr4(value: number, base: string, prefixLength: number): boolean {
  const baseInt = ipv4ToInt(base.split(".").map(Number));
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return (value & mask) === (baseInt & mask);
}

/** 0.0.0.0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24,
 * 192.168/16, 198.18/15, 224/4, 240/4, 255.255.255.255. */
function isBlockedIPv4(octets: number[]): boolean {
  const value = ipv4ToInt(octets);
  if (inCidr4(value, "0.0.0.0", 8)) return true; // "this network"
  if (inCidr4(value, "10.0.0.0", 8)) return true; // RFC 1918
  if (inCidr4(value, "100.64.0.0", 10)) return true; // CGNAT
  if (inCidr4(value, "127.0.0.0", 8)) return true; // loopback
  if (inCidr4(value, "169.254.0.0", 16)) return true; // link-local, incl. 169.254.169.254
  if (inCidr4(value, "172.16.0.0", 12)) return true; // RFC 1918
  if (inCidr4(value, "192.0.0.0", 24)) return true; // IETF protocol assignments
  if (inCidr4(value, "192.168.0.0", 16)) return true; // RFC 1918
  if (inCidr4(value, "198.18.0.0", 15)) return true; // benchmarking
  if (inCidr4(value, "224.0.0.0", 4)) return true; // multicast
  if (inCidr4(value, "240.0.0.0", 4)) return true; // reserved
  if (value === ipv4ToInt([255, 255, 255, 255])) return true; // broadcast
  return false;
}

/**
 * Range checks on the parsed form, not on strings, so every equivalent
 * spelling of an address reduces to the same decision.
 *
 * An IPv4-mapped (`::ffff:0:0/96`) or IPv4-compatible (`::a.b.c.d`) IPv6
 * address is unwrapped to its embedded IPv4 address and re-tested with the
 * IPv4 rules — this is also how `::` and `::1` end up blocked, since they
 * unwrap to 0.0.0.0 and 0.0.0.1, both inside `0.0.0.0/8`.
 */
export function isBlockedAddress(ip: string): boolean {
  const parsed = parseAddress(ip);
  if (!parsed) return false;

  if (parsed.family === 4) return isBlockedIPv4(parsed.octets);

  const g = parsed.groups;
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && (g[5] === 0 || g[5] === 0xffff)) {
    // IPv4-mapped (g[5] === 0xffff) or IPv4-compatible (g[5] === 0).
    const embedded = [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff];
    return isBlockedIPv4(embedded);
  }
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7, ULA
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10, link-local
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8, multicast
  return false;
}

/**
 * Validates a submitted Seerr address before it is ever dialled.
 *
 * Rejects, in order: a scheme other than `https:`; userinfo; a non-empty
 * query or fragment; a hostname that is already a blocked IP literal; and
 * otherwise a hostname that resolves — by any of its answers, not all of them
 * — to a blocked address. Rejecting on any answer means a DNS response that
 * mixes a public and a private address cannot be used to slip past the
 * check-then-connect race.
 */
export async function assertPublicSeerrUrl(
  raw: string,
  opts: GuardOptions = {},
): Promise<{ url: URL; addresses: string[] }> {
  const url = new URL(raw);

  if (url.protocol !== "https:") {
    throw new BlockedAddressError("only https addresses are allowed");
  }
  if (url.username || url.password) {
    throw new BlockedAddressError("the address may not carry a username or password");
  }
  if (url.search || url.hash) {
    throw new BlockedAddressError("the address may not carry a query string or fragment");
  }

  const literal = parseAddress(url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname);
  if (literal) {
    const ip = literal.family === 4 ? literal.octets.join(".") : url.hostname.slice(1, -1);
    if (isBlockedAddress(ip)) throw new BlockedAddressError("that address cannot be used");
    return { url, addresses: [ip] };
  }

  const lookup = opts.lookup ?? defaultLookup;
  const addresses = await lookup(url.hostname);
  if (addresses.length === 0) {
    throw new BlockedAddressError("that address could not be resolved");
  }
  for (const address of addresses) {
    if (isBlockedAddress(address)) throw new BlockedAddressError("that address cannot be used");
  }
  return { url, addresses };
}
