import { describe, it, expect } from "vitest";
import {
  assertPublicSeerrUrl,
  BlockedAddressError,
  isBlockedAddress,
  ResolutionUnavailableError,
  UnresolvableAddressError,
} from "../src/providers/seerr/guard.js";

describe("isBlockedAddress", () => {
  const blocked = [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.1",
    "192.168.1.5",
    "198.18.0.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "::ffff:10.0.0.1",
    "::ffff:a00:1",
    // Alternate spellings of 127.0.0.1, which must reduce to the same
    // decision as the canonical dotted form.
    "2130706433",
    "0x7f.1",
    "0x7f000001",
  ];

  it.each(blocked)("blocks %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  const allowed = ["93.184.216.34", "8.8.8.8", "2606:2800::1", "2606:2800:220:1:248:1893:25c8:1946"];

  it.each(allowed)("allows the public control %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it("is not fooled by a non-IP string", () => {
    expect(isBlockedAddress("not-an-address")).toBe(false);
  });
});

describe("assertPublicSeerrUrl", () => {
  it("separates a name that does not resolve from a resolver that did not answer", async () => {
    // dns.lookup throws for a name outside the DNS rather than returning an
    // empty list, so before this the raw system error escaped the guard and
    // the account page answered 500 "internal error" for a typo. ENOTFOUND and
    // ENODATA are the resolver speaking about the name; EAI_AGAIN is the
    // resolver not speaking at all, which is our outage and not a typo.
    const throwing = (code: string) => async () => {
      throw Object.assign(new Error(`getaddrinfo ${code} media.example.com`), { code });
    };
    for (const code of ["ENOTFOUND", "ENODATA"]) {
      const lookup = throwing(code);
      await expect(assertPublicSeerrUrl("https://media.example.com", { lookup })).rejects.toBeInstanceOf(
        UnresolvableAddressError,
      );
      // Still a BlockedAddressError, so every dial-time refusal holds.
      await expect(assertPublicSeerrUrl("https://media.example.com", { lookup })).rejects.toBeInstanceOf(
        BlockedAddressError,
      );
    }

    // Every getaddrinfo failure node does not fold into ENOTFOUND arrives with
    // an EAI_ code, so the prefix is the test, not a list that the next code
    // would fall off.
    for (const code of ["EAI_AGAIN", "EAI_FAIL", "EAI_SYSTEM"]) {
      await expect(
        assertPublicSeerrUrl("https://media.example.com", { lookup: throwing(code) }),
      ).rejects.toBeInstanceOf(ResolutionUnavailableError);
    }

    const servfail = throwing("EAI_AGAIN");
    await expect(assertPublicSeerrUrl("https://media.example.com", { lookup: servfail })).rejects.toBeInstanceOf(
      ResolutionUnavailableError,
    );
    await expect(assertPublicSeerrUrl("https://media.example.com", { lookup: servfail })).rejects.not.toBeInstanceOf(
      UnresolvableAddressError,
    );
    await expect(assertPublicSeerrUrl("https://media.example.com", { lookup: servfail })).rejects.toBeInstanceOf(
      BlockedAddressError,
    );

    // An answer with nothing in it reads as ENODATA.
    await expect(
      assertPublicSeerrUrl("https://media.example.com", { lookup: async () => [] }),
    ).rejects.toBeInstanceOf(UnresolvableAddressError);

    // Anything else a lookup throws is a real fault and keeps its stack.
    await expect(
      assertPublicSeerrUrl("https://media.example.com", {
        lookup: async () => {
          throw new TypeError("lookup is not a function");
        },
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("rejects a scheme other than https", async () => {
    await expect(assertPublicSeerrUrl("http://media.example.com")).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it("rejects userinfo", async () => {
    await expect(assertPublicSeerrUrl("https://user:pass@media.example.com")).rejects.toBeInstanceOf(
      BlockedAddressError,
    );
  });

  it("rejects a non-empty query or fragment", async () => {
    await expect(assertPublicSeerrUrl("https://media.example.com?x=1")).rejects.toBeInstanceOf(BlockedAddressError);
    await expect(assertPublicSeerrUrl("https://media.example.com#frag")).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it("rejects a blocked literal IP without ever calling the resolver", async () => {
    const lookup = async () => {
      throw new Error("must not be called for a literal IP");
    };
    for (const url of [
      "https://10.0.0.1",
      "https://169.254.169.254",
      "https://[::1]",
      "https://[::ffff:10.0.0.1]",
      "https://100.64.0.1",
      "https://[fd00::1]",
    ]) {
      await expect(assertPublicSeerrUrl(url, { lookup })).rejects.toBeInstanceOf(BlockedAddressError);
    }
  });

  it("resolves a hostname and rejects if any answer is blocked", async () => {
    await expect(
      assertPublicSeerrUrl("https://media.example.com", { lookup: async () => ["10.0.0.5"] }),
    ).rejects.toBeInstanceOf(BlockedAddressError);

    await expect(
      assertPublicSeerrUrl("https://media.example.com", {
        lookup: async () => ["93.184.216.34", "10.0.0.5"],
      }),
    ).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it("allows a hostname whose every answer is public", async () => {
    const { addresses } = await assertPublicSeerrUrl("https://media.example.com", {
      lookup: async () => ["93.184.216.34"],
    });
    expect(addresses).toEqual(["93.184.216.34"]);
  });

  it("rejects a hostname that resolves to nothing", async () => {
    await expect(
      assertPublicSeerrUrl("https://media.example.com", { lookup: async () => [] }),
    ).rejects.toBeInstanceOf(BlockedAddressError);
  });
});
