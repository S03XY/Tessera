import { setDefaultResultOrder } from "node:dns";

/**
 * Process-level network defaults.
 *
 * Imported for its side effect by every module that makes an outbound
 * request, because the alternative — setting it in one of them — leaves the
 * others intermittently broken in a way that looks like someone else's outage.
 *
 * **Prefer IPv4 when resolving.** Many hosts publish AAAA records (often NAT64
 * `64:ff9b::` mappings) while the network has no IPv6 egress at all. Node's
 * happy-eyeballs then races the unreachable AAAA first and gives up after
 * `autoSelectFamilyAttemptTimeout` — 250ms by default — surfacing a bare
 * `fetch failed` with an ETIMEDOUT cause. It is intermittent, because it
 * depends on the order the resolver happens to return addresses in.
 *
 * The symptoms are a seller's specification that "sometimes" will not import
 * and a facilitator that is "sometimes" unreachable, neither of which points
 * anywhere near the cause. Asking for IPv4 first costs nothing on a dual-stack
 * host and makes a single-stack one behave.
 *
 * Set TESSERA_DNS_ORDER=verbatim to leave the platform default alone.
 */
if (process.env.TESSERA_DNS_ORDER !== "verbatim") {
  try {
    setDefaultResultOrder("ipv4first");
  } catch {
    // Older runtimes without the setter keep their default behaviour.
  }
}

/** Importing this module is the point; the export just makes that explicit. */
export const networkDefaultsApplied = true;
