import { chromium } from "playwright";
const BASE = process.env.BASE ?? "http://localhost:3000";
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 })).newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
page.on("console", (m) => { if (m.type() === "error" && !/402/.test(m.text())) errs.push(m.text()); });

await page.goto(`${BASE}/agent`, { waitUntil: "networkidle" });
await page.click("text=Run agent");
await page.waitForSelector("text=Run trace", { timeout: 40000 });
await page.waitForTimeout(900);
await page.screenshot({ path: "/tmp/shots/agent.png", fullPage: true });
const steps = await page.$$eval("ol li p.font-medium", (els) => els.map((e) => e.textContent.trim()));
console.log("trace steps:", steps.join(" -> "));
console.log(errs.length ? "ERRORS: " + errs.join(" | ") : "no browser errors");
await browser.close();
