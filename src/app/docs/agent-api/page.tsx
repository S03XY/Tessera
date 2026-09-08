import Link from "next/link";
import { Badge, Callout, Mono, Page, PageHeader, Panel, PanelHeader } from "@/components/ui";
import { BASE_URL, FACILITATOR_URL, X402_NETWORK } from "@/lib/config";

export const metadata = { title: "Agent API" };

export default function AgentApiPage() {
  return (
    <Page className="max-w-[860px]">
      <PageHeader
        eyebrow="Reference"
        title="Agent API"
        description="Everything an autonomous buyer needs. No key, no session, no signup — discovery is a GET and payment happens inside the request."
      />

      <div className="space-y-5">
        <Endpoint
          method="GET"
          path="/api/services"
          summary="Find services by capability. Ranked cheapest first, then by success rate. Only listings that can actually be paid are returned."
          params={[
            ["q", "Capability in natural words, e.g. “bitcoin price”. Matches names, descriptions and seller-declared keywords."],
            ["category", "Exact category filter, e.g. fx, crypto, weather."],
            ["unit", "per_call | per_token | per_row"],
            ["max_price", "Maximum price in atomic units (tinybars)."],
            ["limit", "1–100, default 25."],
          ]}
          example={`curl "${BASE_URL}/api/services?q=exchange+rates"`}
          response={`{
  "count": 3,
  "services": [
    {
      "slug": "open-exchange-rates",
      "name": "Open Exchange Rates",
      "price": { "amount": "90000", "asset": "0.0.0",
                 "decimals": 8, "unit": "per_call" },
      "seller": { "name": "Northwind APIs",
                  "account": "0.0.7326076", "verified": true },
      "paid_url": "${BASE_URL}/x402/open-exchange-rates",
      "x402": { "version": 2, "scheme": "exact",
                "network": "${X402_NETWORK}",
                "pay_to": "0.0.7326076" }
    }
  ]
}`}
        />

        <Endpoint
          method="GET"
          path="/x402/{slug}"
          summary="The paid endpoint. Without an X-PAYMENT header it answers 402 with a quote. With a valid one it verifies, calls upstream, settles and returns the data."
          params={[
            ["units", "Unit budget for per_token and per_row listings. Ignored for per_call. 1–100000."],
          ]}
          example={`# 1. quote
curl -i "${BASE_URL}/x402/open-exchange-rates"

# 2. pay
curl -i "${BASE_URL}/x402/open-exchange-rates" \\
  -H "X-PAYMENT: <base64 payment payload>"`}
          response={`HTTP/1.1 402 Payment Required

{
  "x402Version": 2,
  "resource": { "url": "${BASE_URL}/x402/open-exchange-rates" },
  "accepts": [{
    "scheme": "exact",
    "network": "${X402_NETWORK}",
    "asset": "0.0.0",
    "amount": "90000",
    "payTo": "0.0.7326076",
    "maxTimeoutSeconds": 300,
    "extra": { "feePayer": "0.0.7162784" }
  }]
}`}
        />

        <Panel className="overflow-hidden">
          <PanelHeader
            title="Building the X-PAYMENT header"
            description="The scheme is exact on Hedera. Sign a transfer for the quoted amount, then base64 the payload."
          />
          <pre className="scroll-thin overflow-x-auto bg-bg-subtle px-4 py-3 font-mono text-[11.5px] leading-relaxed text-ink-2">
{`import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";

const quote = await fetch(paidUrl).then(r => r.json());
const requirements = quote.accepts[0];

const signer = createClientHederaSigner(
  MY_ACCOUNT_ID,
  PrivateKey.fromStringECDSA(MY_PRIVATE_KEY),
  { network: "${X402_NETWORK}" },
);

const signed = await new ExactHederaScheme(signer)
  .createPaymentPayload(2, requirements);

const header = Buffer.from(JSON.stringify({
  x402Version: 2,
  accepted: requirements,
  payload: signed.payload,
})).toString("base64");

const data = await fetch(paidUrl, { headers: { "X-PAYMENT": header } });`}
          </pre>
        </Panel>

        <Panel className="overflow-hidden">
          <PanelHeader
            title="Response headers on a paid call"
            description="Returned alongside the upstream body on a 200."
          />
          <dl className="divide-y divide-line text-[12.5px]">
            {[
              ["X-PAYMENT-RESPONSE", "Base64 settlement receipt from the facilitator."],
              ["X-Tessera-Tx", "Hedera transaction id that paid the seller."],
              ["X-Tessera-Call-Id", "Marketplace call id, for the receipt page and disputes."],
              ["X-Tessera-Units", "Units actually billed."],
              ["X-Tessera-Paid", "Amount settled, in atomic units."],
              ["X-Tessera-Truncated", "Whether the response was trimmed to the paid budget."],
            ].map(([name, description]) => (
              <div key={name} className="flex flex-wrap gap-x-4 gap-y-1 px-4 py-2.5">
                <dt className="w-[190px] shrink-0 font-mono text-[11.5px] text-ink">{name}</dt>
                <dd className="min-w-0 flex-1 text-ink-2">{description}</dd>
              </div>
            ))}
          </dl>
        </Panel>

        <Endpoint
          method="POST"
          path="/api/agent/run"
          summary="Runs one full buyer cycle server-side and returns the decision trace. Useful for testing the marketplace without writing an agent."
          params={[
            ["capability", "String. What to buy."],
            ["units", "Optional integer unit budget."],
          ]}
          example={`curl -X POST "${BASE_URL}/api/agent/run" \\
  -H "content-type: application/json" \\
  -d '{"capability":"exchange rates"}'`}
          response={`{
  "chosen": { "name": "Open Exchange Rates", "quote": "90000" },
  "considered": [ /* every provider, cheapest first */ ],
  "steps": [ /* discover, select, quote, budget, sign, consume */ ],
  "paid": true,
  "transaction": "0.0.7326078@1756290000.000000000"
}`}
        />

        <Endpoint
          method="GET"
          path="/api/health"
          summary="Deployment readiness. Reports database reachability, facilitator support for the configured network, and whether chain credentials are loaded."
          example={`curl "${BASE_URL}/api/health"`}
          response={`{
  "ok": true,
  "checks": { "database": true, "facilitator": true,
              "chain_operator": false, "hcs_receipts": false },
  "network": "${X402_NETWORK}",
  "facilitator_url": "${FACILITATOR_URL}"
}`}
        />

        <Callout tone="neutral" title="Error codes">
          <ul className="mt-1 space-y-1">
            {[
              ["402", "A quote, or a payment that failed verification. Not an error — read accepts and pay."],
              ["400", "Malformed X-PAYMENT header or an invalid unit budget."],
              ["404", "No such service slug."],
              ["409", "Listing is not payable: suspended, unverified seller, seller deposit below minimum, or a replayed payment."],
              ["502 / 504", "Upstream failed or the facilitator was unreachable. No payment was settled."],
            ].map(([code, meaning]) => (
              <li key={code} className="flex gap-3">
                <span className="w-[68px] shrink-0 font-mono text-[12px] text-ink">{code}</span>
                <span className="min-w-0 flex-1">{meaning}</span>
              </li>
            ))}
          </ul>
        </Callout>

        <p className="text-[12.5px] text-ink-3">
          Background on the design is in the{" "}
          <Link href="/docs" className="text-accent underline-offset-4 hover:underline">
            overview
          </Link>
          .
        </p>
      </div>
    </Page>
  );
}

