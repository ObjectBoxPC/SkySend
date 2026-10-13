import type { Config } from "./config.js";

/**
 * The origins a browser fetches presigned S3 downloads from, for the CSP connect-src.
 *
 * With S3_FORCE_PATH_STYLE the bucket is part of the path, so the endpoint itself is enough.
 * Without it the AWS SDK puts the bucket into the host, like
 * https://<bucket>.<account>.r2.cloudflarestorage.com for R2 or
 * https://<bucket>.<region>.your-objectstorage.com for Hetzner, which a connect-src of the
 * endpoint alone blocked, Service Worker included. The SDK falls back to the path for a bucket
 * name that is no DNS label, so the endpoint stays allowed beside it.
 */
export function bucketConnectSources(
  config: Pick<Config, "S3_ENDPOINT" | "S3_REGION" | "S3_BUCKET" | "S3_FORCE_PATH_STYLE">,
): string[] {
  if (config.S3_ENDPOINT) {
    const endpoint = new URL(config.S3_ENDPOINT);
    const sources = [`${endpoint.origin}/`];
    if (!config.S3_FORCE_PATH_STYLE && config.S3_BUCKET) {
      sources.push(`${endpoint.protocol}//${config.S3_BUCKET}.${endpoint.host}/`);
    }
    return sources;
  }
  if (config.S3_REGION) {
    return [
      `https://s3.${config.S3_REGION}.amazonaws.com`,
      `https://*.s3.${config.S3_REGION}.amazonaws.com`,
    ];
  }
  return [];
}
