# Tessera

A pay-per-call API marketplace on Hedera, settled over x402.

Sellers list metered HTTP endpoints. Agents find them over plain HTTP, pay
inside the request, and get a response. No signup, no API key, no
subscription — the `402 Payment Required` status code does the negotiating.

Three things make it more than a payment demo:

1. **Sellers must put money at risk.** A refundable dispute deposit, enforced
   by the API before a listing can go live and re-checked on every call.
2. **A bad response can be disputed**, and an upheld claim refunds the buyer
   out of the seller's deposit.
3. **Pricing is metered, not flat.** A response of 5000 tokens genuinely costs
   a hundred times one of 50, and the gateway holds the response to the budget
   the buyer paid for.

---

## Setup

### Prerequisites

- Node.js 22+
- Docker (local Postgres) **or** a Supabase connection string

### 1. Install and configure

```bash
npm install
cp .env.example .env.local
```

The app runs with no chain credentials at all: discovery, quoting, metering
and the dispute ledger all work, and anything requiring a key says so in the
UI rather than faking a result.

### 2. Database

```bash
npm run db:up       # Postgres 16 in Docker on :5433
npm run db:migrate  # apply schema
npm run db:seed     # 5 sellers, 8 services, 1 agent
```

For Supabase, set `DATABASE_URL` to the **transaction pooler** URI (port
`6543`), not the direct connection on `5432` — serverless functions exhaust
direct connections quickly. Then run `npm run db:migrate && npm run db:seed`.

`npm run db:reset` drops, migrates and reseeds in one step.

### 3. Run

```bash
npm run dev         # http://localhost:3000
```

`GET /api/health` reports exactly what is wired up:

```json
{
  "ok": true,
  "checks": {
    "database": true,
    "facilitator": true,
    "chain_operator": false,
    "hcs_receipts": false
  }
}
```

### 4. Optional credentials

| Variable | Enables |
| --- | --- |
| `HEDERA_OPERATOR_ID` / `HEDERA_OPERATOR_KEY` | Deposit verification, dispute refunds, HCS receipts |
| `HEDERA_RECEIPT_TOPIC_ID` | Writing call/refund receipts to a consensus topic |
| `AGENT_ACCOUNT_ID` / `AGENT_PRIVATE_KEY` | The buyer agent signing and completing real payments |
| `CRON_SECRET` | Guards the receipt-drain cron endpoint |

