/**
 * Seed-averaging sweep harness for stockpile tuning. NOT part of the normal
 * test suite (vitest's default discovery only picks up *.test.ts) -- run it
 * explicitly with the dedicated config:
 *
 *   npm run sweep
 *
 * It reports mean +/- SD across seeds instead of a single noisy run, because
 * the stockpile metric carries a ~0.05 SD of Monte-Carlo noise per run (see
 * analysis.ts for the diagnosis). Configure via env vars:
 *
 *   SWEEP_SEEDS               how many seeds to average          (default 8)
 *   SWEEP_DAYS                simulated days per run             (default 90)
 *   SWEEP_WINDOW              trailing-day averaging window      (default 30)
 *   SWEEP_MAX_ROUTE           route-distance cap                 (default 1000)
 *   SWEEP_SHIPS_PER_LOCATION  comma list to sweep, e.g. "10,15,20"
 *                             (default: just the calibrated ratio)
 *
 * PowerShell example -- sweep three ratios over 10 seeds each:
 *   $env:SWEEP_SEEDS=10; $env:SWEEP_SHIPS_PER_LOCATION="10,15,20"; npm run sweep
 */
import { describe, it } from "vitest";
import { averageStockpileRatio } from "./analysis";

// This harness lives under src/ (so it shares the app's bundler module
// resolution for its extensionless sim imports) but only ever runs under
// Vitest in Node -- where `process.env` is real. The app tsconfig deliberately
// omits node types, so shim just the sliver of `process` we touch rather than
// pulling all of @types/node into the browser project.
declare const process: { env: Record<string, string | undefined> };

function envNum(name: string, def: number): number {
  const raw = process.env[name];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) ? n : def;
}

const seedCount = envNum("SWEEP_SEEDS", 8);
const days = envNum("SWEEP_DAYS", 90);
const windowDays = envNum("SWEEP_WINDOW", 30);
const maxRouteDistance = envNum("SWEEP_MAX_ROUTE", 1000);

// A fixed, reproducible seed list so re-running the harness gives the same
// numbers -- the point is to average out per-seed noise, not to add more of it.
const seeds = Array.from({ length: Math.max(1, seedCount) }, (_, i) => 1000 + i * 7);

const shipsPerLocationRaw = process.env.SWEEP_SHIPS_PER_LOCATION;
const shipsPerLocationSweep = (shipsPerLocationRaw ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0)
  .map(Number)
  .filter((n) => Number.isFinite(n));

function fmt(n: number): string {
  return n.toFixed(3);
}

describe("stockpile sweep harness", () => {
  it("reports mean +/- SD across seeds", () => {
    console.log(`seeds=${seeds.length} days=${days} window=${windowDays} maxRoute=${maxRouteDistance}`);

    // undefined => buildWorld's default (calibrated) ships-per-location ratio.
    const points: Array<number | undefined> =
      shipsPerLocationSweep.length > 0 ? shipsPerLocationSweep : [undefined];

    for (const spl of points) {
      const { ratios, stats } = averageStockpileRatio({
        seeds,
        days,
        windowDays,
        maxRouteDistance,
        build: spl === undefined ? {} : { targetShipsPerLocation: spl },
      });
      const label = spl === undefined ? "default ratio (480/33)" : `shipsPerLocation=${spl}`;
      console.log(
        `${label.padEnd(26)} mean=${fmt(stats.mean)}  sd=${fmt(stats.sd)}  ` +
          `min=${fmt(stats.min)}  max=${fmt(stats.max)}  [${ratios.map(fmt).join(", ")}]`,
      );
    }
  }, 30 * 60 * 1000);
});
