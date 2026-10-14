// Prints the functions that took the most CPU time in a profile of transfer.mjs --profile.
//
//   node e2e/bench/profile-top.mjs <profile.cpuprofile | directory> [--top 25]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { top: { type: "string", default: "25" } },
});
let file = positionals[0];
if (!file) throw new Error("Usage: node e2e/bench/profile-top.mjs <profile or directory>");
if (statSync(file).isDirectory()) {
  const name = readdirSync(file).find((entry) => entry.endsWith(".cpuprofile"));
  if (!name) throw new Error(`No .cpuprofile in ${file}`);
  file = join(file, name);
}
const profile = JSON.parse(readFileSync(file, "utf8"));
const byId = new Map(profile.nodes.map((node) => [node.id, node]));
const self = new Map();
const deltas = profile.timeDeltas;
for (let i = 0; i < profile.samples.length; i++) {
  const node = byId.get(profile.samples[i]);
  const frame = node.callFrame;
  const where = frame.url
    ? frame.url.replace(/^.*node_modules\/\.pnpm\//, "").replace(/^file:\/\/.*\/apps\//, "apps/")
    : "";
  const key = `${frame.functionName || "(anonymous)"}  ${where}:${frame.lineNumber + 1}`;
  self.set(key, (self.get(key) ?? 0) + (deltas[i] ?? 0));
}
const total = [...self.values()].reduce((a, b) => a + b, 0);
const rows = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, Number(values.top));
console.log(`${file}: ${(total / 1e6).toFixed(1)} s sampled`);
for (const [key, time] of rows) {
  console.log(`${((time / total) * 100).toFixed(1).padStart(5)} %  ${key}`);
}
