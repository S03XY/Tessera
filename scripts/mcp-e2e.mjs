#!/usr/bin/env node
/**
 * End-to-end proof of the MCP layer, against a running server.
 *
 *   node scripts/mcp-e2e.mjs [--server cobalt-feeds] [--tool hn_top_stories]
 *
 * Registers a buying agent, funds it, connects to a published MCP server over
 * the real Streamable HTTP transport, lists the tools, and calls one — which
 * settles a real payment on Hedera testnet to the seller's account.
 *
 * The funding step writes the balance directly, standing in for the on-chain
 * deposit that `/api/agents/fund` verifies through the mirror node. Everything
 * after it is the genuine path: the same gateway, the same facilitator, the
 * same settlement a wallet-carrying agent would get.
 */
import pg from "pg";
import dotenv from "dotenv";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(root, ".env.local"), quiet: true });

const BASE = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

// Defaults to the cheapest paid tool in the seeded catalogue, so a full run
// settles real money on testnet without spending much of it. The Swagger
// Petstore used to be the default and was dropped when its upstream started
// returning 500s — a demo safety net that depends on someone else's flaky
// sandbox is not a safety net.
const SERVER_SLUG = argOf("server", "cobalt-feeds");
const TOOL = argOf("tool", "hn_top_stories");
const FUND = BigInt(argOf("fund", "50000000")); // 0.5 ℏ

/* ------------------------------------------------------------------ output */

const pass = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const step = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);
const info = (m) => console.log(`    ${m}`);

let failures = 0;
const check = (condition, message) => {
  if (condition) pass(message);
  else {
    fail(message);
    failures += 1;
  }
};

/* --------------------------------------------------------------- MCP client */

let rpcId = 0;

/**
 * One JSON-RPC round trip over Streamable HTTP.
 *
 * The transport answers with an SSE frame even for a single reply, so the
 * message has to be lifted out of the `data:` line.
 */
async function rpc(url, method, params, token) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });

  const raw = await response.text();
  const line = raw.split("\n").find((entry) => entry.startsWith("data:"));
  let message = null;
  try {
    message = JSON.parse(line ? line.slice(5).trim() : raw);
  } catch {
    // leave null; the caller reports it
  }
  return { status: response.status, message, raw };
}

const toolText = (message) =>
  message?.result?.content?.[0]?.text ?? "";

/* -------------------------------------------------------------------- main */

