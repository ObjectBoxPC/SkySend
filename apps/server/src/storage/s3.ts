import {
  S3Client,
  HeadBucketCommand,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "node:stream";
import type { createReadStream } from "node:fs";
import { describeError } from "../lib/log-error.js";
import type { StorageBackend } from "./types.js";

const MIB = 1024 * 1024;

/** Minimum part size for S3 multipart uploads (5 MB - S3 requirement for non-final parts). */
const MIN_PART_SIZE = 5 * MIB;

/** Most parts S3 accepts in one multipart upload. */
const MAX_PARTS = 10_000;

export interface S3StorageConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  presignedExpiry: number;
  partSize: number;
  concurrency: number;
  /** Most bytes all uploads together hold in parts on their way to the bucket. */
  memoryLimit?: number;
}

/**
 * The bytes of all parts on their way to the bucket, over every upload, held to a limit.
 * A part waits for room in the order it asked, so every upload gets its turn. A part larger
 * than the whole limit still goes when nothing else is on its way, so a small limit slows
 * uploads down but never stops them.
 */
class PartMemory {
  private used = 0;
  private readonly waiting: Array<{ bytes: number; go: () => void }> = [];

  constructor(private readonly limit: number) {}

  private fits(bytes: number): boolean {
    return this.used === 0 || this.used + bytes <= this.limit;
  }

  take(bytes: number): Promise<void> {
    if (this.waiting.length === 0 && this.fits(bytes)) {
      this.used += bytes;
      return Promise.resolve();
    }
    return new Promise((go) => this.waiting.push({ bytes, go }));
  }

  give(bytes: number): void {
    this.used -= bytes;
    while (this.waiting.length > 0 && this.fits(this.waiting[0]!.bytes)) {
      const next = this.waiting.shift()!;
      this.used += next.bytes;
      next.go();
    }
  }
}

interface MultipartSession {
  /** Size of every part but the last, fixed for the whole upload. */
  partSize: number;
  /**
   * The multipart upload, null until it is started: for an upload that fits into one part it
   * never is, and finalize stores it with a single PutObject.
   */
  uploadId: Promise<string> | null;
  /** In the order the parts finished, which with parallel uploads is not their own order. */
  parts: Array<{ PartNumber: number; ETag: string }>;
  /** Cancels the part uploads still running when the upload is aborted. */
  abort: AbortController;
  /** Buffered chunks waiting to reach partSize. Avoids repeated full-buffer copies. */
  bufferChunks: Uint8Array[];
  bufferSize: number;
  partNumber: number;
  /** Active S3 part upload promises. Used for concurrency limiting + backpressure. */
  activeUploads: Set<Promise<void>>;
  /** First error from a background upload, re-thrown on next appendChunk or finalize. */
  uploadError: Error | null;
}

/**
 * S3-compatible object storage backend.
 *
 * Works with AWS S3, Cloudflare R2, Hetzner Object Storage,
 * MinIO, Wasabi, Backblaze B2, DigitalOcean Spaces, and any
 * S3-compatible provider.
 *
 * Files are stored as: <bucket>/<id>.bin
 */
export class S3Storage implements StorageBackend {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly presignedExpiry: number;
  private readonly partSize: number;
  private readonly concurrency: number;
  private readonly partMemory: PartMemory;
  private readonly multipartSessions = new Map<string, MultipartSession>();

  constructor(config: S3StorageConfig) {
    this.bucket = config.bucket;
    this.presignedExpiry = config.presignedExpiry;
    this.partSize = Math.max(config.partSize, MIN_PART_SIZE);
    this.concurrency = config.concurrency;
    this.partMemory = new PartMemory(config.memoryLimit ?? Infinity);

    this.client = new S3Client({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      ...(config.endpoint && { endpoint: config.endpoint }),
      forcePathStyle: config.forcePathStyle,
      // AWS SDK v3 >=3.679 enables checksum calculation by default ("WHEN_SUPPORTED").
      // S3-compatible providers (R2, MinIO, etc.) may return checksum fields containing
      // characters like &#xD; (carriage return) in XML responses that the SDK XML
      // parser cannot handle, causing "[EntityReplacer] Invalid character '#'" errors.
      // Setting both to WHEN_REQUIRED disables this behavior for non-AWS providers.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  private key(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) {
      throw new Error("Invalid upload ID format");
    }
    return `${id}.bin`;
  }

  /** Verify bucket exists and test read/write connectivity. Call once at startup. */
  async init(): Promise<void> {
    // 1. Verify bucket exists
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));

