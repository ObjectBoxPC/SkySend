// Lists every request of a page load with its timing, to see what holds the load event back.
//   node e2e/bench/pageload.mjs <url> [chromium|firefox|webkit]
import { chromium, firefox, webkit } from "@playwright/test";

const [url, name = "chromium"] = process.argv.slice(2);
const engine = { chromium, firefox, webkit }[name];
const browser = await engine.launch();
const page = await browser.newPage();
const start = Date.now();
const rows = [];
page.on("requestfinished", async (request) => {
  const timing = request.timing();
  rows.push({
    at: Date.now() - start,
    url: request.url().slice(0, 100),
    ms: Math.round(timing.responseEnd),
  });
});
page.on("requestfailed", (request) =>
  rows.push({
    at: Date.now() - start,
    url: request.url().slice(0, 100),
    failed: request.failure()?.errorText,
  }),
);
page.on("console", (message) =>
  rows.push({ at: Date.now() - start, console: message.text().slice(0, 140) }),
);
page.on("domcontentloaded", () => rows.push({ at: Date.now() - start, event: "domcontentloaded" }));
page.on("load", () => rows.push({ at: Date.now() - start, event: "load" }));
await page.goto(url);
await page.waitForTimeout(500);
for (const row of rows.sort((a, b) => a.at - b.at)) console.log(JSON.stringify(row));
await browser.close();