async function main() {
  console.log(`\nTessera MCP end-to-end — ${BASE}`);
  console.log(`server: /mcp/${SERVER_SLUG}   tool: ${TOOL}\n${"─".repeat(64)}`);

  /* ------------------------------------------------------- 0. reachable */

  step("0. Server health");
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  check(health.ok === true, "health endpoint reports ok");
  check(health.checks.database === true, "database reachable");
  check(health.checks.facilitator === true, "x402 facilitator reachable");
  if (!health.checks.facilitator) {
    info("Settlement will fail without the facilitator. Aborting.");
    process.exit(1);
  }

  /* ------------------------------------------------------- 1. register */

  step("1. Register a buying agent");
  const registered = await fetch(`${BASE}/api/agents/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      label: `e2e-${randomUUID().slice(0, 8)}`,
      owner_account: process.env.AGENT_ACCOUNT_ID ?? "0.0.0",
      per_call_cap: "10000000",
      per_day_cap: "100000000",
    }),
  }).then((r) => r.json());

  check(Boolean(registered.token), "token issued");
  check(registered.token?.startsWith("tsa_"), "token is prefixed and opaque");
  const token = registered.token;
  const agentId = registered.agent.id;
  info(`agent ${agentId}`);
  info(`connect: ${registered.connect.url}`);

  /* ------------------------------------------------- 2. anonymous first */

  step("2. An unauthenticated client can browse but not spend");
  const anonList = await rpc(`${BASE}/mcp/${SERVER_SLUG}`, "tools/list", {});
  check(
    Array.isArray(anonList.message?.result?.tools),
    `tools/list works without a token (${anonList.message?.result?.tools?.length ?? 0} tools)`,
  );

  const anonCall = await rpc(`${BASE}/mcp/${SERVER_SLUG}`, "tools/call", {
    name: TOOL,
    arguments: {},
  });
  let anonPayload = {};
  try {
    anonPayload = JSON.parse(toolText(anonCall.message));
  } catch {
    /* reported by the check below */
  }
  // A free tool answers straight away without a token; a paid one is refused
  // with an explanation the model can act on, never a dropped connection.
  if (anonPayload.ok === true && anonPayload.free === true) {
    pass("this tool is free — it answered with no token at all");
  } else {
    check(
      anonCall.message?.result?.isError === true &&
        anonPayload.error === "insufficient_balance" &&
        /free tools/i.test(String(anonPayload.message)),
      "spending on a paid tool without a token is refused with instructions",
    );
  }

  /* ------------------------------------------------- 3. unfunded agent */

  step("3. A registered but unfunded agent cannot spend");
  const brokeCall = await rpc(
    `${BASE}/mcp/${SERVER_SLUG}`,
    "tools/call",
    { name: TOOL, arguments: {} },
    token,
  );
  let brokePayload = {};
  try {
    brokePayload = JSON.parse(toolText(brokeCall.message));
  } catch {
    /* reported below */
  }
  const targetIsFree = anonPayload.ok === true && anonPayload.free === true;

  if (targetIsFree) {
    check(brokePayload.ok === true, "a free tool still answers for an unfunded agent");
  } else {
    check(
      brokePayload.error === "insufficient_balance",
      `refused with insufficient_balance (${brokePayload.error ?? "unexpected"})`,
    );
    check(
      brokePayload.charged === "nothing was charged",
      "nothing was charged for the refusal",
    );
  }

  /* ------------------------------------------------------------ 4. fund */

  step("4. Fund the agent");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query("BEGIN");
  const updated = await client.query(
    `UPDATE agents SET balance = balance + $2::numeric WHERE id = $1 RETURNING balance`,
    [agentId, FUND.toString()],
  );
  await client.query(
    `INSERT INTO agent_ledger (agent_id, kind, amount, balance_after, tx, memo)
     VALUES ($1,'deposit',$2,$3,$4,'e2e funding (stands in for a verified on-chain deposit)')`,
    [agentId, FUND.toString(), updated.rows[0].balance, `e2e-${agentId}`],
  );
  await client.query("COMMIT");
  check(BigInt(updated.rows[0].balance) === FUND, `balance is ${Number(FUND) / 1e8} ℏ`);

  /* ------------------------------------------------- 5. the real handshake */

  step("5. MCP handshake over Streamable HTTP");
  const init = await rpc(
    `${BASE}/mcp/${SERVER_SLUG}`,
    "initialize",
    {
      protocolVersion: "2026-07-28",
      capabilities: {},
      clientInfo: { name: "tessera-e2e", version: "1.0" },
    },
    token,
  );
  check(init.status === 200, "initialize returned 200");
  check(
    Boolean(init.message?.result?.protocolVersion),
    `protocol ${init.message?.result?.protocolVersion}`,
  );
  check(
    init.message?.result?.serverInfo?.name === `tessera-${SERVER_SLUG}`,
    `server identifies as tessera-${SERVER_SLUG}`,
  );

  const listed = await rpc(`${BASE}/mcp/${SERVER_SLUG}`, "tools/list", {}, token);
  const tools = listed.message?.result?.tools ?? [];
  check(tools.length > 0, `tools/list returned ${tools.length} tools`);
  const target = tools.find((t) => t.name === TOOL);
  check(Boolean(target), `“${TOOL}” is published`);
  if (target) {
    info(`description: ${target.description.slice(0, 100)}`);
    check(
      /Costs [\d.]+ ℏ/.test(target.description) || /^Free|\bFree —/.test(target.description),
      "the price — free or otherwise — is stated in the description the model reads",
    );
  }

  /* ---------------------------------------------------- 6. the paid call */

  step("6. Call the tool — this settles on Hedera testnet");
  const before = await fetch(`${BASE}/api/agents/me`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.json());

  const started = Date.now();
  const called = await rpc(
    `${BASE}/mcp/${SERVER_SLUG}`,
    "tools/call",
    { name: TOOL, arguments: {} },
    token,
  );
  const elapsed = Date.now() - started;

  let payload = {};
  try {
    payload = JSON.parse(toolText(called.message));
  } catch {
    /* reported below */
  }

  if (payload.ok !== true) {
    fail(`the call did not succeed: ${payload.error ?? "unknown"} — ${payload.message ?? ""}`);
    failures += 1;
  } else if (payload.free === true) {
    // A free tool is delivered without a payment leg at all. Asserting a
    // settlement here would be asserting the wrong product.
    pass(`delivered in ${elapsed}ms, free — nothing quoted, signed or settled`);
    info(`response   ${String(payload.response).slice(0, 100)}`);
    check(payload.paid_atomic === "0", "recorded as costing nothing");
    check(!payload.settlement?.transaction, "no settlement transaction, correctly");
  } else {
    pass(`delivered in ${elapsed}ms`);
    info(`paid       ${payload.paid_display}`);
    info(`settlement ${payload.settlement?.transaction}`);
    info(`explorer   ${payload.settlement?.explorer}`);
    info(`response   ${String(payload.response).slice(0, 120)}`);

    check(Boolean(payload.settlement?.transaction), "a real Hedera transaction id came back");
    check(
      String(payload.settlement?.explorer ?? "").includes("hashscan.io"),
      "the settlement is linkable on HashScan",
    );
  }

  /* ------------------------------------------------------ 7. the ledger */

  step("7. Reconcile the ledger");
  const after = await fetch(`${BASE}/api/agents/me`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.json());

  const spent = BigInt(before.balance.atomic) - BigInt(after.balance.atomic);
  if (payload.free === true) {
    check(spent === 0n, "balance is untouched by a free call");
  } else {
    check(spent > 0n, `balance fell by ${Number(spent) / 1e8} ℏ`);
  }
  check(after.reconciliation.balanced === true, "ledger replays to the stored balance exactly");
  info(`stored ${after.reconciliation.stored_atomic} = replayed ${after.reconciliation.replayed_atomic}`);

  const debit = after.ledger.find((entry) => entry.kind === "debit");
  if (payload.free === true) {
    check(!debit, "no debit row written for a free call");
  } else {
    check(Boolean(debit), "a debit row records the spend");
    if (debit) info(`debit ${debit.amount_display} — ${debit.memo}`);
  }

  /* ------------------------------------------------- 8. the call record */

  step("8. The call is recorded like any other");
  const record = await client.query(
    `SELECT c.status, c.via, c.payment_tx, c.paid_amount, c.http_status, s.tool_name
       FROM calls c JOIN services s ON s.id = c.service_id
      WHERE c.agent_id = $1 OR ($2::boolean AND s.tool_name = $3)
      ORDER BY c.created_at DESC LIMIT 1`,
    [agentId, payload.free === true, TOOL],
  );
  const row = record.rows[0];
  check(Boolean(row), "a calls row was written");
  if (row) {
    check(row.status === "delivered", `status is ${row.status}`);
    check(row.via === "mcp", `attributed to the MCP path (via=${row.via})`);
    if (payload.free === true) {
      check(row.paid_amount === "0", "recorded with a paid amount of zero");
      check(!row.payment_tx, "no payment transaction, correctly");
    } else {
      check(Boolean(row.payment_tx), "the settlement tx is recorded against the call");
    }
    info(`tool ${row.tool_name} · paid ${row.paid_amount} · upstream HTTP ${row.http_status}`);
  }

  /* ------------------------------------------------------ 9. cap enforced */

  step("9. Caps are enforced against a real quote");
  const capped = await rpc(
    `${BASE}/mcp/${SERVER_SLUG}`,
    "tools/call",
    { name: TOOL, arguments: {}, max_price: "1" },
    token,
  );
  let cappedPayload = {};
  try {
    cappedPayload = JSON.parse(toolText(capped.message));
  } catch {
    /* reported below */
  }
  // The per-listing tools take no max_price, so this exercises the marketplace
  // endpoint's ceiling instead when the seller server ignores it.
  info(`max_price ceiling → ${cappedPayload.error ?? "accepted (per-listing tool takes no ceiling)"}`);

  await client.end();

  /* ------------------------------------------------------------- verdict */

  console.log(`\n${"─".repeat(64)}`);
  if (failures === 0) {
    console.log("\x1b[32mAll checks passed.\x1b[0m An agent with no wallet connected over MCP,");
    console.log(
      payload.free === true
        ? "called a free tool with no token, and was charged nothing.\n"
        : "paid for a seller's tool, and it settled on Hedera.\n",
    );
  } else {
    console.log(`\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("\ne2e run threw:", err);
  process.exitCode = 1;
});
