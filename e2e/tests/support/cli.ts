import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

/** The end-user CLI as `pnpm test:e2e:build` builds it. */
const CLI = join(import.meta.dirname, "..", "..", "..", "apps", "client", "dist", "index.js");

/**
 * Runs a command of the CLI with `--json` and returns what it printed. Its config and history go
 * into `home`, a folder of the test, never into the config of whoever runs the tests.
 */
export async function cli(args: string[], home: string) {
  const { stdout } = await promisify(execFile)(process.execPath, [CLI, ...args, "--json"], {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, "config") },
    timeout: 60_000,
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}
