import { describe, expect, it } from "vitest";
import { assertPublicUrl, isPrivateAddress, UnsafeUrlError } from "@/lib/ssrf";

/**
 * The gateway fetches seller-supplied URLs. These tests are the difference
 * between a marketplace and an open SSRF relay, so they cover the ranges an
 * attacker would actually reach for.
 */

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "0.0.0.0",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // AWS/GCP instance metadata
    "100.64.0.1", // CGNAT
    "224.0.0.1", // multicast
    "255.255.255.255",
  ])("flags IPv4 %s as private", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "192.167.1.1"])(
    "allows public IPv4 %s",
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );

  it.each(["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:10.0.0.1"])(
    "flags IPv6 %s as private",
    (address) => {
      expect(isPrivateAddress(address)).toBe(true);
    },
  );

  it("allows a public IPv6 address", () => {
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("refuses anything that is not an IP at all", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(true);
  });
});

describe("assertPublicUrl — rejects", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["loopback by name", "http://localhost:8080/x", /not reachable/],
    ["loopback by address", "http://127.0.0.1/x", /private range/],
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/", /private range/],
    ["private class A", "http://10.0.0.5/internal", /private range/],
    ["private class C", "https://192.168.0.1/admin", /private range/],
    ["docker internal name", "http://db.internal/health", /not reachable/],
    ["mdns name", "http://printer.local/status", /not reachable/],
    ["gcp metadata name", "http://metadata.google.internal/x", /not reachable/],
    ["file protocol", "file:///etc/passwd", /unsupported protocol/],
    ["gopher protocol", "gopher://example.com/", /unsupported protocol/],
    ["embedded credentials", "https://user:pass@example.com/", /credentials/],
    ["not a URL", "just a string", /valid absolute URL/],
    ["unresolvable host", "https://this-host-does-not-exist-tessera.invalid/", /does not resolve/],
  ];

  it.each(cases)("%s", async (_label, url, expected) => {
    await expect(assertPublicUrl(url)).rejects.toThrow(UnsafeUrlError);
    await expect(assertPublicUrl(url)).rejects.toThrow(expected);
  });
});

describe("assertPublicUrl — accepts", () => {
  it.each([
    "https://api.coinbase.com/v2/prices/BTC-USD/spot",
    "https://open.er-api.com/v6/latest/USD",
    "http://example.com/plain-http-is-allowed",
  ])("allows %s", async (url) => {
    const result = await assertPublicUrl(url);
    expect(result.protocol).toMatch(/^https?:$/);
  });

  it("returns a parsed URL preserving the query string", async () => {
    const url = await assertPublicUrl(
      "https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR",
    );
    expect(url.searchParams.get("symbols")).toBe("EUR");
  });
});
