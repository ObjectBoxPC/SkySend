import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Snapshots of released versions, in compat/snapshots/<version>: the data directory of a server
 * of that version after compat/seed/<version>.spec.ts shared through its own UI, and links.json
 * with what was shared. compat/seed.mjs makes one, scripts/serve.mjs starts the current server
 * on a copy of it, and compat.spec.ts opens every link.
 */
export const SNAPSHOTS = join(import.meta.dirname, "..", "..", "compat", "snapshots");

/** A file of a snapshot. Its bytes come from its seed, so the snapshot does not keep them. */
export type CompatFile = { name: string; seed: string; size: number };

export type CompatShare =
  | { kind: "file"; title: string; link: string; files: CompatFile[]; password?: string }
  | {
      kind: "note";
      title: string;
      link: string;
      /** What the note shows as soon as it is open. */
      texts: string[];
      /** What a password block of the note shows once revealed. */
      secrets: string[];
      password?: string;
    }
  | {
      kind: "inbox";
      title: string;
      uploadLink: string;
      inboxLink: string;
      password?: string;
      /** The request title the inbox shows. */
      requestTitle?: string;
      files: CompatFile[];
      /** The note sent to the request, as in a note share. Empty without a note. */
      texts: string[];
      secrets: string[];
    }
  | { kind: "open-request"; title: string; uploadLink: string; inboxLink: string };

export type Snapshot = {
  version: string;
  /** The image the snapshot was made with, by digest. */
  image: string;
  createdAt: string;
  shares: CompatShare[];
};

/** The versions with a snapshot, oldest name first. */
export function snapshotVersions() {
  return existsSync(SNAPSHOTS) ? readdirSync(SNAPSHOTS).sort() : [];
}

export function readSnapshot(version: string): Snapshot {
  return JSON.parse(readFileSync(join(SNAPSHOTS, version, "links.json"), "utf8")) as Snapshot;
}

/** The bytes of a snapshot file, the same for the same seed on every run. */
export function compatBytes(file: CompatFile) {
  const blocks: Buffer[] = [];
  let length = 0;
  for (let index = 0; length < file.size; index++) {
    const block = createHash("sha256").update(`${file.seed}:${index}`).digest();
    blocks.push(block);
    length += block.length;
  }
  return Buffer.concat(blocks).subarray(0, file.size);
}
