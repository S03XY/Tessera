#!/usr/bin/env node
/**
 * A Gemini agent that shops in the marketplace and pays for what it uses.
 *
 *   npm run agent:gemini -- "what is the btc spot price right now?"
 *   npm run agent:gemini -- --free "what is the weather in berlin?"
 *   npm run agent:gemini -- --server northwind-apis "convert 100 usd to eur"
 *
 * The point of this script is that none of it is about Tessera. It is the
 * ordinary Gemini function-calling loop pointed at an MCP endpoint: list the
 * tools, hand them to the model, run whatever it picks, feed the result back.
 * Nothing here knows what x402 is, holds a Hedera key, or has a wallet. The
 * agent presents a bearer token and the marketplace settles on its behalf —
 * which is the whole argument, demonstrated by a model from a different vendor
 * than the one that wrote the protocol.
 *
 * Tool calls are executed by hand rather than through the SDK's `mcpToTool`
 * automatic mode. Automatic calling would hide exactly the part worth showing:
 * which tool the model chose, what it cost, and the transaction it settled as.
 */
import dotenv from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(root, ".env.local"), quiet: true });

const BASE = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
const API_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";
const MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

/* ------------------------------------------------------------------ args */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const optOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

/**
 * With no token the agent can still browse and call free tools — which is a
 * demonstration in itself, so it is one flag rather than a separate script.
 */
const TOKEN = flag("free") ? "" : optOf("token", process.env.DEMO_AGENT_TOKEN ?? "tg_demo_agent_key");
const SERVER = optOf("server", null);
const MCP_URL = SERVER ? `${BASE}/mcp/${SERVER}` : `${BASE}/mcp`;
const MAX_TURNS = Number(optOf("max-turns", "8"));
const GOAL = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.match(/^--(token|server|max-turns)$/)).join(" ");

