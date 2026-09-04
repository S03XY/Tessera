# Prior work disclosure — ETHOnline 2026

**Tollgate is submitted on the ETHGlobal Continuity Track ("Extend Open
Source"). Part of this repository pre-dates the event. This document draws the
line, so nothing about it has to be taken on trust.**

The boundary is a tag:

```
git tag pre-ethonline2026        # commit 0549a6c, 2026-08-27
```

Everything reachable from that tag existed **before** ETHOnline 2026 opened on
4 September 2026. Everything after it was built during the event.

```bash
git log pre-ethonline2026                  # the baseline, 9 commits, all 2026-08-27
git log pre-ethonline2026..HEAD            # every line written during ETHOnline 2026
git diff  pre-ethonline2026..HEAD --stat   # the same, as a diffstat
```

Only the second list is offered for judging.

---

## What existed before the event

Built privately on 2026-08-27. Nine commits, roughly 8,000 lines of
TypeScript, 177 tests. It was never submitted to a previous hackathon; it was
a working private project, which is what the "Extend Open Source" sub-track
contemplates.

| Area | What was already there |
| --- | --- |
| x402 gateway | `src/app/x402/[slug]/route.ts` — the 402 handshake: quote, verify, deliver, settle, receipt |
| Settlement | Hedera testnet via the Blocky402 facilitator. A real settled paid call landed on 2026-08-27 (commit `279e9f1`) |
| Metering | `per_call`, `per_token`, `per_row` pricing, responses trimmed to the budget paid for |
| Discovery | `GET /api/services` — a machine-readable directory |
| Buyer agent | `src/lib/agent.ts` — discovers, compares prices, pays, obeys a spending cap |
| Disputes | `src/lib/claims.ts` — claims, deterministic adjudication, refunds from the seller's deposit |
| Sybil gate | `src/lib/world.ts` — World ID, one human one seller, enforced server-side |
| Receipts | `src/lib/receipts.ts` — request/response digests to Hedera Consensus Service |
| Safety | `src/lib/ssrf.ts` — SSRF protection on seller-supplied URLs |
| UI | Home, services, sellers, agent console, activity log, onboarding, docs |

### The shape of that history

The nine baseline commits land inside about 95 minutes on one afternoon. That
is a dense, AI-assisted burst, and it is disclosed here rather than explained
away. It is the baseline, not the submission. Work done during the event is
committed continuously and is meant to be read commit by commit.

---

## What was built during ETHOnline 2026

Everything in `git log pre-ethonline2026..HEAD`. This section is kept current
as the event runs.

<!-- BEGIN EVENT WORK -->
_In progress — updated as work lands._
<!-- END EVENT WORK -->

---

## Things a judge should know without having to find them

Named here on purpose. Each is a real limitation, not a rough edge.

1. **The World ID seller gate runs in simulation mode.** World has not enabled
   the Selfie Check credential for this app — it is feature-gated on their
   side and must be switched on per-app, including in the Sandbox App. A
   simulated pass is stored as `selfie_check_simulated`, labelled as simulated
   everywhere in the UI, and reported by `/api/health` as
   `world_id: "simulated"`. It is not a Selfie Check. See
   [`WORLD_FEEDBACK.md`](WORLD_FEEDBACK.md).

2. **The marketplace never holds call revenue** — payment goes directly from
   buyer to seller. It does control the discovery database and the receipt
   topic, and it does custody seller dispute deposits. That is the honest
   trust boundary.

3. **Separate chains are separate.** Where Tollgate offers payment on more
   than one network, those networks have no connection to each other and
   nothing bridges between them. It is one paywall offering a menu of
   independent settlement options, which is what x402 was designed for.
