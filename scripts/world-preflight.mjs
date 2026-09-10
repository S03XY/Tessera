#!/usr/bin/env node
/**
 * Reports whether the World ID setup actually works.
 *
 *   npm run world:preflight
 *
 * The checks themselves live in `src/lib/world-check.ts` and run inside the
 * app, so this is deliberately a thin client of `/api/world/status` rather
 * than a second implementation. The same verdicts appear on the seller
 * onboarding screen, and two copies of "is World configured?" logic would
 * eventually disagree about the answer.
 *
 * Nothing secret crosses this boundary: the endpoint returns verdicts, never
 * the signing key.
 */
import dotenv from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: join(root, ".env.local"), quiet: true });

const BASE = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";

const MARK = { pass: "\x1b[32m✓\x1b[0m", fail: "\x1b[31m✗\x1b[0m", warn: "\x1b[33m!\x1b[0m", skip: "\x1b[90m·\x1b[0m" };

async function main() {
  let report;
  try {
    const response = await fetch(`${BASE}/api/world/status`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    report = await response.json();
  } catch (err) {
    console.error(
      `\nCould not reach ${BASE}/api/world/status — ${err instanceof Error ? err.message : err}` +
        "\nStart the app with `npm run dev` first.\n",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`\nWorld ID preflight — mode: ${report.mode}, credential: ${report.credential}\n`);

  for (const check of report.checks) {
    console.log(`  ${MARK[check.state] ?? "?"} ${check.label}`);
    console.log(`      ${check.detail}`);
  }

  console.log("");
  if (report.ready) {
    console.log("\x1b[32mReady.\x1b[0m A seller can complete a real capture now.\n");
    return;
  }

  console.log(`\x1b[33m${report.todo.length} thing(s) to do:\x1b[0m`);
  report.todo.forEach((item, index) => console.log(`  ${index + 1}. ${item}`));
  console.log("");
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