Testnet accounts come from [portal.hedera.com](https://portal.hedera.com).

#### What the free-tool allowance does

A free tool takes no payment and needs no token, so nothing else limits it —
the seller pays their upstream bill for whoever finds the URL. The allowance is
what bounds that.

| Caller | Free calls / day | Keyed to |
| --- | --- | --- |
| Anonymous | 25 | coarse hash of origin |
| Registered agent | 100 | agent id |

Funding an agent does not raise it: money buys paid tools, not free ones. Tune
with `FREE_LIMIT_ANONYMOUS` and `FREE_LIMIT_AGENT`.

#### The dispute deposit

The deposit makes a bad listing cost the seller something. Every seller holds
at least **10 ℏ**, refundable, and an upheld dispute is paid out of it — so
every listing a seller publishes is backed by the same balance. It is checked
when a listing is created and again on every call, so a seller who withdraws
below the minimum stops being callable immediately.

### 5. Tests

```bash
npm run dev     # the HTTP suites need a running gateway
npm test        # 345 tests
```

The suite covers unit logic, The Graph client and the schema appraiser, a live
call against the Blocky402 facilitator,
end-to-end HTTP against the gateway, the dispute ledger and the seller gate. Tests that create
rows clean up after themselves, so the seeded fixtures survive repeated runs.

### Deploying to Vercel

`vercel.json` registers the receipt drain as a daily cron job — the most a Hobby
plan allows — which is only a backstop: receipts are normally submitted seconds
after each call.
Set the environment variables above in the Vercel dashboard and point
`DATABASE_URL` at the Supabase pooler.

`NEXT_PUBLIC_BASE_URL` is optional on Vercel: production resolves to the
project's stable domain (`VERCEL_PROJECT_PRODUCTION_URL`) on its own. Set it
explicitly only for a custom domain, or if system environment variables are
disabled — and never paste the `localhost` value from `.env.local`. The base URL
is not just display text: the MCP payer calls back into `/x402` through it, so a
wrong value breaks every paid tool call.

---

## Architecture

```
                  ┌────────────────────────────────────────────┐
   agent ──GET──► │  /x402/[slug]           the gateway        │
                  │                                            │
   402 quote ◄────│  1. listing gate   verified seller?        │
                  │                    deposit ≥ minimum?      │
   agent signs    │  2. quote          price × declared units  │
   a transfer     │  3. verify ───────────────► Blocky402      │
                  │  4. deliver ──────────────► seller API     │
   ──X-PAYMENT──► │  5. settle ───────────────► Blocky402      │
                  │  6. receipt ──────────────► HCS (async)    │
   200 + data ◄───│                                            │
                  └────────────────────────────────────────────┘
                           │                        │
                           ▼                        ▼
                    Postgres read model      Hedera testnet
                    (endpoints, search,      (payments, deposits,
                     call log, claims)        refunds, receipts)
```

**The chain is authoritative for money; Postgres is a read model.** Endpoint
URLs, descriptions, search text and response bodies never belonged on a
ledger. Payments, deposits, refunds and receipts do. Every row that records a
value movement stores the transaction hash beside it, so the database can be
rebuilt from the chain and never becomes the sole record of a payment.

Settlement is never implemented in this repo. `/verify` and `/settle` are
delegated to the Blocky402 facilitator, which also covers gas via a fee-payer
account read live from its `/supported` endpoint rather than hardcoded.

### Layout

| Path | Role |
| --- | --- |
| `src/app/x402/[slug]/route.ts` | The paid endpoint — quote, verify, deliver, settle, receipt |
| `src/lib/x402.ts` | x402 v2 wire types and the facilitator client |
| `src/lib/metering.ts` | Unit metering and response trimming |
| `src/lib/agent.ts` | The autonomous buyer |
| `src/lib/claims.ts` | Disputes and refunds from deposit |
| `src/lib/quota.ts` | The free-tool allowance |
| `src/lib/receipts.ts` | HCS receipt outbox and drain |
| `src/lib/ssrf.ts` | Endpoint safety for seller-supplied URLs |
| `db/migrations/` | Schema |

---

## Payment Flow

**1. Quote.** An unpaid request returns `402` carrying the amount, asset,
pay-to account and the facilitator's fee payer. The price is computed
server-side from the listing and the requested unit budget — never from
anything the client sends.

```bash
curl -i http://localhost:3000/x402/open-exchange-rates
```

```
HTTP/1.1 402 Payment Required

{
  "x402Version": 2,
  "resource": { "url": ".../x402/open-exchange-rates" },
  "accepts": [{
    "scheme": "exact",
    "network": "hedera:testnet",
    "asset": "0.0.0",
    "amount": "90000",
    "payTo": "0.0.7326076",
    "maxTimeoutSeconds": 300,
    "extra": { "feePayer": "0.0.7162784" }
  }]
}
```

Payment goes **directly to the seller's account**. The marketplace never
custodies call revenue.

**2. Verify.** The agent signs a Hedera transfer, base64-encodes it into an
`X-PAYMENT` header and repeats the request. The gateway rebuilds the payment
requirements from its own database — the client's `accepted` block is
untrusted — and asks the facilitator to verify.

Before verifying, the Hedera transaction id is extracted from the signed
payload and checked against a `UNIQUE` index on `calls.payment_tx`. A replayed
payment header cannot buy a second delivery.

**3. Deliver.** Only after verification passes does the gateway call the
upstream endpoint. **If the upstream fails, no settlement is attempted** and
the buyer keeps their money — taking payment for a response that could not be
produced is the one outcome the dispute flow should never have to clean up.

**4. Settle.** With a good response in hand, the facilitator submits the
transfer and the seller is paid.

**5. Receipt.** The call is recorded with its transaction hash, and a receipt
carrying the request and response digests is queued for the Hedera Consensus
Service. Consensus takes seconds, so it is submitted after the response has been
sent rather than held on the request path, with a daily cron as a backstop for
anything missed — only digests go on-chain, never the bodies.

### Metering

Listings price by `per_call`, `per_token` or `per_row`. For metered units the
buyer declares a budget with `?units=N`; the quote is price × N, and the
gateway trims the response to that budget. A buyer can never be billed for
more than it agreed to.

```
/x402/wikipedia-extract?units=50     →     20,000 tinybars
/x402/wikipedia-extract?units=5000   →  2,000,000 tinybars
```

---

## Sponsor requirement map

Line numbers refer to this repository. Before submission, pin these to a
commit SHA so they become permanent links.

### The Graph — Composable Products, and AI Tooling (Continuity)

| Requirement | Implementation |
| --- | --- |
| Two or more Graph products composed | Network catalogue subgraph, GraphQL introspection, Subgraph Gateway, and the x402 gateway read as a price oracle — [`src/lib/graph.ts`](src/lib/graph.ts) |
| Live data from a Graph provider | [`executeSubgraphQuery`](src/lib/graph.ts) through `gateway.thegraph.com` |
| Standardized schemas | Messari lending v3.1.0. One query document answers **Aave on Ethereum and Moonwell on Base** — two different protocols, two chains, no per-chain branching — [`MESSARI_LENDING`](src/lib/graph.ts) |
| The Graph load-bearing, not decorative | Discovery, schema and delivery all route through it; remove it and the Graph-backed listings cannot be appraised or served |
| Meaningful AI reasoning | [`src/lib/appraise.ts`](src/lib/appraise.ts) — reads a subgraph schema, matches the question's concepts against it, and **refuses to pay** when nothing fits |
| Open source | MIT, see [`LICENSE`](LICENSE) |

Price discovery is free: reading The Graph's own 402 challenge costs nothing
and needs no key, so the marketplace can show what data would have cost bought
direct without buying it.

### Hedera — Tokenization of Anything

| Requirement | Implementation |
| --- | --- |
| Asset Tokenization Studio used | [`../tollgate-ats`](../tollgate-ats) — issuance toolkit, kept out of this repo because the ATS SDK is 1.4GB |
| Tokenized asset on testnet | **Tollgate Seller Deposit Bond** (`TGDEP`), ISIN `XFTGDEP00013`, [`0.0.10367762`](https://hashscan.io/testnet/contract/0.0.10367762) |
| Managed, not just issued | Full dispute lifecycle on chain: issue -> hold -> read -> execute. Final balances seller 175, buyer 25, **marketplace 0** |
| Read back by this app | [`src/lib/tokenized-deposit.ts`](src/lib/tokenized-deposit.ts) — `balanceOf` over the JSON-RPC relay, no SDK. Surfaced on the seller page at [`/sellers/0.0.7399100`](src/app/sellers/%5Baccount%5D/page.tsx), which reads the bond live rather than trusting our own column |

The bond was issued before the project was renamed, so it carries the earlier
name, Tollgate. The contract id is the identity that matters.

The point is not that a token was minted. ERC-1400 *holds* let the marketplace
lock a seller's units against a named beneficiary without ever owning them, so
it can pay out an upheld dispute but can never take the deposit for itself —
enforced by the token rather than by our code behaving.

### Hedera — Open Source, Improve the Hedera Harness

| Requirement | Implementation |
| --- | --- |
| Meaningful contribution | An HTTP/API validator tier for [hedera-dev/hedera-harness](https://github.com/hedera-dev/hedera-harness) |
| The problem it fixes | The Playwright gate fails any status >= 400 **and** any body without rendered text, so a correct x402 endpoint fails twice and the repair loop "fixes" a working app. `x402` appeared nowhere in the harness |
| Tests | 23 new, 218 of theirs pass, typecheck clean |

### Hedera — Continuity

Tessera already existed on Hedera before the event, with a real settled paid
call on testnet. See [`PRIOR_WORK.md`](PRIOR_WORK.md) for the boundary and the
work done during ETHOnline 2026.

### Hedera — AI & Agentic Payments

| Requirement | Implementation |
| --- | --- |
| Live x402-gated service on Hedera testnet | [`src/app/x402/[slug]/route.ts:52`](src/app/x402/%5Bslug%5D/route.ts#L52) |
| Settled through the Blocky402 facilitator | [`src/lib/x402.ts:237`](src/lib/x402.ts#L237) (verify), [`src/lib/x402.ts:248`](src/lib/x402.ts#L248) (settle) |
| Platform/agent consuming it end to end | [`src/lib/agent.ts:66`](src/lib/agent.ts#L66) |
| README: setup, architecture, payment flow | This file |

**Extra points**

| Criterion | Implementation |
| --- | --- |
| Metering rather than a flat per-request charge | [`src/lib/metering.ts:34`](src/lib/metering.ts#L34), [`src/lib/money.ts:77`](src/lib/money.ts#L77) |
| Agent discovery — a directory other agents can query | [`src/app/api/services/route.ts:16`](src/app/api/services/route.ts#L16), [`src/lib/repo.ts:110`](src/lib/repo.ts#L110) |
| On-chain agent identity, HCS-14 | [`src/lib/agent-identity.ts`](src/lib/agent-identity.ts) — Universal Agent IDs derived from canonical public inputs (SHA-384, base58), published for the buyer and every seller through `/api/services`. Derived rather than assigned, so a counterparty can recompute it without this marketplace vouching |
| Verifiable payment audit trails on HCS | [`src/lib/receipts.ts:50`](src/lib/receipts.ts#L50), [`src/lib/hedera.ts:80`](src/lib/hedera.ts#L80) |
| Fee-payer / custom settlement path | [`src/lib/x402.ts:40`](src/lib/x402.ts#L40) — fee payer read live from `/supported` |

### Cross-cutting

| Concern | Implementation |
| --- | --- |
| Disputes refunded from the seller's deposit | [`src/lib/claims.ts:175`](src/lib/claims.ts#L175) |
| Deterministic auto-adjudication | [`src/lib/claims.ts:143`](src/lib/claims.ts#L143) |
| Deposit verified on-chain via mirror node | [`src/lib/hedera.ts:160`](src/lib/hedera.ts#L160) |
| Agent spending caps enforced pre-signature | [`src/lib/wallet.ts`](src/lib/wallet.ts) — balance, per-call and daily caps checked before any debit |
| Free-tool abuse bounded by proof of a person | [`src/lib/quota.ts`](src/lib/quota.ts) |
| Payment replay guard | [`src/app/x402/[slug]/route.ts:155`](src/app/x402/%5Bslug%5D/route.ts#L155) |
| SSRF protection on seller endpoints | [`src/lib/ssrf.ts:76`](src/lib/ssrf.ts#L76) |

---

## Demo fixtures

`npm run db:seed` creates five sellers whose services wrap **real, key-free
public APIs**, so a paid call returns genuine data:

| Service | Seller | Price | Metering |
| --- | --- | --- | --- |
| Open Exchange Rates | Northwind APIs | 0.0009 ℏ | per call |
| ECB Reference Rates | Meridian Data | 0.0012 ℏ | per call |
| Currency API Rates | Cobalt Feeds | 0.0015 ℏ | per call |
| Weather Now | Northwind APIs | 0.0008 ℏ | per call |
| BTC Spot Price | Meridian Data | 0.001 ℏ | per call |
| Wikipedia Extract | Cobalt Feeds | 0.000004 ℏ | per token |
| Hacker News Top Stories | Cobalt Feeds | 0.0000006 ℏ | per row |
| Lowline Spot Quote | Lowline Metrics | 0.0001 ℏ | per call — **deposit below minimum, unpayable** |

Three sellers publish the same capability at three prices, which is what makes
"the agent picks the cheapest without a human" a real test rather than a
staged one. Two fixtures exist purely to prove the gates work: *Lowline
Metrics* is verified but underfunded, and *Unregistered Labs* is unverified.

## Licence

MIT
