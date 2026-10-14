// Downloads the Caddy release the end-to-end tests run behind into e2e/.tools/caddy. The
// version and the SHA-512 of every archive are pinned here, from the checksums file of the
// release, so nothing else gets unpacked. Distributions ship much older releases than the ones
// operators run, which is why the tests do not take Caddy from apt.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "2.11.7";
const SHA512 = {
  linux_amd64:
    "a7a433a1b133efc3c8d10eb0b99d52a24b5ef5c322dc77f5282182b1c0402139ab83f3a99f0c52409df77d20123fb0b523edad8a66d8f5e49136197bf61ef0e7",
  linux_arm64:
    "3db36ba90c7a6e8dda40ee3dd71fa08844c76b5fb08f61b31e5e78d2ed38e71c51dc7baed875e50d1ca1279196e84302967237386ae87c91ae9f2aaceada682e",
  mac_amd64:
    "147886811fa2320a8881c6116dc8cc3f0562e2f686509ccc60f55cf85dfd5ea78e9f5f770c75da13bf124a2536b72e887b975fefd58706de3dafb57483610e70",
  mac_arm64:
    "68f592df8f0ec058fbdb9b137b64e9a0aa792d28c06e1e3b9ec12d0e7fb371683a54e73ef6d8e6d0dd70dc6b941a5b5d5b73faedd3f89de119ad2eb78bdc668e",
};

const tools = join(dirname(fileURLToPath(import.meta.url)), "..", ".tools");
const binary = join(tools, "caddy");

const os = { linux: "linux", darwin: "mac" }[process.platform];
const arch = { x64: "amd64", arm64: "arm64" }[process.arch];
const platform = `${os}_${arch}`;
const expected = SHA512[platform];
if (!os || !arch || !expected) {
  throw new Error(`No pinned Caddy build for ${process.platform} ${process.arch}`);
}

if (existsSync(binary)) {
  const installed = execFileSync(binary, ["version"], { encoding: "utf8" });
  if (installed.startsWith(`v${VERSION} `)) {
    console.log(`Caddy ${VERSION} is installed in ${binary}`);
    process.exit(0);
  }
}

const archive = `caddy_${VERSION}_${platform}.tar.gz`;
const url = `https://github.com/caddyserver/caddy/releases/download/v${VERSION}/${archive}`;
const response = await fetch(url);
if (!response.ok) throw new Error(`Downloading ${url} failed with ${response.status}`);
const data = Buffer.from(await response.arrayBuffer());

const actual = createHash("sha512").update(data).digest("hex");
if (actual !== expected) throw new Error(`${archive} does not match its pinned SHA-512`);

mkdirSync(tools, { recursive: true });
execFileSync("tar", ["-xzf", "-", "-C", tools, "caddy"], { input: data });
console.log(`Installed Caddy ${VERSION} in ${binary}`);
