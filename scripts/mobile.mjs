import { chromium } from "playwright";
const BASE = process.env.BASE ?? "http://localhost:3000";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 780 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const routes = [["m-home","/"],["m-services","/services"],["m-detail","/services/wikipedia-extract"],["m-agent","/agent"],["m-onboarding","/onboarding"]];
let bad = 0;
for (const [name, path] of routes) {
  await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 40000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const ok = overflow <= 1;
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "OVER"} ${path.padEnd(32)} h-overflow=${overflow}px`);
  await page.screenshot({ path: `/tmp/shots/${name}.png`, fullPage: true });
}
console.log(bad ? `${bad} route(s) overflow horizontally` : "no horizontal overflow at 375px");
await browser.close();
