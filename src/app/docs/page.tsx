import Link from "next/link";
import { Page, PageHeader, Panel, PanelHeader, Mono, Callout } from "@/components/ui";
import { BASE_URL, FACILITATOR_URL, X402_NETWORK, MIN_DEPOSIT_TINYBARS } from "@/lib/config";
import { formatAmount } from "@/lib/money";

export const metadata = { title: "Docs" };

export default function DocsPage() {
  return (
    <Page className="max-w-[860px]">
      <PageHeader
        eyebrow="Documentation"
        title="How Tessera works"
        description="A marketplace where the unit of sale is one HTTP request and the unit of trust is a refundable deposit."
      />

      <div className="space-y-5">
        <Section title="The problem">
          <p>
            Selling an API today means running signup, issuing keys, metering
            usage, invoicing and chasing payment. None of that works for a
            software agent, which has no email address, no credit card and no
            patience for a sales cycle. So agents mostly cannot buy anything.
          </p>
          <p>
            x402 revives the long-dormant{" "}
            <Mono className="text-ink">402 Payment Required</Mono> status code.
            The server answers an unpaid request with a price. The client pays and
            repeats the request. There is no account, because the payment
            <em> is</em> the authentication.
          </p>
        </Section>

        <Section title="Architecture">
          <p>
            Three parties and one rule: the chain is authoritative for money, and
            Postgres is only a read model over it.
          </p>
          <ul className="ml-4 list-disc space-y-1.5 marker:text-ink-4">
            <li>
              <strong className="font-medium text-ink">Sellers</strong> pass World
              ID Selfie Check, post a{" "}
              {formatAmount(MIN_DEPOSIT_TINYBARS)} ℏ refundable deposit, and list
              an endpoint with a price and a metering unit.
            </li>
            <li>
              <strong className="font-medium text-ink">The gateway</strong> is the
              only thing that ever calls a seller endpoint. It quotes, verifies,
              proxies, settles and writes a receipt.
            </li>
            <li>
              <strong className="font-medium text-ink">Agents</strong> search for a
              capability over plain HTTP, pick a provider, and pay per call.
            </li>
          </ul>
          <p>
            Settlement never runs in our own code. Verification and settlement are
            both delegated to the{" "}
            <a
              href="https://blocky402.com"
              target="_blank"
              rel="noreferrer"
              className="text-accent underline-offset-4 hover:underline"
            >
              Blocky402
            </a>{" "}
            facilitator on <Mono className="text-ink">{X402_NETWORK}</Mono>, which
            also covers the gas.
          </p>
        </Section>

        <Section title="Payment flow">
          <ol className="space-y-2.5">
            {[
              [
                "Quote",
                "An unpaid request returns 402 with the amount, asset, pay-to account and the facilitator's fee payer. The price is computed server-side from the listing and the requested unit budget.",
              ],
              [
                "Verify",
                "The agent signs a Hedera transfer and repeats the request with an X-PAYMENT header. The gateway rebuilds the requirements from its own database — never from the client's copy — and asks the facilitator to verify.",
              ],
              [
                "Deliver",
                "Only after verification passes does the gateway call the upstream endpoint. If upstream fails, no settlement is attempted and the buyer keeps their money.",
              ],
              [
                "Settle",
                "With a good response in hand, the facilitator submits the transfer. The seller is paid directly; the marketplace never custodies the funds.",
              ],
              [
                "Receipt",
                "The call is recorded with its transaction hash, and a receipt carrying the request and response digests is queued for the Hedera Consensus Service.",
              ],
            ].map(([title, body], index) => (
              <li key={title} className="flex gap-3">
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-line-2 bg-bg-subtle font-mono text-[11px] text-ink-3">
                  {index + 1}
                </span>
                <p className="text-[13.5px] leading-relaxed text-ink-2">
                  <strong className="font-medium text-ink">{title}. </strong>
                  {body}
                </p>
              </li>
            ))}
          </ol>
        </Section>

        <Section title="Metering">
          <p>
            A flat fee per request is the thing this marketplace deliberately is
            not. Listings price by <Mono className="text-ink">per_call</Mono>,{" "}
            <Mono className="text-ink">per_token</Mono> or{" "}
            <Mono className="text-ink">per_row</Mono>.
          </p>
          <p>
            For metered units the buyer declares a budget with{" "}
            <Mono className="text-ink">?units=N</Mono>. The quote is price × N, and
            the gateway then holds the response to that budget — trimming a JSON
            array to N rows, or text to the token span that was paid for. A buyer
            cannot be billed for more than it agreed to, and a 5000-token answer
            genuinely costs a hundred times a 50-token one.
          </p>
        </Section>

        <Section title="Trust and disputes">
          <p>
            Verification stops one person registering as fifty sellers. The
            deposit gives a dishonest seller something to lose: a buyer can file a
            claim against a delivered call, and an upheld claim refunds the buyer
            out of the seller&apos;s deposit and decrements their reputation.
          </p>
          <p>
            A seller whose deposit falls below the minimum cannot take new calls.
            The gateway, the browse view and the agent-facing discovery API all
            enforce that same rule, so a listing an agent can see is a listing an
            agent can buy.
          </p>
        </Section>

        <Section title="Why the read model is separate">
          <p>
            Endpoint URLs, descriptions, search text and response bodies never
            belonged on a ledger. Payments, deposits, refunds and receipts do.
            Every row in the call log that records a value movement stores the
            transaction hash beside it, so the database can be rebuilt from the
            chain and never becomes the sole record of a payment.
          </p>
        </Section>

        <Callout tone="accent" title="Build against it">
          The discovery and payment endpoints are documented in the{" "}
          <Link href="/docs/agent-api" className="underline underline-offset-4">
            agent API reference
          </Link>
          . Base URL <Mono className="text-ink">{BASE_URL}</Mono>, facilitator{" "}
          <Mono className="text-ink">{FACILITATOR_URL}</Mono>.
        </Callout>
      </div>
    </Page>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Panel className="overflow-hidden">
      <PanelHeader title={title} />
      <div className="space-y-3 px-4 py-4 text-[13.5px] leading-relaxed text-ink-2">
        {children}
      </div>
    </Panel>
  );
}
