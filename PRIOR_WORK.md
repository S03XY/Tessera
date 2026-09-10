# Prior work disclosure — ETHOnline 2026

**Tessera is submitted on the ETHGlobal Continuity Track ("Extend Open
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

### 1. The Graph, as inventory rather than an integration

The marketplace worked before the event but had nothing valuable on it: eight
free public APIs behind a paywall. It now resells subgraph data, bought in
dollars and sold in HBAR, so a buying agent never needs a Base wallet.

Four of The Graph's own surfaces are used, each answering a question the
marketplace genuinely has to ask:

| Surface | Question it answers |
| --- | --- |
| The Graph Network subgraph | what data exists, and does anyone use it |
| GraphQL introspection | can this subgraph answer *my* question |
| Subgraph Gateway | execute it and return the data |
| The Graph's x402 gateway | what would this cost bought direct |

The last is free — reading a 402 challenge costs nothing and needs no key —
which is what makes it usable as a price oracle rather than a purchase.

Two of the three seeded Graph listings share **one schema across two chains**
(Messari standardized lending, Ethereum and Base). The same query document
answers both, which is what makes "lending TVL" a capability rather than a
per-chain integration.

- `src/lib/graph.ts`, `db/migrations/0003_graph_upstreams.sql`
- Gateway delivery branch in `src/app/x402/[slug]/route.ts`
- Pricing derived from real upstream cost: `floorPriceTinybars()`

### 2. The agent refuses to pay when it cannot answer

The buyer agent used to take the cheapest listing that matched a text search.
It now reads a candidate's schema first, matches the question's concepts
against what the subgraph actually publishes, and **declines to pay when
nothing fits** — naming the concepts it could not find.

An unreadable schema is treated differently from one that was read and did not
match: the first is an unknown, and the agent declines rather than guessing.

- `src/lib/appraise.ts`, wired into `src/lib/agent.ts`

### 3. Seller deposits as real security tokens

The dispute deposit moves from raw HBAR in the marketplace's wallet to an
**ERC-1400 security token** issued through Hedera's Asset Tokenization Studio,
with disputes settled by ERC-1400 *holds*.

Live on Hedera testnet: **Tollgate Seller Deposit Bond (TGDEP)**, ISIN
`XFTGDEP00013`, contract
[`0.0.10367762`](https://hashscan.io/testnet/contract/0.0.10367762).
The bond was issued before the project was renamed, so it carries the earlier
name, Tollgate. The contract id is the identity that matters.

A full dispute ran end to end — issue, hold, read, execute — finishing at
seller 175, buyer 25, **marketplace 0**. The marketplace mediated a payout
without ever holding the funds, and the token prevents it from taking them.

- Issuance toolkit: [`../tollgate-ats`](../tollgate-ats) (separate repo — the
  ATS SDK is 1.4GB)
- App-side reading with no SDK: `src/lib/tokenized-deposit.ts`,
  `db/migrations/0004_tokenized_deposits.sql`

### 4. An x402 validator for the Hedera Harness

Contributed upstream to
[hedera-dev/hedera-harness](https://github.com/hedera-dev/hedera-harness).
Its Playwright gate fails any route returning ≥ 400 **and** any body without
rendered text — so a correct x402 endpoint answering `402 Payment Required`
with JSON fails twice, and the repair loop burns attempts "fixing" a working
app. `x402` appeared nowhere in the harness.

Routes may now declare HTTP expectations and be checked without a browser.
218 of their tests pass, including 23 new ones.

### Totals

Roughly 3,300 lines across two repositories. 635 tests in the marketplace and
23 added to the Hedera Harness. Lint and typecheck clean.

<!-- END EVENT WORK -->

---

## Where this goes next

Named because the Continuity track asks for it, and because the work below is
already scoped rather than aspirational.

1. **Sellers issue their own bonds.** Today one seller's deposit is a real
   ERC-1400 bond and the rest are HBAR balances. The issuance toolkit already
   does the work; it needs an onboarding path so a seller mints their own at
   listing time rather than an operator doing it for them.
2. **Holds placed by the marketplace, not by a script.** The dispute flow
   records a hold reference, and the ERC-1400 hold lifecycle runs today through
   the toolkit. Moving that behind the claims API is what makes the guarantee
   automatic instead of demonstrated.
3. **Free-tool allowances that a seller sets.** The allowance is a marketplace
   policy today. A seller who publishes a free tool is the one paying its
   upstream bill, so the ceiling should ultimately be theirs to choose.
4. **Compliance controls on the bond.** The token is issuable with KYC grants,
   freezes and transfer restrictions, all currently off. A marketplace operating
   under any real regime turns them on.
5. **Settlement beyond HBAR.** The paywall already offers a menu of independent
   networks. Adding a stablecoin option is a listing level change, not an
   architectural one.

---

## Things a judge should know without having to find them

Named here on purpose. Each is a real limitation, not a rough edge.

1. **World ID runs in simulation mode until the Developer Portal setup is
   finished.** Selfie Check is feature-gated by World and must be switched on
   per-app. The live path is complete and any ungated credential runs it —
   `WORLD_CREDENTIAL` chooses. Until then a simulated pass is stored as
   `selfie_check_simulated`, labelled as simulated everywhere in the UI, and
   reported by `/api/health`. It is not a World ID proof. Run
   `npm run world:preflight` for the exact state. See
   [`WORLD_FEEDBACK.md`](WORLD_FEEDBACK.md).

2. **The marketplace never holds call revenue** — payment goes directly from
   buyer to seller. It does control the discovery database and the receipt
   topic, and it does custody seller dispute deposits. That is the honest
   trust boundary.

3. **Separate chains are separate.** Where Tessera offers payment on more
   than one network, those networks have no connection to each other and
   nothing bridges between them. It is one paywall offering a menu of
   independent settlement options, which is what x402 was designed for.
