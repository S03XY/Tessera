import { agentCanPay, agentBuyer, spentToday } from "@/lib/agent";
import { formatAmount } from "@/lib/money";
import { queryOne } from "@/lib/db";
import { hashscanAccount } from "@/lib/config";
import { Badge, KeyValue, Mono, Page, PageHeader, Panel, PanelHeader } from "@/components/ui";
import { AgentConsole } from "./console";

export const dynamic = "force-dynamic";
export const metadata = { title: "Buyer agent" };

export default async function AgentPage() {
  const [agent, spent] = await Promise.all([
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

      <div className="grid items-start gap-5 lg:grid-cols-[1fr_320px]">
        <AgentConsole canPay={agentCanPay} />

        <div className="space-y-5">
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
              Caps are checked against the live 402 quote. A quote above the
              per-call cap is refused before a transfer is ever signed.
            </p>
          </Panel>
        </div>
      </div>
    </Page>
  );
}
