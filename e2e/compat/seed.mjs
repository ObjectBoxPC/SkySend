// Makes the snapshot of a released version for the compatibility tests: starts the published
// image of that version, shares through its UI with seed/<version>.spec.ts or, without one,
// seed/release.spec.ts, stops the server so SQLite closes cleanly, and freezes its data
// directory and uploads together with what was shared into compat/snapshots/<version>. A
// snapshot is made once, right after its release, and committed.
//
// Usage: pnpm --filter @skysend/e2e compat:seed <version>, like v3.0.1
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!/^v\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error("Usage: compat:seed <version>");

const here = dirname(fileURLToPath(import.meta.url));
// A release whose UI the current helpers no longer fit has a seed of its own.
const own = join(here, "seed", `${version}.spec.ts`);
const spec = existsSync(own) ? own : join(here, "seed", "release.spec.ts");

const image = `ghcr.io/skyfay/skysend:${version}`;
const container = "skysend-e2e-seed";
const port = 3901;
const url = `http://localhost:${port}`;
const work = join(tmpdir(), `skysend-e2e-seed-${version}`);
const target = join(here, "snapshots", version);

const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const removeContainer = () => spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });

rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, "data"), { recursive: true });
mkdirSync(join(work, "uploads"), { recursive: true });

docker("pull", "--quiet", image);
const digest = docker("image", "inspect", image, "--format", "{{index .RepoDigests 0}}");

removeContainer();
// Limits high enough that every browser of a test run, retries included, can open every link
// of the snapshot. The files belong to the user running this, so they can be packed.
const { uid, gid } = userInfo();
docker(
  ...["run", "--detach", "--name", container, "--publish", `127.0.0.1:${port}:3000`],
  ...["--env", `PUID=${uid}`, "--env", `PGID=${gid}`, "--env", `BASE_URL=${url}`],
  ...["--env", "FILE_DOWNLOAD_OPTIONS=1000", "--env", "FILE_DEFAULT_DOWNLOAD=1000"],
  ...["--env", "NOTE_VIEW_OPTIONS=0", "--env", "NOTE_DEFAULT_VIEWS=0"],
  ...["--env", "FILE_REQUEST_UPLOAD_OPTIONS=1000", "--env", "FILE_REQUEST_DEFAULT_UPLOADS=1000"],
  ...["--env", "FILE_REQUEST_DOWNLOAD_OPTIONS=100"],
  ...["--env", "FILE_REQUEST_DEFAULT_DOWNLOADS=100"],
  ...["--env", "RATE_LIMIT_MAX=100000", "--env", "FILE_UPLOAD_QUOTA_BYTES=0"],
  ...["--volume", `${join(work, "data")}:/data`, "--volume", `${join(work, "uploads")}:/uploads`],
  image,
);

try {
  for (let attempt = 0; ; attempt++) {
    const health = await fetch(`${url}/api/health`).catch(() => null);
    if (health?.ok) break;
    if (attempt > 60) throw new Error(`${image} did not come up`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const links = join(work, "links.json");
  const seed = spawnSync(
    "pnpm",
    ["exec", "playwright", "test", "--config", join(here, "seed.config.ts"), spec],
    {
      stdio: "inherit",
      env: { ...process.env, SEED_URL: url, SEED_OUT: links, SEED_VERSION: version },
    },
  );
  if (seed.status !== 0) throw new Error("Seeding failed, nothing was written");

  // SIGTERM reaches the server, which closes the database before it exits.
  docker("stop", "--time", "30", container);

  mkdirSync(target, { recursive: true });
  execFileSync("tar", [
    ...["--create", "--gzip", "--file", join(target, "data.tar.gz")],
    ...["--directory", work, "--exclude", "data/tmp", "data", "uploads"],
  ]);
  const snapshot = {
    version,
    image: digest,
    createdAt: new Date().toISOString(),
    shares: JSON.parse(readFileSync(links, "utf8")),
  };
  writeFileSync(join(target, "links.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`Snapshot of ${version} written to ${target}`);
} catch (error) {
  // What the old server said, since the container goes away with the next line.
  spawnSync("docker", ["logs", "--tail", "40", container], { stdio: "inherit" });
  throw error;
} finally {
  removeContainer();
  rmSync(work, { recursive: true, force: true });
}
