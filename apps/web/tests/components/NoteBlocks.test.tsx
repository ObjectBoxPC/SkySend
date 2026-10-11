// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReadBlock } from "@skysend/note-format";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { NoteBlocks } from "../../src/components/NoteBlocks.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";

// Anyone with a link can craft a note, so every block a sender controls is fed the markup an
// attacker would try. tests/e2e covers the same in real browsers, whose parsers differ.

/** Markup that runs code, loads something or reshapes the page when it survives. */
const PAYLOADS = [
  "<script>window.__xss = 1</script>",
  '<img src="x" onerror="window.__xss = 1">',
  '<svg onload="window.__xss = 1"><script>window.__xss = 1</script></svg>',
  '<iframe src="https://attacker.example"></iframe>',
  '<a href="javascript:window.__xss = 1">link</a>',
  '<form action="javascript:window.__xss = 1"><button>send</button></form>',
  '<details open ontoggle="window.__xss = 1">x</details>',
  "<style>body { display: none }</style>",
  '<math><mtext><table><mglyph><style><img src=x onerror="window.__xss = 1">',
  '<object data="https://attacker.example"></object><embed src="https://attacker.example">',
];

/** The same in Markdown's own syntax, which the HTML filter does not see. */
const MARKDOWN_PAYLOADS = [
  "[link](javascript:window.__xss=1)",
  "[link](JaVaScRiPt:window.__xss=1)",
  "[link](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
  "![image](javascript:window.__xss=1)",
  "<javascript:window.__xss=1>",
  "```html\n</code><script>window.__xss = 1</script>\n```",
];

// The app's own icons are SVGs from lucide, which carry its class. Any other SVG came from a note.
const DANGEROUS =
  "script, iframe, object, embed, form, style, link, meta, base, svg:not(.lucide), math";

/** Fails on anything that could run, load or restyle, wherever it hides in the rendered note. */
function expectInert(container: HTMLElement) {
  expect(container.querySelectorAll(DANGEROUS)).toHaveLength(0);
  for (const element of container.querySelectorAll("*")) {
    for (const { name, value } of element.attributes) {
      expect(name.startsWith("on"), `${element.tagName} ${name}`).toBe(false);
      if (["href", "src", "action", "formaction", "xlink:href"].includes(name)) {
        expect(value.trim().toLowerCase(), `${element.tagName} ${name}`).not.toMatch(
          /^(javascript|data|vbscript):/,
        );
      }
    }
  }
  // The task lists of GFM are the only inputs Markdown may leave, as disabled checkboxes.
  for (const input of container.querySelectorAll("input")) {
    expect(input.getAttribute("type")).toBe("checkbox");
  }
}

function renderBlocks(blocks: ReadBlock[]) {
  return render(createElement(TooltipProvider, null, createElement(NoteBlocks, { blocks })))
    .container;
}

afterEach(() => {
  cleanup();
});

describe("NoteBlocks against a crafted note", () => {
  it("shows markup in a plain text block as the text it is", () => {
    const container = renderBlocks(
      PAYLOADS.map((text) => ({ type: "text", format: "plain", text, label: text })),
    );
    expectInert(container);
    for (const payload of PAYLOADS) expect(container.textContent).toContain(payload);
  });

  it("drops what runs or loads from a Markdown block", () => {
    const container = renderBlocks(
      [...PAYLOADS, ...MARKDOWN_PAYLOADS].map((text) => ({
        type: "text",
        format: "markdown",
        text,
      })),
    );
    expectInert(container);
  });

  it("keeps a whole note of Markdown inert, not only one payload at a time", () => {
    const container = renderBlocks([
      { type: "text", format: "markdown", text: [...PAYLOADS, ...MARKDOWN_PAYLOADS].join("\n\n") },
    ]);
    expectInert(container);
  });

  it("highlights code from a note without letting its markup through", () => {
    const blocks: ReadBlock[] = PAYLOADS.flatMap((code) => [
      { type: "code", title: code, language: "html", code },
      { type: "code", title: code, language: "auto", code },
      { type: "code", title: code, language: code.slice(0, 40), code },
    ]);
    const container = renderBlocks(blocks);
    expectInert(container);
  });

  it("shows markup in passwords and SSH keys as text", () => {
    const container = renderBlocks([
      {
        type: "password",
        label: PAYLOADS[1],
        entries: PAYLOADS.map((value) => ({ label: value, value, secret: false })),
      },
      {
        type: "sshkey",
        label: PAYLOADS[2],
        publicKey: PAYLOADS[0]!,
        privateKey: PAYLOADS[3]!,
        passphrase: PAYLOADS[4]!,
      },
    ]);
    expectInert(container);
    expect(container.textContent).toContain(PAYLOADS[0]);
    expect(container.textContent).toContain(PAYLOADS[4]);
  });
});
