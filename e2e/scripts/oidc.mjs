// Runs an OpenID Connect provider for the end-to-end setup that puts uploads behind a login: one
// client, any login accepted through the development login form of oidc-provider. It serves
// HTTPS with a fresh self-signed certificate, since openid-client in the server refuses an issuer
// over plain HTTP. The SkySend server of that setup trusts it through
// NODE_TLS_REJECT_UNAUTHORIZED=0, which no other server of the tests gets.
//
// The client comes from OIDC_CLIENT_ID and OIDC_CLIENT_SECRET, the names the server reads it by.
//
// Usage: node scripts/oidc.mjs <name> <port> <redirect uri>
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Provider from "oidc-provider";

const [name, port, redirectUri] = process.argv.slice(2);
const { OIDC_CLIENT_ID: clientId, OIDC_CLIENT_SECRET: clientSecret } = process.env;
if (!name || !port || !redirectUri || !clientId || !clientSecret) {
  throw new Error("Usage: node scripts/oidc.mjs <name> <port> <redirect uri>, with the client set");
}

const dir = join(tmpdir(), `skysend-e2e-proxy-${name}`);
mkdirSync(dir, { recursive: true });
execFileSync(
  "openssl",
  [
    ...["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"],
    ...["-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "2"],
    ...["-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"],
  ],
  { stdio: "ignore" },
);

const provider = new Provider(`https://localhost:${port}`, {
  clients: [
    {
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "client_secret_post",
    },
  ],
  claims: { openid: ["sub"], profile: ["name"], email: ["email"] },
  // Whoever logs in exists, with a name and an address made from the login.
  findAccount: (_ctx, sub) => ({
    accountId: sub,
    claims: () => ({ sub, name: `E2E ${sub}`, email: `${sub}@example.test` }),
  }),
  features: { devInteractions: { enabled: true } },
  cookies: { keys: ["skysend-e2e-cookie-key"] },
});

const server = https.createServer(
  { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) },
  provider.callback(),
);
server.listen(Number(port), "127.0.0.1", () => {
  console.log(`[e2e] OIDC provider on https://localhost:${port}`);
});
