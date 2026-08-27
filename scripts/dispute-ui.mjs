import { chromium } from "playwright";
const BASE = process.env.BASE ?? "http://localhost:3000";
const id = process.argv[2];
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 })).newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));

await page.goto(`${BASE}/activity/${id}`, { waitUntil: "networkidle" });
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: "/tmp/shots/call-before.png", fullPage: true });

await page.selectOption("#reason", "no_response");
await page.fill("#evidence", "Paid 0.0009 h and the body came back empty.");
await page.click("text=File claim");
await page.waitForSelector("text=Refunded", { timeout: 20000 });
await page.waitForTimeout(800);
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: "/tmp/shots/call-refunded.png", fullPage: true });
console.log("refund banner:", (await page.textContent(".text-ok, [class*='ok']"))?.trim().slice(0,80));
console.log(errs.length ? "ERRORS: " + errs.join(" | ") : "no browser errors");
await browser.close();
