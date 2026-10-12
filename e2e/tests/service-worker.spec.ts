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