function Endpoint({
  method,
  path,
  summary,
  params,
  example,
  response,
}: {
  method: "GET" | "POST";
  path: string;
  summary: string;
  params?: Array<[string, string]>;
  example: string;
  response?: string;
}) {
  return (
    <Panel className="overflow-hidden">
      <div className="border-b border-line px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={method === "GET" ? "accent" : "ok"}>{method}</Badge>
          <Mono className="text-[13px] text-ink">{path}</Mono>
        </div>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-2">{summary}</p>
      </div>

      {params && params.length > 0 && (
        <dl className="divide-y divide-line border-b border-line text-[12.5px]">
          {params.map(([name, description]) => (
            <div key={name} className="flex flex-wrap gap-x-4 gap-y-1 px-4 py-2.5">
              <dt className="w-[110px] shrink-0 font-mono text-[11.5px] text-ink">{name}</dt>
              <dd className="min-w-0 flex-1 text-ink-2">{description}</dd>
            </div>
          ))}
        </dl>
      )}

      <pre className="scroll-thin overflow-x-auto bg-bg-subtle px-4 py-3 font-mono text-[11.5px] leading-relaxed text-ink-2">
        {example}
      </pre>

      {response && (
        <>
          <p className="border-y border-line bg-bg px-4 py-2 text-[11.5px] font-medium uppercase tracking-[0.05em] text-ink-3">
            Response
          </p>
          <pre className="scroll-thin overflow-x-auto bg-bg-subtle px-4 py-3 font-mono text-[11.5px] leading-relaxed text-ink-2">
            {response}
          </pre>
        </>
      )}
    </Panel>
  );
}
