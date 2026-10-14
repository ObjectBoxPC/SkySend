import { unzipSync } from "fflate";
import { compatBytes, readSnapshot, snapshotVersions } from "./support/compat.js";
import { expect, test, type Guard } from "./support/fixtures.js";
import { downloadFile, randomFile, unlock, watchTiers } from "./support/flows.js";
import {
  downloadFromInbox,
  inboxRow,
  openInbox,
  openInboxNote,
  sendToRequest,
} from "./support/requests.js";
import type { Locator } from "@playwright/test";

// Every link a released version handed out, opened by the current one after an update: the
// server starts on that release's snapshot and migrates it, see support/compat.ts. Each project
// of playwright.config.ts runs the tests of its own release, picked by the [version] in the
// title.

/** Reveals every hidden password of a note and checks what it holds. */
async function expectNote(scope: Locator, texts: string[], secrets: string[]) {
  for (const text of texts) await expect(scope).toContainText(text);
  const reveal = scope.getByRole("button", { name: "Reveal" });
  for (let index = 0; index < secrets.length; index++) await reveal.first().click();
  for (const secret of secrets) await expect(scope).toContainText(secret);
}

function guardTexts(guard: Guard, ...values: Array<string | undefined>) {
  guard.text(...values.filter((value): value is string => !!value));
}

for (const version of snapshotVersions()) {
  const { shares } = readSnapshot(version);

  test.describe(`[${version}]`, () => {
    for (const share of shares) {
      test(`${share.title} still opens`, async ({
        page,
        baseURL,
        guard,
        openRecipient,
        expectedTier,
      }) => {
        const url = (path: string) => new URL(path, baseURL).href;

        if (share.kind === "file") {
          guard.secretOf(url(share.link));
          guardTexts(guard, share.password, ...share.files.map((file) => file.name));
          for (const file of share.files) guard.content(file.name, compatBytes(file));

          const tiers = watchTiers(page);
          await page.goto(url(share.link));
          if (share.password) await unlock(page, share.password);
          const received = await downloadFile(page);

          if (share.files.length === 1) {
            expect(received.name).toBe(share.files[0]!.name);
            expect(received.data.equals(compatBytes(share.files[0]!))).toBe(true);
          } else {
            const entries = unzipSync(new Uint8Array(received.data));
            for (const file of share.files) {
              expect(Buffer.from(entries[file.name]!).equals(compatBytes(file)), file.name).toBe(
                true,
              );
            }
          }
          expect(tiers).toEqual([expectedTier]);
        }

        if (share.kind === "note") {
          guard.secretOf(url(share.link));
          guardTexts(guard, share.password, ...share.texts, ...share.secrets);

          await page.goto(url(share.link));
          if (share.password) await unlock(page, share.password);
          else await page.getByRole("button", { name: "View note" }).click();
          await expectNote(page.locator("body"), share.texts, share.secrets);
        }

        if (share.kind === "inbox") {
          await guard.requestLinks(url(share.uploadLink), url(share.inboxLink));
          guardTexts(guard, share.password, share.requestTitle, ...share.texts, ...share.secrets);
          for (const file of share.files) {
            guard.text(file.name);
            guard.content(file.name, compatBytes(file));
          }

          const tiers = watchTiers(page);
          await openInbox(page, url(share.inboxLink), share.password);
          if (share.requestTitle) await expect(page.getByText(share.requestTitle)).toBeVisible();
          for (const file of share.files) {
            const received = await downloadFromInbox(inboxRow(page, file.name));
            expect(received.data.equals(compatBytes(file)), file.name).toBe(true);
          }
          if (share.files.length > 0) expect(tiers).toEqual([expectedTier]);
          if (share.texts.length > 0) {
            const note = await openInboxNote(inboxRow(page, "Note"));
            await expectNote(note, share.texts, share.secrets);
          }
        }

        if (share.kind === "open-request") {
          // A request made before the update still takes uploads, which its inbox opens.
          await guard.requestLinks(url(share.uploadLink), url(share.inboxLink));
          const file = randomFile(60_000);
          guard.text(file.name);
          guard.content(file.name, file.buffer);
          await sendToRequest(page, url(share.uploadLink), { files: [file] });

          const inbox = await openRecipient();
          const tiers = watchTiers(inbox);
          await openInbox(inbox, url(share.inboxLink));
          const received = await downloadFromInbox(inboxRow(inbox, file.name));
          expect(received.data.equals(file.buffer)).toBe(true);
          expect(tiers).toEqual([expectedTier]);
        }
      });
    }
  });
}
