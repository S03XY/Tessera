import { chromium } from "playwright";
const BASE = process.env.BASE ?? "http://localhost:3000";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(`${BASE}/services/wikipedia-extract`, { waitUntil: "networkidle" });
await page.fill("#units", "5000");
await page.click("text=Request quote");
await page.waitForSelector("text=402 Payment Required", { timeout: 20000 });
await page.waitForTimeout(700);
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: "/tmp/shots/quote-live.png", fullPage: true });

const amount = await page.textContent("dd .tnum");
console.log("quoted amount rendered:", amount?.trim());

// search interaction
await page.goto(`${BASE}/services`, { waitUntil: "networkidle" });
await page.fill('input[type="search"]', "bitcoin price");
await page.waitForTimeout(1400);
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: "/tmp/shots/search-live.png", fullPage: true });
const rows = await page.$$eval("tbody tr td:first-child a", (els) => els.map((e) => e.textContent.trim()));
console.log("search 'bitcoin price' ->", rows);

console.log(errors.length ? "ERRORS: " + errors.join(" | ") : "no browser errors");
await browser.close();
