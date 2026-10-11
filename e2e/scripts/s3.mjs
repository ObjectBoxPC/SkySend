// Runs an S3-compatible store for the end-to-end setup with STORAGE_BACKEND=s3, and creates its
// bucket, which the server checks for at startup. SeaweedFS stands in for AWS S3, R2 and the
// rest: MinIO no longer publishes images. Without identities it accepts any signature, the
// presigned ones the browser downloads with included, and it answers CORS for any origin.
//
// Usage: node scripts/s3.mjs <name> <port> <bucket>
import { runContainer } from "./container.mjs";

/** Pinned by digest, so a run locally and one in CI use the same store. */
const IMAGE =
  "chrislusf/seaweedfs:4.48@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d";

const [name, port, bucket] = process.argv.slice(2);
if (!name || !port || !bucket) throw new Error("Usage: node scripts/s3.mjs <name> <port> <bucket>");

// Only the S3 port is published, the other services of SeaweedFS stay inside the container. Its
// log is long and of no use to a test, and its usage statistics stay off.
runContainer(
  `skysend-e2e-${name}`,
  ["--publish", `127.0.0.1:${port}:8333`, IMAGE, "server", "-s3", "-master.telemetry=false"],
  { quiet: true },
);

const endpoint = `http://127.0.0.1:${port}`;
for (let attempt = 0; ; attempt++) {
  const ready = await fetch(endpoint).catch(() => null);
  if (ready?.ok) break;
  if (attempt > 120) throw new Error("SeaweedFS did not come up");
  await new Promise((resolve) => setTimeout(resolve, 500));
}
const created = await fetch(`${endpoint}/${bucket}`, { method: "PUT" });
if (!created.ok) throw new Error(`Creating the bucket failed with ${created.status}`);
console.log(`[e2e] S3 store with bucket ${bucket} on ${endpoint}`);
