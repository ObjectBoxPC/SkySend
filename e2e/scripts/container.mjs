// Runs a Docker container for as long as the script that called this lives, for the services the
// end-to-end setups need beside SkySend. A container outlives the process that started it, so a
// left-over one of the same name goes first, and SIGTERM, which Playwright sends when it is told
// to through gracefulShutdown, removes it again.
import { execFileSync, spawn } from "node:child_process";

/**
 * Starts `docker run --rm --name <name> <args>` in the foreground and returns the process. The
 * caller's process exits with the container. `quiet` drops the output of a chatty service.
 */
export function runContainer(name, args, { quiet = false } = {}) {
  const remove = () => execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  remove();
  const container = spawn("docker", ["run", "--rm", "--name", name, ...args], {
    stdio: ["ignore", quiet ? "ignore" : "inherit", quiet ? "ignore" : "inherit"],
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      remove();
      process.exit(0);
    });
  }
  container.on("exit", (code) => process.exit(code ?? 1));
  return container;
}
