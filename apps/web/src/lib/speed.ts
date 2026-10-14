/**
 * The speed of a transfer over the last `windowMs`, from the bytes it reported so far. A
 * download from a bucket arrives in bursts, and the last half second alone showed anything
 * from 0 to twice the real speed. A reading below the one before, like a tier that falls back
 * and starts again at 0, starts the window over.
 */
export function createSpeedMeter(windowMs = 3000, now: () => number = () => performance.now()) {
  let samples = [{ time: now(), loaded: 0 }];
  return {
    /** Takes the bytes so far and returns the bytes per second over the window, if any time passed. */
    add(loaded: number): number | null {
      const time = now();
      if (loaded < samples.at(-1)!.loaded) samples = [{ time, loaded }];
      else samples.push({ time, loaded });
      while (samples.length > 2 && time - samples[1]!.time >= windowMs) samples.shift();
      const oldest = samples[0]!;
      return time > oldest.time ? (loaded - oldest.loaded) / ((time - oldest.time) / 1000) : null;
    },
  };
}
