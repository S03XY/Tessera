import { agentCanPay, agentBuyer, spentToday } from "@/lib/agent";
import { formatAmount } from "@/lib/money";
import { queryOne } from "@/lib/db";
import { hashscanAccount } from "@/lib/config";
import { Badge, KeyValue, Mono, Page, PageHeader, Panel, PanelHeader } from "@/components/ui";
import { readMandate, formatMandateUnits, mandateConfigured } from "@/lib/mandate";
import { AgentConsole } from "./console";

export const dynamic = "force-dynamic";
export const metadata = { title: "Buyer agent" };

export default async function AgentPage() {
  const [agent, spent, mandate] = await Promise.all([
    queryOne<{
      label: string;
      owner_account: string;
      agent_account: string;
      per_call_cap: string | null;
      per_day_cap: string | null;
      revoked_at: string | null;
    }>(
      `SELECT label, owner_account, agent_account, per_call_cap, per_day_cap, revoked_at
         FROM agents ORDER BY created_at LIMIT 1`,
    ),
    spentToday(),
    readMandate(),
  ]);

  const dayCap = agent?.per_day_cap ? BigInt(agent.per_day_cap) : null;
  const remaining = dayCap ? (dayCap > spent ? dayCap - spent : 0n) : null;

  return (
    <Page>
      <PageHeader
        eyebrow="Autonomous buyer"
        title="Buyer agent"
        description="A serverless agent that finds a capability, ranks providers by price, checks its spending cap, pays over x402 and consumes the response — with no human in the loop."
        actions={
          <Badge tone={agentCanPay ? "ok" : "warn"} dot>
            {agentCanPay ? "Buyer key loaded" : "Read-only"}
          </Badge>
        }
      />

      <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[1fr_320px] [&>*]:min-w-0">
        <AgentConsole canPay={agentCanPay} />

        <div className="space-y-5">
          <Panel
            /*
             * An armed mandate is the one part on this screen with authority
             * to move money, so it gets a lit edge — the colourless way to
             * say "this is energised" without a coloured ring.
             */
            className={`h-fit overflow-hidden ${
              mandate && !mandate.revoked
                ? "border-line-3 shadow-[inset_0_1px_0_var(--edge-hi-strong),0_0_0_1px_rgba(255,255,255,0.06)]"
                : ""
            }`}
          >
            <PanelHeader
              title="On-chain mandate"
              description="1inch Aqua SwapVM. Outranks every control below."
              actions={
                mandate ? (
                  <Badge tone={mandate.revoked ? "bad" : "ok"} dot>
                    {mandate.revoked ? "revoked" : "live"}
                  </Badge>
                ) : (
                  <Badge tone="warn" dot>
                    {mandateConfigured ? "unreachable" : "not set"}
                  </Badge>
                )
              }
            />
            {mandate ? (
              <>
                <div className="border-b border-line px-4 py-4">
                  <p className="tnum font-mono text-[26px] font-medium text-ink">
                    {formatMandateUnits(mandate.remaining)}
                    <span className="ml-1.5 text-[14px] text-ink-3">
                      of {formatMandateUnits(mandate.dailyCap)} left today
                    </span>
                  </p>
                  {/* Remaining allowance as a metal bar seated in a milled slot. */}
                  <div className="well mt-3 h-2 w-full overflow-hidden rounded-none">
                    <div
                      className="machined-bright h-full rounded-none border-0"
                      style={{
                        width: `${
                          mandate.dailyCap > 0n
                            ? Math.max(
                                2,
                                Number((mandate.remaining * 100n) / mandate.dailyCap),
                              )
                            : 0
                        }%`,
                      }}
                    />
                  </div>
                  <p className="mt-3 text-[12px] leading-relaxed text-ink-3">
                    The funds stay in the owner&apos;s wallet. The agent draws against
                    this mandate one call at a time, and the owner can revoke it in a
                    single transaction — after which this agent stops spending here
                    too.
                  </p>
                </div>
                <KeyValue
                  items={[
                    { label: "Chain", value: <Mono>{mandate.chain}</Mono> },
                    { label: "Mandate", value: <Mono>#{mandate.mandateId}</Mono> },
                    {
                      label: "Router",
                      value: (
                        <a
                          href={mandate.explorerUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-[12px] text-accent underline-offset-4 hover:underline"
                        >
                          {mandate.router.slice(0, 10)}…{mandate.router.slice(-6)}
                        </a>
                      ),
                    },
                  ]}
                />
              </>
            ) : (
              <p className="px-4 py-4 text-[12.5px] leading-relaxed text-ink-3">
                {mandateConfigured
                  ? "A mandate is configured but could not be read. The agent refuses to spend rather than assume permission it cannot verify."
                  : "No mandate configured, so the caps below are enforced by this application alone. Point MANDATE_ROUTER at a deployed Aqua router to move that guarantee on chain."}
              </p>
            )}
          </Panel>

          <Panel className="h-fit overflow-hidden">
            <PanelHeader
              title="Agent identity"
              description="Registered in the marketplace agent table."
            />
            <KeyValue
              items={[
                { label: "Label", value: agent?.label ?? "—" },
                {
                  label: "Agent account",
                  value: agentCanPay ? (
                    <a
                      href={hashscanAccount(agentBuyer.accountId)}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-[12px] text-accent underline-offset-4 hover:underline"
                    >
                      {agentBuyer.accountId}
                    </a>
                  ) : (
                    <Mono>{agent?.agent_account ?? "—"}</Mono>
                  ),
                },
                { label: "Owner", value: <Mono>{agent?.owner_account ?? "—"}</Mono> },
                {
                  label: "Status",
                  value: agent?.revoked_at ? (
                    <Badge tone="bad">revoked</Badge>
                  ) : (
                    <Badge tone="ok">active</Badge>
                  ),
                },
              ]}
            />
          </Panel>

          <Panel className="h-fit overflow-hidden">
            <PanelHeader
              title="Spending controls"
              description="Enforced before any transfer is signed."
            />
            <KeyValue
              items={[
                {
                  label: "Per-call cap",
                  value: (
                    <Mono>
                      {agent?.per_call_cap ? `${formatAmount(agent.per_call_cap)} ℏ` : "—"}
                    </Mono>
                  ),
                },
                {
                  label: "Per-day cap",
                  value: <Mono>{dayCap ? `${formatAmount(dayCap)} ℏ` : "—"}</Mono>,
                },
                {
                  label: "Spent (24h)",
                  value: <Mono>{formatAmount(spent)} ℏ</Mono>,
                },
                {
                  label: "Remaining today",
                  value: (
                    <Mono className={remaining === 0n ? "text-bad" : undefined}>
                      {remaining === null ? "—" : `${formatAmount(remaining)} ℏ`}
                    </Mono>
                  ),
                },
              ]}
            />
            <p className="border-t border-line px-4 py-3 text-[12px] leading-relaxed text-ink-3">
              Caps are checked against the live 402 quote and refused before a
              transfer is signed. These hold because this code behaves; the mandate
              above holds whether it does or not.
            </p>
          </Panel>
        </div>
      </div>
    </Page>
  );
}
