# Tollgate

A pay-per-call API marketplace on Hedera, settled over x402.

Sellers list metered HTTP endpoints. Agents find them over plain HTTP, pay
inside the request, and get a response. No signup, no API key, no
subscription — the `402 Payment Required` status code does the negotiating.

Three things make it more than a payment demo:

1. **Sellers must prove they are a distinct human and put money at risk.**
   World ID Selfie Check plus a refundable dispute deposit, both enforced by
   the API before a listing can go live.
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
| `WORLD_APP_ID` / `WORLD_RP_ID` / `WORLD_RP_SIGNING_KEY` | World ID Selfie Check |
| `WORLD_SIMULATION=1` | Stand-in for Selfie Check until World enables the credential |
| `CRON_SECRET` | Guards the receipt-drain cron endpoint |

Testnet accounts come from [portal.hedera.com](https://portal.hedera.com).
World credentials come from [developer.world.org](https://developer.world.org).

> **Selfie Check is feature-gated.** It must be enabled for your app by World
> before it works — including in the Sandbox App. Request access through your
> World point of contact before relying on it.
>
> Until then, set `WORLD_SIMULATION=1` to record clearly-labelled simulated
> passes so the seller gate and the demo still work. A simulated pass stores
> the credential as `selfie_check_simulated`, is labelled as simulated
> everywhere in the UI, and is reported by `/api/health` as
> `world_id: "simulated"`. **It is not a Selfie Check** and does not satisfy
> World's requirement to demo through the Sandbox App.

### 5. Tests

```bash
npm run dev     # the HTTP suites need a running gateway
npm test        # 177 tests
```

The suite covers unit logic, a live call against the Blocky402 facilitator,
end-to-end HTTP against the gateway, the dispute ledger and the seller gate. Tests that create
rows clean up after themselves, so the seeded fixtures survive repeated runs.

### Deploying to Vercel

`vercel.json` registers the receipt drain as a cron job every five minutes.
Set the environment variables above in the Vercel dashboard, point
`DATABASE_URL` at the Supabase pooler, and set `NEXT_PUBLIC_BASE_URL` to the
deployment URL so the `resource` field in 402 responses is absolute.

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
| `src/lib/world.ts` | Selfie Check verification and the sybil gate |
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
Service. Consensus takes seconds, so it is drained by cron rather than held on
the request path — only digests go on-chain, never the bodies.

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
| Verifiable payment audit trails on HCS | [`src/lib/receipts.ts:50`](src/lib/receipts.ts#L50), [`src/lib/hedera.ts:80`](src/lib/hedera.ts#L80) |
| Fee-payer / custom settlement path | [`src/lib/x402.ts:40`](src/lib/x402.ts#L40) — fee payer read live from `/supported` |

### World — Selfie Check

| Requirement | Implementation |
| --- | --- |
| Uses Selfie Check meaningfully | [`src/app/onboarding/selfie-check.tsx:5`](src/app/onboarding/selfie-check.tsx#L5) |
| Treated as an abuse-prevention signal | [`src/lib/world.ts:148`](src/lib/world.ts#L148) — nullifier under a `UNIQUE` constraint: one human, one seller |
| Enforced, not decorative | [`src/app/api/services/create/route.ts:83`](src/app/api/services/create/route.ts#L83) — listing refused without verification |
| Server-side proof verification | [`src/lib/world.ts:96`](src/lib/world.ts#L96) |
| Tested via the Sandbox App | **Not yet** — credential is feature-gated. See [`WORLD_FEEDBACK.md`](WORLD_FEEDBACK.md) |
| Feedback document | [`WORLD_FEEDBACK.md`](WORLD_FEEDBACK.md) |

### Cross-cutting

| Concern | Implementation |
| --- | --- |
| Disputes refunded from the seller's deposit | [`src/lib/claims.ts:175`](src/lib/claims.ts#L175) |
| Deterministic auto-adjudication | [`src/lib/claims.ts:143`](src/lib/claims.ts#L143) |
| Deposit verified on-chain via mirror node | [`src/lib/hedera.ts:160`](src/lib/hedera.ts#L160) |
| Agent spending caps enforced pre-signature | [`src/lib/agent.ts:213`](src/lib/agent.ts#L213) |
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
