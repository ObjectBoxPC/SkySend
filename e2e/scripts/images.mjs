// The Docker images of the end-to-end services, pinned by digest so a run locally and one in CI
// use the same ones. Run directly, it pulls the named images side by side, which CI starts in the
// background while it installs, so no web server waits for a pull later.
//
// Usage: node scripts/images.mjs [nginx] [s3]
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const IMAGES = {
  nginx:
    "nginx:1.30.5-alpine@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94",
  // MinIO no longer publishes images, see scripts/s3.mjs.
  s3: "chrislusf/seaweedfs:4.48@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d",
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const names = process.argv.slice(2);
  for (const name of names) {
    if (!(name in IMAGES)) {
      throw new Error(`No image called ${name}, there are ${Object.keys(IMAGES)}`);
    }
  }
  const pulls = names.map(
    (name) =>
      new Promise((resolve, reject) => {
        const pull = spawn("docker", ["pull", "--quiet", IMAGES[name]], { stdio: "inherit" });
        pull.on("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`Pulling ${name} failed`)),
        );
      }),
  );
  await Promise.all(pulls);
}
