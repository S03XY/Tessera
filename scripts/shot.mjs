import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://localhost:3000";
const OUT = "/tmp/shots";
const pages = JSON.parse(process.argv[2]);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(`[console] ${m.text()}`); });
page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));

for (const [name, path] of pages) {
  const res = await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 45000 });
  await page.waitForTimeout(500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  console.log(`${String(res.status()).padEnd(4)} ${path.padEnd(38)} -> ${name}.png`);
}

if (errors.length) { console.log("\nBROWSER ERRORS:"); errors.forEach((e) => console.log("  " + e)); }
else console.log("\nno console/page errors");

await browser.close();
