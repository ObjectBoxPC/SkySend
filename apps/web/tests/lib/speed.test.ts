import { describe, it, expect } from "vitest";
import { createSpeedMeter } from "../../src/lib/speed.js";

const MiB = 1024 * 1024;

/** A meter on a clock the test moves, in milliseconds. */
function meterAt() {
  let clock = 0;
  const meter = createSpeedMeter(3000, () => clock);
  return {
    at(ms: number, loaded: number) {
      clock = ms;
      return meter.add(loaded);
    },
  };
}

describe("createSpeedMeter", () => {
  it("shows a download that arrives in bursts close to its real speed", () => {
    // 20 MiB/s on average, in bursts of 20 MiB every second and nothing in between, the way
    // a download from a bucket arrived in a test against Cloudflare R2.
    const meter = meterAt();
    const shown: number[] = [];
    for (let ms = 500; ms <= 10_000; ms += 500) {
      const loaded = Math.floor(ms / 1000) * 20 * MiB;
      shown.push(meter.at(ms, loaded)! / MiB);
    }
    // After the first window every reading stays within a third of the real speed, where the
    // last half second alone swung between 0 and 40 MiB/s.
    for (const speed of shown.slice(6)) {
      expect(speed).toBeGreaterThan(20 * (2 / 3));
      expect(speed).toBeLessThan(20 * (4 / 3));
    }
  });

  it("follows a speed that changes within a few seconds", () => {
    const meter = meterAt();
    let loaded = 0;
    for (let ms = 500; ms <= 5000; ms += 500) meter.at(ms, (loaded += 5 * MiB));
    // From 10 MiB/s to 40 MiB/s, then four seconds later the window holds only the new speed.
    let speed = 0;
    for (let ms = 5500; ms <= 9000; ms += 500) speed = meter.at(ms, (loaded += 20 * MiB))!;
    expect(speed / MiB).toBeCloseTo(40, 0);
  });

  it("starts over when a tier that fell back reports from 0 again", () => {
    const meter = meterAt();
    meter.at(1000, 50 * MiB);
    meter.at(2000, 100 * MiB);
    // The next tier starts again at 0, which must not count as a negative speed.
    expect(meter.at(2500, 0)).toBeNull();
    expect(meter.at(3500, 10 * MiB)! / MiB).toBeCloseTo(10, 5);
  });

  it("answers nothing before any time passed", () => {
    const meter = meterAt();
    expect(meter.at(0, 0)).toBeNull();
  });
});
