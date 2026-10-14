import { expect, test } from "./support/fixtures.js";
import { shareNote } from "./support/flows.js";

// Anyone with a link can craft a note. apps/web/tests/components/NoteBlocks.test.tsx feeds the
// renderers many payloads in jsdom; this sends a few through the real app into each engine,
// since the HTML parsers of Chromium, Firefox and WebKit differ, and markup that a sanitizer
// passes can turn harmful once a browser parses it again (mutation XSS). Every payload sets
// window.__xss if it runs. The CSP would block most of them anyway, so the test checks the
// rendered DOM itself rather than only that nothing ran.

const PAYLOADS = [
  "<script>window.__xss = 1</script>",
  '<img src="x" onerror="window.__xss = 1">',
  '<svg onload="window.__xss = 1"><script>window.__xss = 1</script></svg>',
  '<a href="javascript:window.__xss = 1">link</a>',
  '<details open ontoggle="window.__xss = 1">x</details>',
  '<math><mtext><table><mglyph><style><img src=x onerror="window.__xss = 1">',
  '<noscript><p title="</noscript><img src=x onerror=window.__xss=1>">',
];
const MARKDOWN = [
  ...PAYLOADS,
  "[link](javascript:window.__xss=1)",
  "[link](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
  "```html\n</code><script>window.__xss = 1</script>\n```",
].join("\n\n");

test("a crafted note stays inert in the browser", async ({ page, openRecipient, guard }) => {
  guard.text(PAYLOADS[0]!);
  const link = await shareNote(page, [
    { type: "Text", text: PAYLOADS.join("\n") },
    { type: "Text", text: MARKDOWN, markdown: true },
    { type: "Code", code: PAYLOADS.join("\n"), title: PAYLOADS[1] },
    { type: "Password", value: PAYLOADS[1]! },
  ]);
  guard.secretOf(link);

  const recipient = await openRecipient();
  await recipient.goto(link);
  await recipient.getByRole("button", { name: "View note" }).click();
  // The plain text block shows the markup as text, so the note did render.
  await expect(recipient.locator("main")).toContainText(PAYLOADS[0]!);
  await recipient.getByRole("button", { name: "Reveal" }).click();

  const found = await recipient.locator("main").evaluate((main) => {
    const problems: string[] = [];
    // The app's own icons are SVGs from lucide. Any other SVG came from the note.
    const dangerous =
      "script, iframe, object, embed, style, link, meta, base, svg:not(.lucide), math";
    for (const element of main.querySelectorAll(dangerous)) problems.push(`<${element.tagName}>`);
    for (const element of main.querySelectorAll("*")) {
      for (const { name, value } of element.attributes) {
        if (name.startsWith("on")) problems.push(`${element.tagName} ${name}`);
        if (
          /^(href|src|action|formaction)$/.test(name) &&
          /^\s*(javascript|data|vbscript):/i.test(value)
        ) {
          problems.push(`${element.tagName} ${name}=${value}`);
        }
      }
    }
    return problems;
  });
  expect(found, "nothing from the note runs, loads or restyles").toEqual([]);
  await recipient.waitForTimeout(500);
  expect(await recipient.evaluate(() => (window as { __xss?: number }).__xss)).toBeUndefined();
});
