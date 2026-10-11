import { expect, test } from "./support/fixtures.js";
import { randomFile, randomText, shareFiles, shareNote } from "./support/flows.js";
import { createRequest } from "./support/requests.js";

// Runs against the direct setup only, whose server offers an expiry of 5 seconds. Expiries are
// kept in whole seconds, so a little more than that has to pass before the server calls it over.
const LIFETIME = "5s";
const PAST_IT = 7_000;

test("a file link stops working once its time runs out", async ({ page, openRecipient, guard }) => {
  const file = randomFile(20_000);
  guard.text(file.name);
  guard.content(file.name, file.buffer);
  const link = await shareFiles(page, [file], { expiry: LIFETIME });
  guard.secretOf(link);

  await page.waitForTimeout(PAST_IT);
  const recipient = await openRecipient();
  await recipient.goto(link);
  await expect(recipient.getByText("This upload has expired")).toBeVisible();
  await expect(recipient.getByRole("button", { name: "Download", exact: true })).toHaveCount(0);
});

test("a note stops opening once its time runs out", async ({ page, openRecipient, guard }) => {
  const text = randomText("Short-lived note");
  guard.text(text);
  const link = await shareNote(page, [{ type: "Text", text }], { expiry: LIFETIME });
  guard.secretOf(link);

  await page.waitForTimeout(PAST_IT);
  const recipient = await openRecipient();
  await recipient.goto(link);
  await expect(recipient.getByText("This note has expired")).toBeVisible();
  await expect(recipient.getByText(text)).toHaveCount(0);
});

test("a request takes no uploads once its time runs out", async ({
  page,
  openRecipient,
  guard,
}) => {
  const { uploadLink, inboxLink } = await createRequest(page, { expiry: LIFETIME });
  await guard.requestLinks(uploadLink, inboxLink);

  await page.waitForTimeout(PAST_IT);
  const sender = await openRecipient();
  await sender.goto(uploadLink);
  await expect(sender.getByText("This request is closed")).toBeVisible();
  await expect(sender.getByRole("button", { name: "Encrypt and send" })).toHaveCount(0);
});