const dim = (s) => `\x1b[90m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

/* ------------------------------------------------------------- MCP client */

let rpcId = 0;

/**
 * One MCP call over Streamable HTTP.
 *
 * The endpoint answers as an SSE frame, so the JSON is on a `data:` line
 * rather than being the whole body.
 */
async function rpc(method, params) {
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });

  const raw = await response.text();
  const line = raw.split("\n").find((entry) => entry.startsWith("data:"));
  try {
    return JSON.parse(line ? line.slice(5).trim() : raw);
  } catch {
    throw new Error(`MCP returned non-JSON (HTTP ${response.status}): ${raw.slice(0, 200)}`);
  }
}

/**
 * Rewrites an MCP JSON Schema into what Gemini's function declarations accept.
 *
 * Gemini rejects `additionalProperties` and `$schema`, and refuses an object
 * with no declared properties — which `get_balance` and `get_spend_authority`
 * both are. Passing those through unchanged is a 400 from the API, so the
 * no-argument case gets a single ignored property rather than an empty object.
 */
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== "object") return undefined;

  const clean = (node) => {
    if (Array.isArray(node)) return node.map(clean);
    if (!node || typeof node !== "object") return node;
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "additionalProperties" || key === "$schema" || key === "default") continue;
      out[key] = clean(value);
    }
    return out;
  };

  const cleaned = clean(schema);
  if (cleaned.type === "object" && Object.keys(cleaned.properties ?? {}).length === 0) {
    return {
      type: "object",
      properties: { _: { type: "string", description: "Unused. Pass an empty string." } },
    };
  }
  return cleaned;
}

/** Pulls the readable text out of an MCP tool result. */
function resultText(message) {
  const content = message?.result?.content;
  if (!Array.isArray(content)) return JSON.stringify(message?.result ?? message?.error ?? {});
  return content.map((part) => part.text ?? "").join("\n").trim();
}

/**
 * Surfaces what a call actually cost.
 *
 * The marketplace answers with a JSON envelope carrying the price, the Hedera
 * transaction and the remaining balance. Printing it is the difference between
 * "the agent answered" and "the agent bought the answer".
 */
function reportSpend(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return; // a plain-text tool result has nothing to report
  }
  if (!payload || typeof payload !== "object") return;

  if (payload.ok === false || payload.error) {
    console.log(red(`      refused   ${payload.error ?? "failed"}: ${payload.message ?? ""}`));
    if (payload.charged) console.log(dim(`      charged   ${payload.charged}`));
    return;
  }

  if (payload.free === true) {
    console.log(dim("      cost      free — no token, no balance, no wallet"));
  } else if (payload.paid_display) {
    console.log(`      ${green("paid")}      ${payload.paid_display}`);
  }

  const settlement = payload.settlement ?? {};
  if (settlement.transaction) console.log(dim(`      settled   ${settlement.transaction}`));
  if (settlement.explorer) console.log(dim(`      explorer  ${settlement.explorer}`));
  if (payload.balance_atomic) {
    console.log(dim(`      balance   ${(Number(payload.balance_atomic) / 1e8).toFixed(8)} \u210f left`));
  }
}

/* ------------------------------------------------------------------- main */

async function main() {
  if (!API_KEY) {
    console.error(
      "\nNo Gemini API key.\n" +
        "Get one free at https://aistudio.google.com/apikey, then add to .env.local:\n\n" +
        "  GEMINI_API_KEY=...\n",
    );
    process.exitCode = 1;
    return;
  }
  if (!GOAL) {
    console.error('\nGive the agent something to do:\n\n  npm run agent:gemini -- "what is the btc spot price?"\n');
    process.exitCode = 1;
    return;
  }

  console.log(`\n${bold("Gemini agent")} → ${MCP_URL}`);
  console.log(dim(`model ${MODEL} · ${TOKEN ? "with an agent token" : "no token (free tools only)"}`));
  console.log(dim("─".repeat(70)));
  console.log(`${bold("goal")}  ${GOAL}\n`);

  /* --- 1. discover what the marketplace offers, the way any client would --- */

  const listed = await rpc("tools/list", {});
  const tools = listed?.result?.tools ?? [];
  if (tools.length === 0) throw new Error(`No tools at ${MCP_URL}. Is the server running?`);

  console.log(dim(`connected · ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}\n`));

  const functionDeclarations = tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? tool.title ?? tool.name,
    parameters: toGeminiSchema(tool.inputSchema),
  }));

  /* --- 2. hand them to Gemini and let it decide --- */

  const ai = new GoogleGenAI({ apiKey: API_KEY });
  const contents = [{ role: "user", parts: [{ text: GOAL }] }];

  const systemInstruction =
    "You are an autonomous buying agent with a prepaid balance on an API marketplace. " +
    "Use the tools to find a service that answers the user's question, check what it costs, " +
    "then call it and answer from the data you get back. Prefer the cheapest service that " +
    "can actually answer; some are free. Never invent an answer you did not obtain from a " +
    "tool. When you have the data, reply in one or two plain sentences.";

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents,
      config: { systemInstruction, tools: [{ functionDeclarations }] },
    });

    const parts = response.candidates?.[0]?.content?.parts ?? [];
    const calls = parts.filter((part) => part.functionCall).map((part) => part.functionCall);

    if (calls.length === 0) {
      const answer = parts.map((part) => part.text ?? "").join("").trim();
      console.log(dim("─".repeat(70)));
      console.log(`${bold("answer")}  ${answer || "(the model returned nothing)"}\n`);
      return;
    }

    contents.push({ role: "model", parts });

    const responses = [];
    for (const call of calls) {
      const args = { ...(call.args ?? {}) };
      delete args._; // the placeholder added for no-argument tools

      console.log(`${bold(`${turn}.`)} ${call.name}${Object.keys(args).length ? ` ${dim(JSON.stringify(args))}` : ""}`);

      const message = await rpc("tools/call", { name: call.name, arguments: args });
      const text = resultText(message);
      reportSpend(text);
      console.log(dim(`      → ${text.replace(/\s+/g, " ").slice(0, 160)}`));
      console.log();

      responses.push({
        functionResponse: { name: call.name, response: { result: text.slice(0, 8000) } },
      });
    }

    contents.push({ role: "user", parts: responses });
  }

  console.log(red(`\nStopped after ${MAX_TURNS} turns without a final answer.\n`));
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`\n${red("failed")} ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
