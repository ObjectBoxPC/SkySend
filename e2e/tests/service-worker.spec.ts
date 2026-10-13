import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures.js";
import { downloadFile, randomFile, shareFiles, watchTiers } from "./support/flows.js";

// The download Service Worker covers the URLs of tier 1 alone. Registered for the whole origin,
// it saw every request of every page, and Chromium kept the bodies of chunked uploads alive
// until it ran out of blob memory. These check that it controls no page, that a registration
// left by an older release goes away, and that downloads still take tier 1 either way.

const SCOPE = "/__skysend_download__/";

/** The scopes of the registrations of this origin, as paths, once the app registered its own. */
async function registeredScopes(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await navigator.serviceWorker.getRegistrations()).map((r) => new URL(r.scope).pathname),
      ),
    )
    .toContain(SCOPE);
  return page.evaluate(async () =>
    (await navigator.serviceWorker.getRegistrations()).map((r) => new URL(r.scope).pathname).sort(),
  );
}

test("a download without a Service Worker goes to disk through OPFS", async ({
  page,
  browser,
  browserName,
  guard,
}) => {
  // Firefox has OPFS and no file picker, so with Service Workers blocked it takes tier 3, the
  // way Safari does on a Mac. Chromium would open its file picker, and WebKit on Linux has no
  // working OPFS.
  test.skip(browserName !== "firefox", "tier 3 is reachable without a Service Worker in Firefox");
  test.slow();
  // Two whole batches of 8 MiB and a rest, so batching and the last write both run.
  const file = randomFile(20 * 1024 * 1024 + 4321);
  guard.content(file.name, file.buffer);
  const link = await shareFiles(page, [file]);
  guard.secretOf(link);

  const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
  const recipient = await context.newPage();
  const tiers = watchTiers(recipient);
  const opfs: string[] = [];
  recipient.on("console", (message) => {
    if (/Download tier: 3 \(OPFS\)/.test(message.text())) opfs.push(message.text());
  });
  await recipient.goto(link);
  const got = await downloadFile(recipient);
  expect(got.name).toBe(file.name);
  expect(Buffer.compare(got.data, file.buffer)).toBe(0);
  expect(tiers).toEqual(["3"]);
  expect(opfs).toHaveLength(1);
  await context.close();
});

test("a download starts in the Service Worker after the browser stopped it", async ({
  page,
  playwright,
  browserName,
  guard,
}) => {
  // A browser stops a Service Worker after half a minute without work, and a BroadcastChannel
  // message does not start it again, so a recipient who waited on the page fell back to a
  // slower tier. Only Firefox lets a test shorten that half minute, to one second here.
  test.skip(browserName !== "firefox", "only Firefox can shorten the idle timeout");
  const file = randomFile(300_000);
  guard.content(file.name, file.buffer);
  const link = await shareFiles(page, [file]);
  guard.secretOf(link);

  const firefox = await playwright.firefox.launch({
    firefoxUserPrefs: {
      "dom.serviceWorkers.idle_timeout": 1000,
      "dom.serviceWorkers.idle_extended_timeout": 1000,
    },
  });
  const recipient = await (await firefox.newContext({ locale: "en-US" })).newPage();
  const tiers = watchTiers(recipient);
  await recipient.goto(link);
  await recipient.waitForTimeout(4000);
  const got = await downloadFile(recipient);
  expect(Buffer.compare(got.data, file.buffer)).toBe(0);
  expect(tiers).toEqual(["1"]);
  await firefox.close();
});

test("the download Service Worker controls no page", async ({ page }) => {
  await page.goto("/");
  expect(await registeredScopes(page)).toEqual([SCOPE]);
  await page.reload();
  expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
});

test("a registration for the whole origin from an older release is replaced", async ({
  page,
  openRecipient,
  guard,
  expectedTier,
}) => {
  // What a browser keeps from a release before 2026-10.
  await page.goto("/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/download-sw.js");
    await navigator.serviceWorker.ready;
  });

  // The next visit removes it, and the one after is not controlled any more.
  await page.reload();
  await expect.poll(() => registeredScopes(page)).toEqual([SCOPE]);
  await page.reload();
  expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();

  const file = randomFile(300_000);
  guard.content(file.name, file.buffer);
  const link = await shareFiles(page, [file]);
  guard.secretOf(link);

  const recipient = await openRecipient();
  const tiers = watchTiers(recipient);
  await recipient.goto(link);
  const got = await downloadFile(recipient);
  expect(got.name).toBe(file.name);
  expect(Buffer.compare(got.data, file.buffer)).toBe(0);
  expect(tiers).toEqual([expectedTier]);
});
