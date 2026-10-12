import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { S3Storage } from "../src/storage/s3.js";

const MIB = 1024 * 1024;
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

/** A stand-in for one part upload: the test decides when it finishes. */
interface PendingPart {
  partNumber: number;
  signal: AbortSignal | undefined;
  finish: () => void;
  fail: (err: Error) => void;
}

/**
 * Replaces S3Client.send with a bucket that behaves like S3 in what these tests need: it refuses
 * a CompleteMultipartUpload whose parts are not in ascending order with InvalidPartOrder, which
 * AWS and SeaweedFS both do, and it lets the test finish each part upload when it wants to.
 */
function fakeBucket() {
  const events: string[] = [];
  const parts = new Map<number, PendingPart>();
  const completed: Array<Array<{ PartNumber?: number }>> = [];
  let completeError: Error | null = null;

  vi.spyOn(S3Client.prototype, "send").mockImplementation((async (
    command: unknown,
    options?: { abortSignal?: AbortSignal },
  ) => {
    if (command instanceof CreateMultipartUploadCommand) return { UploadId: "upload-1" };
    if (command instanceof UploadPartCommand) {
      const partNumber = command.input.PartNumber!;
      return new Promise((resolve, reject) => {
        const settle = (outcome: string) => events.push(`part ${partNumber} ${outcome}`);
        const part: PendingPart = {
          partNumber,
          signal: options?.abortSignal,
          finish: () => {
            settle("stored");
            resolve({ ETag: `"etag-${partNumber}"` });
          },
          fail: (err) => {
            settle("failed");
            reject(err);
          },
        };
        options?.abortSignal?.addEventListener("abort", () =>
          part.fail(Object.assign(new Error("Request aborted"), { name: "AbortError" })),
        );
        parts.set(partNumber, part);
      });
    }
    if (command instanceof CompleteMultipartUploadCommand) {
      const list = command.input.MultipartUpload?.Parts ?? [];
      completed.push(list);
      events.push("complete");
      const numbers = list.map((p) => p.PartNumber!);
      if (numbers.some((n, i) => i > 0 && n <= numbers[i - 1]!)) {
        throw Object.assign(new Error("The list of parts was not in ascending order."), {
          name: "InvalidPartOrder",
        });
      }
      if (completeError) throw completeError;
      return {};
    }
    if (command instanceof AbortMultipartUploadCommand) {
      events.push(`abort ${command.input.UploadId}`);
      return {};
    }
    throw new Error(`Unexpected command ${(command as object).constructor.name}`);
  }) as never);

  return {
    events,
    parts,
    completed,
    failCompleteWith(err: Error) {
      completeError = err;
    },
    /** Waits until the part upload with this number has been sent. */
    async part(partNumber: number) {
      await vi.waitFor(() => expect(parts.has(partNumber)).toBe(true));
      return parts.get(partNumber)!;
    },
  };
}

function storage() {
  return new S3Storage({
    bucket: "bucket",
    region: "us-east-1",
    accessKeyId: "key",
    secretAccessKey: "secret",
    forcePathStyle: true,
    presignedExpiry: 300,
    partSize: 5 * MIB,
    concurrency: 4,
  });
}

function streamOf(size: number) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(size));
      controller.close();
    },
  });
}

describe("S3Storage multipart uploads", () => {
  let bucket: ReturnType<typeof fakeBucket>;

  beforeEach(() => {
    bucket = fakeBucket();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("completes with the parts in ascending order when they finish out of order", async () => {
    const s3 = storage();
    await s3.createEmpty(ID);
    // Three full parts go out at once. The first one finishes last, like a part the SDK had
    // to retry or one that simply took longer.
    await s3.appendChunk(ID, streamOf(15 * MIB + 1024));
    (await bucket.part(3)).finish();
    (await bucket.part(2)).finish();
    (await bucket.part(1)).finish();

    const finalized = s3.finalizeChunkedUpload(ID);
    (await bucket.part(4)).finish();
    await finalized;

    expect(bucket.completed).toHaveLength(1);
    expect(bucket.completed[0]!.map((p) => p.PartNumber)).toEqual([1, 2, 3, 4]);
    expect(bucket.events.some((e) => e.startsWith("abort"))).toBe(false);
  });

  it("aborts the multipart upload when completing it fails", async () => {
    const s3 = storage();
    await s3.createEmpty(ID);
    await s3.appendChunk(ID, streamOf(5 * MIB + 1024));
    (await bucket.part(1)).finish();
    bucket.failCompleteWith(
      Object.assign(new Error("We encountered an internal error."), { name: "InternalError" }),
    );

    const finalized = s3.finalizeChunkedUpload(ID);
    (await bucket.part(2)).finish();
    await expect(finalized).rejects.toThrow("internal error");

    expect(bucket.events).toContain("abort upload-1");
    // What the routes do after a failed finalize. The upload is gone by then.
    await expect(s3.abortChunkedUpload(ID)).resolves.toBeUndefined();
    expect(bucket.events.filter((e) => e.startsWith("abort"))).toHaveLength(1);
  });

  it("aborts the multipart upload when a part upload failed", async () => {
    const s3 = storage();
    await s3.createEmpty(ID);
    await s3.appendChunk(ID, streamOf(10 * MIB + 1024));
    (await bucket.part(1)).finish();
    (await bucket.part(2)).fail(new Error("socket hang up"));
    await vi.waitFor(() => expect(bucket.events).toContain("part 2 failed"));

    await expect(s3.finalizeChunkedUpload(ID)).rejects.toThrow("socket hang up");
    expect(bucket.events).toContain("abort upload-1");
    expect(bucket.completed).toHaveLength(0);
  });

  it("cancels the parts in flight and aborts only once none is left", async () => {
    const s3 = storage();
    await s3.createEmpty(ID);
    await s3.appendChunk(ID, streamOf(10 * MIB));
    const first = await bucket.part(1);
    const second = await bucket.part(2);

    await s3.abortChunkedUpload(ID);

    expect(first.signal?.aborted).toBe(true);
    expect(second.signal?.aborted).toBe(true);
    // A part still uploading while the abort runs can be stored after it and stay billed.
    expect(bucket.events).toEqual(["part 1 failed", "part 2 failed", "abort upload-1"]);
  });
});
