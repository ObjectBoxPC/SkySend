import { writeFileSync } from "node:fs";
import { test } from "@playwright/test";
import { compatBytes, type CompatFile, type CompatShare } from "../../tests/support/compat.js";
import { shareFiles, shareNote } from "../../tests/support/flows.js";
import { createRequest, sendToRequest } from "../../tests/support/requests.js";

// What the snapshot of a release holds, shared through that release's own UI. compat/seed.mjs
// runs it against the published image of a version that has no seed/<version>.spec.ts of its
// own. The helpers follow the current UI, so this fits the release just made. An older release
// with a different UI needs a seed of its own, written against that UI.

const VERSION = process.env.SEED_VERSION ?? "";
if (!VERSION) throw new Error("SEED_VERSION is not set, run this through compat/seed.mjs");

function file(slug: string, size: number, extension = "bin"): CompatFile {
  return { name: `compat-${VERSION}-${slug}.${extension}`, seed: `${VERSION}/${slug}`, size };
}

function upload(compat: CompatFile) {
  return { name: compat.name, mimeType: "application/octet-stream", buffer: compatBytes(compat) };
}

/** The path and fragment of a link, since the origin changes between the seed and a test run. */
function pathOf(link: string) {
  const url = new URL(link);
  return url.pathname + url.hash;
}

test(`seed ${VERSION}`, async ({ page, browser }) => {
  const shares: CompatShare[] = [];
  const sender = async () => (await browser.newContext()).newPage();

  // Over 64 KiB, so the download crosses encryption records.
  const single = file("single", 150_000);
  shares.push({
    kind: "file",
    title: "a file",
    files: [single],
    link: pathOf(await shareFiles(page, [upload(single)])),
  });

  const locked = file("password", 70_000);
  const filePassword = `${VERSION}-file-password`;
  shares.push({
    kind: "file",
    title: "a file with a password",
    files: [locked],
    password: filePassword,
    link: pathOf(await shareFiles(page, [upload(locked)], { password: filePassword })),
  });

  const parts = [file("part-a", 90_000), file("part-b", 20_000, "txt")];
  shares.push({
    kind: "file",
    title: "several files as a zip",
    files: parts,
    link: pathOf(await shareFiles(page, parts.map(upload))),
  });

  const text = `Notes of ${VERSION}`;
  const code = `const release = "${VERSION}";`;
  const secret = `${VERSION}-secret-value`;
  shares.push({
    kind: "note",
    title: "a note of text, password and code",
    texts: [text, code],
    secrets: [secret],
    link: pathOf(
      await shareNote(page, [
        { type: "Text", text },
        { type: "Password", value: secret },
        { type: "Code", code },
      ]),
    ),
  });

  const protectedText = `Protected note of ${VERSION}`;
  const notePassword = `${VERSION}-note-password`;
  shares.push({
    kind: "note",
    title: "a note with a password",
    texts: [protectedText],
    secrets: [],
    password: notePassword,
    link: pathOf(
      await shareNote(page, [{ type: "Text", text: protectedText }], { password: notePassword }),
    ),
  });

  const requestTitle = `Request of ${VERSION}`;
  const field = `Server password of ${VERSION}`;
  const value = `${VERSION}-field-value`;
  const sent = file("request", 80_000);
  const both = await createRequest(page, { asks: "Both", title: requestTitle, field });
  await sendToRequest(await sender(), both.uploadLink, {
    files: [upload(sent)],
    fields: { [field]: value },
  });
  shares.push({
    kind: "inbox",
    title: "files and a note in an inbox",
    uploadLink: pathOf(both.uploadLink),
    inboxLink: pathOf(both.inboxLink),
    requestTitle,
    files: [sent],
    texts: [field],
    secrets: [value],
  });

  const inboxPassword = `${VERSION}-inbox-password`;
  const reply = `Reply to ${VERSION}`;
  const guarded = await createRequest(page, { asks: "Note", password: inboxPassword });
  await sendToRequest(await sender(), guarded.uploadLink, { text: reply });
  shares.push({
    kind: "inbox",
    title: "a note in an inbox with a password",
    uploadLink: pathOf(guarded.uploadLink),
    inboxLink: pathOf(guarded.inboxLink),
    password: inboxPassword,
    files: [],
    texts: [reply],
    secrets: [],
  });

  const open = await createRequest(page, { title: `Open request of ${VERSION}` });
  shares.push({
    kind: "open-request",
    title: "an open request",
    uploadLink: pathOf(open.uploadLink),
    inboxLink: pathOf(open.inboxLink),
  });

  const out = process.env.SEED_OUT;
  if (!out) throw new Error("SEED_OUT is not set");
  writeFileSync(out, JSON.stringify(shares, null, 2));
});
