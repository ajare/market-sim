export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Clamps `n` to [0, 1] -- e.g. Sailor.piracy after a daily tick (see World.runDay/sailorPool.tickPoolPiracy). */
export function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}
