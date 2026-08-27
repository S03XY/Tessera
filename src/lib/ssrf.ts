import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Seller-supplied endpoint URLs are fetched by our server, which makes the
 * gateway a request forwarder. Without this guard anyone could list a service
 * pointing at 169.254.169.254 or a container-internal host and use the
 * marketplace as an SSRF relay against our own infrastructure.
 */

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.goog",
]);

/** IPv4 ranges that must never be reachable from a seller-controlled URL. */
function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // unparseable: refuse rather than guess
  }
  const [a, b] = parts;

  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 0) return true; // 192.0.0/24, 192.0.2/24
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true; // TEST-NET-2
  if (a === 203 && b === 0) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast + reserved + broadcast

  return false;
}

function isPrivateIPv6(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, "");

  if (value === "::" || value === "::1") return true; // unspecified, loopback
  if (value.startsWith("fe80")) return true; // link-local
  if (/^f[cd]/.test(value)) return true; // unique local fc00::/7
  if (value.startsWith("ff")) return true; // multicast

  // IPv4-mapped (::ffff:10.0.0.1) inherits the IPv4 rules.
  const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);

  return false;
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isPrivateIPv6(address);
  return true;
}

/**
 * Validates a seller endpoint at listing time and again before every fetch.
 * DNS is resolved here so a hostname that later points at a private address
 * (DNS rebinding) is still rejected at call time.
 */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError("endpoint_url is not a valid absolute URL");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UnsafeUrlError(`unsupported protocol ${url.protocol}`);
  }

  if (url.username || url.password) {
    throw new UnsafeUrlError("credentials in the endpoint URL are not allowed");
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");

  if (!hostname) throw new UnsafeUrlError("endpoint URL has no host");
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new UnsafeUrlError(`host ${hostname} is not reachable from the gateway`);
  }
  if (hostname.endsWith(".internal") || hostname.endsWith(".local")) {
    throw new UnsafeUrlError(`host ${hostname} is not reachable from the gateway`);
  }

  // Literal IP in the URL: check directly, no DNS involved.
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new UnsafeUrlError(`address ${hostname} is in a private range`);
    }
    return url;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new UnsafeUrlError(`host ${hostname} does not resolve`);
  }

  if (addresses.length === 0) {
    throw new UnsafeUrlError(`host ${hostname} does not resolve`);
  }

  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) {
      throw new UnsafeUrlError(`host ${hostname} resolves to a private address`);
    }
  }

  return url;
}

/** Fetch with a hard timeout, no redirects to unvetted hosts, and a size cap. */
export const UPSTREAM_TIMEOUT_MS = 12_000;
export const UPSTREAM_MAX_BYTES = 1_500_000;

export async function fetchUpstream(
  url: URL,
  init: RequestInit = {},
): Promise<{ status: number; body: string; contentType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      // Following a redirect would bypass the DNS check above.
      redirect: "manual",
      headers: {
        accept: "application/json, text/plain;q=0.9, */*;q=0.5",
        "user-agent": "Tollgate-Gateway/0.1 (+https://github.com/tollgate)",
        ...(init.headers ?? {}),
      },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location") ?? "";
      const target = await assertPublicUrl(new URL(location, url).toString());
      const followed = await fetch(target, {
        signal: controller.signal,
        redirect: "manual",
        headers: { accept: "application/json, text/plain;q=0.9, */*;q=0.5" },
      });
      return readCapped(followed);
    }

    return readCapped(response);
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(response: Response) {
  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  const text = await response.text();
  return {
    status: response.status,
    body: text.length > UPSTREAM_MAX_BYTES ? text.slice(0, UPSTREAM_MAX_BYTES) : text,
    contentType,
  };
}
