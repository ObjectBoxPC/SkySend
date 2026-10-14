import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

/**
 * Characters that change how a line reads without showing themselves: the bidi controls of
 * Trojan Source (CVE-2021-42574) and the zero-width ones. A test that needs one writes it as
 * a \u escape, which reads the same to the code and shows to a reviewer.
 */
const HIDDEN = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/u;

describe("text in the repository", () => {
  // New files count too, so a run before the commit already catches one.
  it("holds no bidi controls and no zero-width characters", () => {
    const files = execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      {
        cwd: ROOT,
        encoding: "utf8",
      },
    )
      .split("\0")
      .filter((file) => file && existsSync(join(ROOT, file)));
    const found: string[] = [];
    for (const file of files) {
      const bytes = readFileSync(join(ROOT, file));
      if (bytes.includes(0)) continue;
      bytes
        .toString("utf8")
        .split("\n")
        .forEach((line, index) => {
          if (HIDDEN.test(line)) found.push(`${file}:${index + 1}`);
        });
    }
    expect(found).toEqual([]);
  });
});
