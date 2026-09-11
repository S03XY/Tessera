import { agentCanPay, agentBuyer, spentToday } from "@/lib/agent";
import { formatAmount } from "@/lib/money";
import { queryOne } from "@/lib/db";
import { hashscanAccount } from "@/lib/config";
import { bucketFor, quotaStatus } from "@/lib/quota";
import { Badge, KeyValue, Mono, Page, PageHeader, Panel, PanelHeader } from "@/components/ui";
import { AgentConsole } from "./console";

export const dynamic = "force-dynamic";
export const metadata = { title: "Buyer agent" };

export default async function AgentPage() {
  const [agent, spent] = await Promise.all([
    queryOne<{
      id: string;
      label: string;
      owner_account: string;
      agent_account: string;
      per_call_cap: string | null;
      per_day_cap: string | null;
      revoked_at: string | null;
    }>(
      `SELECT id, label, owner_account, agent_account, per_call_cap, per_day_cap,
              revoked_at
         FROM agents ORDER BY created_at LIMIT 1`,
    ),
    spentToday(),
  ]);

  // The free-tool allowance this agent draws from. Keyed to the token it
  // presents, which is a better key than the address it happens to call from.
  const freeBucket = bucketFor(agent, "");
  const free = await quotaStatus(freeBucket);

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
             * The allowance is the one control on this screen that money does
             * not lift, so a registered agent gets the lit edge: funding buys
             * paid tools, not a bigger free bucket.
             */
            className={`h-fit overflow-hidden ${
              free.kind === "agent"
                ? "border-line-3 shadow-[inset_0_1px_0_var(--edge-hi-strong),0_0_0_1px_rgba(255,255,255,0.06)]"
                : ""
            }`}
          >
            <PanelHeader
              title="Free-tool allowance"
              description="What this agent may call for nothing today."
              actions={
                <Badge tone={free.kind === "agent" ? "ok" : "warn"} dot>
                  {free.label}
                </Badge>
              }
            />
            <div className="border-b border-line px-4 py-4">
              <p className="tnum font-mono text-[26px] font-medium text-ink">
                {Math.max(free.limit - free.used, 0).toLocaleString()}
                <span className="ml-1.5 text-[14px] text-ink-3">
                  of {free.limit.toLocaleString()} left today
                </span>
              </p>
              {/* Remaining allowance as a metal bar seated in a milled slot. */}
              <div className="well mt-3 h-2 w-full overflow-hidden rounded-none">
                <div
                  className="machined-bright h-full rounded-none border-0"
                  style={{
                    width: `${
                      free.limit > 0
                        ? Math.max(
                            2,
                            Math.round(
                              ((free.limit - Math.min(free.used, free.limit)) / free.limit) * 100,
                            ),
                          )
                        : 0
                    }%`,
                  }}
                />
              </div>
              <p className="mt-3 text-[12px] leading-relaxed text-ink-3">
                {free.kind === "agent"
                  ? "Keyed to this agent's token, and reset at midnight UTC. Funding the agent does not raise it — money buys paid tools, not free ones."
                  : "Unauthenticated callers share a smaller allowance keyed to a hash of their address. Register an agent at POST /api/agents/register to draw the larger one."}
              </p>
            </div>
            <KeyValue
              items={[
                { label: "Tier", value: <Mono>{free.kind}</Mono> },
                { label: "Used today", value: <Mono>{free.used.toLocaleString()}</Mono> },
              ]}
            />
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
              transfer is signed, so a refusal never moves money. They bound
              spending; the allowance above bounds what can be taken for free.
            </p>
          </Panel>
        </div>
      </div>
    </Page>
  );
}
