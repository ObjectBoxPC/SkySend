import { expect, scanServer, test } from "./support/fixtures.js";
import { downloadFile, randomFile, randomText, shareNote, shareFiles } from "./support/flows.js";

/** A share link the way a mail security filter hands it back, with its "#" percent-encoded. */
function rewritten(link: string, encoding: "%23" | "%2523") {
  const url = new URL(link);
  return `${url.origin}${url.pathname}${encoding}${url.hash.slice(1)}`;
}

test("a link from before /file/ still opens", async ({ page, openRecipient, guard }) => {
  const file = randomFile(40_000);
  guard.text(file.name);
  guard.content(file.name, file.buffer);
  const link = new URL(await shareFiles(page, [file]));
  guard.secretOf(link.href);

  // Links of v1 pointed at /d/<id>, which forwards to /file/<id> and keeps the key.
  const recipient = await openRecipient();
  await recipient.goto(`${link.origin}${link.pathname.replace("/file/", "/d/")}${link.hash}`);
  await expect(recipient).toHaveURL((url) => url.pathname === link.pathname);
  const received = await downloadFile(recipient);
  expect(received.data.equals(file.buffer)).toBe(true);
});

test("a file link a mail filter rewrote still opens and warns", async ({
  page,
  request,
  openRecipient,
  guard,
}) => {
  const file = randomFile(40_000);
  // The key reaches the server in the path of such a link, which is the whole point of the
  // warning, so only the name and the content are guarded here.
  guard.text(file.name);
  guard.content(file.name, file.buffer);
  const link = await shareFiles(page, [file]);

  const recipient = await openRecipient();
  await recipient.goto(rewritten(link, "%23"));
  await expect(recipient.getByText("Link was modified in transit")).toBeVisible();
  const received = await downloadFile(recipient);
  expect(received.data.equals(file.buffer)).toBe(true);

  const key = { name: "key", bytes: Buffer.from(new URL(link).hash.slice(1)) };
  expect((await scanServer(request, [key])).length, "the key went out in the path").toBeGreaterThan(
    0,
  );
});

test("a note link encoded twice still opens and warns", async ({ page, openRecipient, guard }) => {
  const text = randomText("Rewritten note");
  guard.text(text);
  const link = await shareNote(page, [{ type: "Text", text }]);

  const recipient = await openRecipient();
  await recipient.goto(rewritten(link, "%2523"));
  await expect(recipient.getByText("Link was modified in transit")).toBeVisible();
  await recipient.getByRole("button", { name: "View note" }).click();
  await expect(recipient.getByText(text)).toBeVisible();
});
