// Prints the timeline of a run of transfer.mjs: speed on every hop, CPU and memory per interval.
//
//   node e2e/bench/timeline.mjs [result.json] [--step 500]
//
// Without a file it takes the newest result in e2e/.large-files/bench/results.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { step: { type: "string", default: "500" } },
});
const dir = join(import.meta.dirname, "..", ".large-files", "bench", "results");
const file =
  positionals[0] ??
  readdirSync(dir)
    .map((name) => join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
const result = JSON.parse(readFileSync(file, "utf8"));
const samples = result.samples;
const step = Number(values.step);
const MIB = 1024 * 1024;
const t0 = samples[0].t;

// The bytes the upload worker had reported at a time, which is what the UI shows.
const progress = result.upload?.progress ?? [];
function reported(t) {
  let bytes = 0;
  for (const [at, loaded] of progress) {
    if (at > t) break;
    bytes = loaded;
  }
  return bytes;
}

const columns = [
  "t",
  "UI",
  "A up",
  "A down",
  "B up",
  "B down",
  "srv cpu",
  "brw cpu",
  "srv rss",
  "brw rss",
];
console.log(file);
console.log(columns.map((c) => c.padStart(8)).join(""));
let previous = samples[0];
for (const sample of samples) {
  if (sample.t - previous.t < step && sample !== samples.at(-1)) continue;
  const seconds = (sample.t - previous.t) / 1000;
  const rate = (key) => ((sample[key] - previous[key]) / MIB / seconds).toFixed(0);
  const cpu = (key) => `${(((sample[key] - previous[key]) / seconds) * 100).toFixed(0)}%`;
  const row = [
    ((sample.t - t0) / 1000).toFixed(1),
    ((reported(sample.t) - reported(previous.t)) / MIB / seconds).toFixed(0),
    rate("aUp"),
    rate("aDown"),
    rate("bUp"),
    rate("bDown"),
    cpu("serverCpu"),
    cpu("browserCpu"),
    (sample.serverRss / MIB).toFixed(0),
    (sample.browserRss / MIB).toFixed(0),
  ];
  console.log(row.map((c) => String(c).padStart(8)).join(""));
  previous = sample;
}
