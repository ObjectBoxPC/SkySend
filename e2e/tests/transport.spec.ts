import { expect, test } from "./support/fixtures.js";
import { randomFile, shareFiles } from "./support/flows.js";

// The other tests pass over any protocol and either upload transport, so these make sure each
// setup runs what it promises: HTTP/2 behind Caddy, and the transport the server offers.

test("the app arrives over the protocol of the setup", async ({ page, protocol }) => {
  await page.goto("/");
  const nextHop = await page.evaluate(
    () =>
      (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming)
        .nextHopProtocol,
  );
  expect(nextHop).toBe(protocol);
});

test("an upload takes the transport of the setup", async ({
  page,
  guard,
  uploadTransport,
  uploadTransports,
}) => {
  const file = randomFile(100_000);
  guard.text(file.name);
  guard.secretOf(await shareFiles(page, [file]));
  expect(uploadTransports).toEqual([uploadTransport]);
});
