// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { calculateEncryptedSize } from "@skysend/crypto";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("react-router", () => ({ useNavigate: () => () => {} }));

import { DownloadCard } from "../../src/components/DownloadCard.js";
import type { UploadInfo } from "../../src/lib/api.js";

const SIZE = 512 * 1024 * 1024;

function info(size: number): UploadInfo {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    size,
    fileCount: 1,
    hasPassword: false,
    salt: "c2FsdA",
    encryptedMeta: null,
    nonce: null,
    downloadCount: 0,
    maxDownloads: 1,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    createdAt: new Date().toISOString(),
  };
}

function sizeShown(): string {
  const label = screen.getByText("download.size");
  return label.nextElementSibling?.textContent ?? "";
}

afterEach(cleanup);

describe("DownloadCard", () => {
  it("shows the size of the file, not of its ciphertext on the server", () => {
    render(
      <DownloadCard
        info={info(calculateEncryptedSize(SIZE))}
        metadata={{
          type: "single",
          name: "a.bin",
          size: SIZE,
          mimeType: "application/octet-stream",
        }}
        phase="idle"
        progress={0}
        error={null}
        onDownload={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(sizeShown()).toBe("512.0 MB");
    expect(screen.getAllByText("512.0 MB")).toHaveLength(2);
  });

  it("shows the size from the server as it is when it cannot be a ciphertext", () => {
    render(
      <DownloadCard
        // A nonce and 10 bytes, too short for a record with its tag.
        info={info(12 + 10)}
        metadata={null}
        phase="idle"
        progress={0}
        error={null}
        onDownload={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(sizeShown()).toBe("22 B");
  });

  it("shows every name the sender put into an archive cleaned", () => {
    render(
      <DownloadCard
        info={info(calculateEncryptedSize(SIZE))}
        metadata={{
          type: "archive",
          files: [
            { name: "invoice‮fdp.exe", size: 1 },
            { name: "../../etc/passwd", size: 2 },
          ],
          totalSize: 3,
        }}
        phase="idle"
        progress={0}
        error={null}
        onDownload={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText("invoicefdp.exe")).toBeTruthy();
    expect(screen.getByText("_.._etc_passwd")).toBeTruthy();
    expect(document.body.textContent).not.toContain("‮");
  });
});
