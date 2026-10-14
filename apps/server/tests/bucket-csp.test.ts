import { describe, expect, it } from "vitest";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { bucketConnectSources } from "../src/lib/bucket-csp.js";

/** The origin of a presigned download as the AWS SDK builds it, with made-up credentials. */
async function presignedOrigin(config: {
  S3_ENDPOINT?: string;
  S3_REGION?: string;
  S3_BUCKET: string;
  S3_FORCE_PATH_STYLE: boolean;
}): Promise<string> {
  const client = new S3Client({
    region: config.S3_REGION ?? "auto",
    endpoint: config.S3_ENDPOINT,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  const url = await getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b.bin" }),
    { expiresIn: 60 },
  );
  client.destroy();
  return new URL(url).origin;
}

/** Whether a CSP source list lets the browser fetch from this origin. */
function allows(sources: string[], origin: string): boolean {
  return sources.some((source) => {
    const wildcard = /^https:\/\/\*\.(.+)$/.exec(source);
    if (wildcard) return new URL(origin).host.endsWith(`.${wildcard[1]}`);
    return source.replace(/\/$/, "") === origin;
  });
}

describe("bucketConnectSources", () => {
  const providers = [
    {
      name: "Cloudflare R2 as the docs configure it",
      S3_ENDPOINT: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
      S3_REGION: "auto",
    },
    {
      name: "Cloudflare R2 in the EU jurisdiction",
      S3_ENDPOINT: "https://0123456789abcdef0123456789abcdef.eu.r2.cloudflarestorage.com",
      S3_REGION: "auto",
    },
    {
      name: "Hetzner Object Storage",
      S3_ENDPOINT: "https://eu-central-1.your-objectstorage.com",
      S3_REGION: "eu-central-1",
    },
    { name: "MinIO on a port", S3_ENDPOINT: "https://minio.example.com:9000", S3_REGION: "us-east-1" },
    { name: "AWS S3", S3_ENDPOINT: undefined, S3_REGION: "eu-central-1" },
  ];

  for (const provider of providers) {
    for (const pathStyle of [false, true]) {
      it(`allows the presigned downloads of ${provider.name}${pathStyle ? " with path style" : ""}`, async () => {
        const config = {
          S3_ENDPOINT: provider.S3_ENDPOINT,
          S3_REGION: provider.S3_REGION,
          S3_BUCKET: "skysend-uploads",
          S3_FORCE_PATH_STYLE: pathStyle,
        };
        const origin = await presignedOrigin(config);
        expect(allows(bucketConnectSources(config), origin), origin).toBe(true);
      });
    }
  }

  it("allows the endpoint for a bucket name the SDK cannot put into a host", async () => {
    const config = {
      S3_ENDPOINT: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
      S3_REGION: "auto",
      S3_BUCKET: "Uploads_Of_SkySend",
      S3_FORCE_PATH_STYLE: false,
    };
    const origin = await presignedOrigin(config);
    expect(allows(bucketConnectSources(config), origin), origin).toBe(true);
  });

  it("adds no host of the bucket when path style keeps it in the path", () => {
    expect(
      bucketConnectSources({
        S3_ENDPOINT: "https://minio.example.com:9000",
        S3_REGION: "us-east-1",
        S3_BUCKET: "skysend-uploads",
        S3_FORCE_PATH_STYLE: true,
      }),
    ).toEqual(["https://minio.example.com:9000/"]);
  });
});