    // 2. Write a small test object to verify write permissions
    const testKey = ".skysend-connectivity-test";
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: testKey,
        Body: Buffer.from("ok"),
      }),
    );

    // 3. Delete the test object to verify delete permissions
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: testKey,
      }),
    );

    console.log(`[s3] Connected to bucket: ${this.bucket} (read/write OK)`);
  }

  /**
   * Save a ReadableStream to S3 using managed multipart upload.
   * Streams data directly to S3 without buffering on disk.
   */
  async save(id: string, stream: ReadableStream<Uint8Array>): Promise<number> {
    const nodeStream = Readable.fromWeb(stream as ReadableStream);

    let bytesWritten = 0;
    nodeStream.on("data", (chunk: Buffer) => {
      bytesWritten += chunk.length;
    });

    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: this.key(id),
        Body: nodeStream,
      },
      // Use configured part size and parallelism for better throughput
      partSize: this.partSize,
      queueSize: this.concurrency,
    });

    await upload.done();
    return bytesWritten;
  }

  /**
   * Opens an upload session. `size`, the declared size of the upload, sets the part size and
   * the way the upload is stored: one that fits into a single part is stored with one
   * PutObject at finalize, which takes one request instead of three and leaves nothing in the
   * bucket when it is abandoned. A larger one starts its multipart upload now, in the
   * background, so the first part does not wait for it.
   */
  async createEmpty(id: string, size?: number): Promise<void> {
    const key = this.key(id);
    // S3 caps a multipart upload at MAX_PARTS parts, so a large upload takes larger parts.
    // Every part but the last has this size, which R2 requires.
    const partSize =
      size === undefined
        ? this.partSize
        : Math.max(this.partSize, Math.ceil(size / MAX_PARTS / MIB) * MIB);
    const session: MultipartSession = {
      partSize,
      uploadId: null,
      parts: [],
      abort: new AbortController(),
      bufferChunks: [],
      bufferSize: 0,
      partNumber: 1,
      activeUploads: new Set(),
      uploadError: null,
    };
    if (size === undefined || size > partSize) this.createMultipartUpload(key, session);
    this.multipartSessions.set(id, session);
  }

  /**
   * Starts the multipart upload of a session once. Its error reaches the parts that wait for
   * it. Not cancelled by an abort, so an upload that S3 created is always known and aborted.
   */
  private createMultipartUpload(key: string, session: MultipartSession): Promise<string> {
    session.uploadId ??= this.client
      .send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key }))
      .then((result) => {
        if (!result.UploadId) {
          throw new Error("S3 CreateMultipartUpload did not return an UploadId");
        }
        return result.UploadId;
      });
    // Handled where it is awaited. This only keeps a failure before then from going unhandled.
    session.uploadId.catch(() => {});
    return session.uploadId;
  }

  /**
   * Uploads one part in the background, tracked in activeUploads. Waits for room in the memory
   * limit first, which holds back the caller and with it the sender, and gives it back once the
   * part settled, stored or not.
   */
  private async sendPart(id: string, session: MultipartSession, data: Uint8Array, partNumber: number) {
    await this.partMemory.take(data.byteLength);
    this.startPart(id, session, data, partNumber);
  }

  private startPart(id: string, session: MultipartSession, data: Uint8Array, partNumber: number) {
    const key = this.key(id);
    const p = this.createMultipartUpload(key, session)
      .then((uploadId) =>
        this.client.send(
          new UploadPartCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
            Body: data,
          }),
          { abortSignal: session.abort.signal },
        ),
      )
      .then((result) => {
        session.parts.push({ PartNumber: partNumber, ETag: result.ETag! });
      })
      .catch((err) => {
        if (!session.uploadError) {
          session.uploadError = err instanceof Error ? err : new Error(String(err));
        }
      })
      .finally(() => {
        session.activeUploads.delete(p);
        this.partMemory.give(data.byteLength);
      });
    session.activeUploads.add(p);
  }

  /** Takes `size` bytes from the front of the buffer of a session, copied into one array. */
  private takeFromBuffer(session: MultipartSession, size: number): Uint8Array {
    const data = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const chunk = session.bufferChunks[0]!;
      const needed = size - offset;
      if (chunk.byteLength <= needed) {
        data.set(chunk, offset);
        offset += chunk.byteLength;
        session.bufferChunks.shift();
      } else {
        data.set(chunk.subarray(0, needed), offset);
        session.bufferChunks[0] = chunk.subarray(needed);
        offset += needed;
      }
    }
    session.bufferSize -= size;
    return data;
  }

  /**
   * Append a chunk to a multipart upload session.
   * Buffers data until the part size is reached, then uploads parts to S3 concurrently.
   * Applies backpressure by waiting for one part to complete when all concurrency slots are
   * full, so the caller slows down to the speed of the bucket.
   */
  async appendChunk(id: string, stream: ReadableStream<Uint8Array>): Promise<number> {
    const session = this.multipartSessions.get(id);
    if (!session) {
      throw new Error(`No multipart session found for ${id}`);
    }

    // Propagate any error from previous background uploads
    if (session.uploadError) throw session.uploadError;

    // Read incoming stream chunks (keep as-is, no extra copy)
    const reader = stream.getReader();
    let bytesRead = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      session.bufferChunks.push(value);
      session.bufferSize += value.byteLength;
      bytesRead += value.byteLength;
    }

    while (session.bufferSize >= session.partSize) {
      // Wait for a free slot if all are in use
      while (session.activeUploads.size >= this.concurrency) {
        await Promise.race(session.activeUploads);
        if (session.uploadError) throw session.uploadError;
      }
      const data = this.takeFromBuffer(session, session.partSize);
      await this.sendPart(id, session, data, session.partNumber++);
    }

    // If all slots are full, wait for ONE to finish. This delays the caller, which throttles
    // the client to the speed of the bucket.
    if (session.activeUploads.size >= this.concurrency) {
      await Promise.race(session.activeUploads);
      if (session.uploadError) throw session.uploadError;
    }

    return bytesRead;
  }

  /**
   * Finalize the upload: one PutObject for an upload that never filled a part, otherwise the
   * rest goes out as the last part beside the parts still in flight and the multipart upload is
   * completed. A finalize that fails aborts the upload itself, so no parts are left in the
   * bucket.
   */
  async finalizeChunkedUpload(id: string): Promise<void> {
    const session = this.multipartSessions.get(id);
    if (!session) {
      throw new Error(`No multipart session found for ${id}`);
    }

    try {
      if (session.uploadError) throw session.uploadError;

      if (session.uploadId === null) {
        await this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: this.key(id),
            Body: this.takeFromBuffer(session, session.bufferSize),
          }),
          { abortSignal: session.abort.signal },
        );
        this.multipartSessions.delete(id);
        return;
      }

      // The last part (can be < 5MB) need not wait for the parts before it.
      if (session.bufferSize > 0) {
        const data = this.takeFromBuffer(session, session.bufferSize);
        await this.sendPart(id, session, data, session.partNumber++);
      }
      await Promise.all(session.activeUploads);
      if (session.uploadError) throw session.uploadError;

      // S3 refuses a list that is not in ascending order (InvalidPartOrder), and parallel
      // parts finish in any order: one that is retried or simply slower finishes after the
      // parts behind it.
      const parts = [...session.parts].sort((a, b) => a.PartNumber - b.PartNumber);
      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: this.key(id),
          UploadId: await session.uploadId,
          MultipartUpload: { Parts: parts },
        }),
      );
      this.multipartSessions.delete(id);
    } catch (err) {
      // The caller's abortChunkedUpload finds no session after this, so the abort happens here.
      await this.abortSession(id, session);
      throw err;
    }
  }

  /**
   * Create a Node.js ReadStream from S3.
   * Used as fallback when presigned URLs are not desired.
   */
  createReadStream(id: string): ReturnType<typeof createReadStream> {
    // We return a passthrough approach: create a Readable that
    // fetches from S3 on demand.
    const client = this.client;
    const bucket = this.bucket;
    const key = this.key(id);

    const readable = new Readable({
      async read() {
        try {
          const result = await client.send(
            new GetObjectCommand({ Bucket: bucket, Key: key }),
          );
          const body = result.Body;
          if (!body) {
            this.destroy(new Error("Empty S3 response body"));
            return;
          }
          // Stream the S3 body through
          const webStream = body.transformToWebStream();
          const reader = webStream.getReader();
          const pump = async () => {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                this.push(null);
                return;
              }
              if (!this.push(value)) {
                // Backpressure: wait for drain
                await new Promise<void>((resolve) => this.once("drain", resolve));
              }
            }
          };
          pump().catch((err) => this.destroy(err));
        } catch (err) {
          this.destroy(err as Error);
        }
      },
    });

    // Override read to only fetch once
    let fetched = false;
    const origRead = readable._read.bind(readable);
    readable._read = function (size) {
      if (!fetched) {
        fetched = true;
        origRead(size);
      }
    };

    return readable as ReturnType<typeof createReadStream>;
  }

  /** Delete an object from S3. Ignores missing objects. */
  async delete(id: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: this.key(id),
        }),
      );
    } catch (err) {
      // S3 DeleteObject is idempotent for most providers,
      // but handle NotFound gracefully just in case
      if ((err as { name?: string }).name === "NotFound") return;
      throw err;
    }
  }

  /** Check if an object exists in S3. */
  async exists(id: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: this.key(id),
        }),
      );
      return true;
    } catch (err) {
      if ((err as { name?: string }).name === "NotFound" ||
          (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw err;
    }
  }

  /** Get object size in bytes. Returns null if it does not exist. */
  async size(id: string): Promise<number | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: this.key(id),
        }),
      );
      return result.ContentLength ?? null;
    } catch (err) {
      if ((err as { name?: string }).name === "NotFound" ||
          (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  /** Remove all objects in the bucket. Used for testing cleanup. */
  async clear(): Promise<void> {
    let continuationToken: string | undefined;

    do {
      const list = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          ContinuationToken: continuationToken,
        }),
      );

      if (list.Contents && list.Contents.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: {
              Objects: list.Contents.map((obj) => ({ Key: obj.Key })),
            },
          }),
        );
      }

      continuationToken = list.NextContinuationToken;
    } while (continuationToken);
  }

  /**
   * S3 storage always uses presigned download URLs.
   *
   * Presigned URLs have a short TTL (configurable, default 300s) and expire automatically,
   * enforcing download limits and expiry even if a URL is recorded by a client.
   */
  supportsPresignedUrls(): boolean {
    return true;
  }

  /** Generate a presigned GET URL for direct client download. */
  async getPresignedDownloadUrl(id: string, expiresInSec?: number): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: this.key(id),
    });

    return getSignedUrl(this.client, command, {
      expiresIn: expiresInSec ?? this.presignedExpiry,
    });
  }

  /** Abort a multipart upload in progress. */
  async abortChunkedUpload(id: string): Promise<void> {
    const session = this.multipartSessions.get(id);
    if (session) await this.abortSession(id, session);
  }

  /**
   * Cancels the parts still being uploaded, waits until none is in flight, then aborts the
   * multipart upload. A part that is still uploading while the abort runs may be stored after
   * it, and its bytes would be billed until a lifecycle rule removes them.
   */
  private async abortSession(id: string, session: MultipartSession): Promise<void> {
    this.multipartSessions.delete(id);
    session.abort.abort();
    await Promise.allSettled(session.activeUploads);
    // An upload that was stored with one PutObject, or whose creation failed, has nothing to abort.
    const uploadId = await session.uploadId?.catch(() => null);
    if (!uploadId) return;
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: this.key(id),
          UploadId: uploadId,
        }),
      );
    } catch (err) {
      // Best effort. A lifecycle rule for incomplete multipart uploads catches what is left.
      console.warn("[s3] Aborting a multipart upload failed:", describeError(err));
    }
  }
}
