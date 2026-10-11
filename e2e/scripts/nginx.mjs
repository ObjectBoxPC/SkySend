// Runs Nginx in front of one end-to-end setup, with the configuration of
// docs/user-guide/self-hosting/reverse-proxy.md. The server block is read out of that page on
// every start, so the tests check what operators copy, and a change to the docs is tested by the
// next run. Only what has to differ on a test machine is replaced: the port, the certificate and
// the upstream. The redirect from port 80 is left out, since no test opens it.
//
// Usage: node scripts/nginx.mjs <name> <port> <upstream port>
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runContainer } from "./container.mjs";

/** Pinned by digest, so a run locally and one in CI use the same Nginx. */
const IMAGE =
  "nginx:1.30.5-alpine@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94";
const DOCS = new URL("../../docs/user-guide/self-hosting/reverse-proxy.md", import.meta.url);

const [name, port, upstream] = process.argv.slice(2);
if (!name || !port || !upstream) {
  throw new Error("Usage: node scripts/nginx.mjs <name> <port> <upstream port>");
}

/** Replaces exactly one match, so a changed example fails here instead of testing less. */
function replaceOnce(text, pattern, replacement) {
  const count = text.match(new RegExp(pattern.source, "g"))?.length ?? 0;
  if (count !== 1) {
    throw new Error(`The Nginx example in the docs changed: ${pattern} matched ${count} times`);
  }
  return text.replace(pattern, replacement);
}

const page = readFileSync(DOCS, "utf8");
const section = page.split(/^## /m).find((part) => part.startsWith("Nginx\n"));
const example = section?.match(/```nginx\n([\s\S]*?)```/)?.[1];
if (!example) throw new Error("No Nginx example found in the reverse proxy docs");

let site = example;
site = replaceOnce(site, /\nserver \{\n\s+listen 80;[\s\S]*?\n\}\n/, "\n");
site = replaceOnce(site, /listen 443 ssl http2;/, `listen 127.0.0.1:${port} ssl http2;`);
site = replaceOnce(site, /ssl_certificate\s+\S+;/, "ssl_certificate /e2e/cert.pem;");
site = replaceOnce(site, /ssl_certificate_key\s+\S+;/, "ssl_certificate_key /e2e/key.pem;");
site = replaceOnce(
  site,
  /proxy_pass http:\/\/localhost:3000;/,
  `proxy_pass http://127.0.0.1:${upstream};`,
);

const dir = join(tmpdir(), `skysend-e2e-proxy-${name}`);
mkdirSync(dir, { recursive: true });
// A fresh certificate on every start, so none ever runs out.
execFileSync(
  "openssl",
  [
    ...["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"],
    ...["-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "2"],
    ...["-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"],
  ],
  { stdio: "ignore" },
);
writeFileSync(
  join(dir, "nginx.conf"),
  `worker_processes 1;
pid /tmp/nginx.pid;
error_log stderr warn;
events {}
http {
access_log off;
${site}
}
`,
);

// The host network lets Nginx reach the recording proxy on 127.0.0.1 and bind its port there.
runContainer(`skysend-e2e-${name}`, [
  ...["--network", "host", "-v", `${dir}:/e2e:ro`, "--entrypoint", "nginx", IMAGE],
  ...["-c", "/e2e/nginx.conf", "-g", "daemon off;"],
]);
