import { describe, it } from "vitest";
import { buildWorld, type BuildWorldOptions } from "./buildWorld";
import { stockpileRatio, stats } from "./analysis";

const DISTANCE_SCALE = 5.0;
const SEEDS = Array.from({ length: 8 }, (_, i) => 1000 + i * 7);
const DAYS = 180;
const WINDOW_DAYS = 30;

function findZeroEpisodeLengths(history: { day: number; stockpile: number }[]): number[] {
  const lengths: number[] = [];
  let runLength = 0;
  for (const rec of history) {
    if (rec.stockpile <= 0) {
      runLength += 1;
    } else {
      if (runLength > 0) lengths.push(runLength);
      runLength = 0;
    }
  }
  if (runLength > 0) lengths.push(runLength);
  return lengths;
}

function runSweep(label: string, values: number[], toOptions: (v: number) => Partial<BuildWorldOptions>): void {
  console.log(`\n-- ${label} (distanceScale=${DISTANCE_SCALE}) --`);
  for (const value of values) {
    const ratios: number[] = [];
    const episodeCounts: number[] = [];
    const allLengths: number[] = [];

    for (const seed of SEEDS) {
      const { world } = buildWorld(1000, { seed, distanceScale: DISTANCE_SCALE, ...toOptions(value) });
      world.run(DAYS);
      ratios.push(stockpileRatio(world, WINDOW_DAYS));

      const lengths: number[] = [];
      for (const loc of world.locations) {
        for (const commodity of Object.keys(loc.consumedCommodities)) {
          const market = world.sellMarkets.get(`${loc.name}::${commodity}`);
          if (market === undefined) continue;
          lengths.push(...findZeroEpisodeLengths(market.history));
        }
      }
      episodeCounts.push(lengths.length);
      allLengths.push(...lengths);
    }

    const ratioStats = stats(ratios);
    const countStats = stats(episodeCounts);
    const lengthStats = stats(allLengths);
    console.log(
      `${label}=${String(value).padStart(6)}  ratio: mean=${ratioStats.mean.toFixed(3)} sd=${ratioStats.sd.toFixed(3)}  |  episodes: mean=${countStats.mean.toFixed(1)} sd=${countStats.sd.toFixed(1)}  |  duration: mean=${lengthStats.mean.toFixed(2)} sd=${lengthStats.sd.toFixed(2)} max=${lengthStats.max} n=${lengthStats.n}`,
    );
  }
}

describe("distanceScale=5 x mitigation variables sweep", () => {
  it("sweeps CONTRACT_QUANTITY_MULTIPLIER, DEFAULT_CONTRACT_THRESHOLD_FRACTION, DEFAULT_TARGET_SHIPS_PER_LOCATION, DEFAULT_MIN_STOCKPILE_DAYS", () => {
    console.log(`RUN v1 -- distanceScale=${DISTANCE_SCALE}, police=80 (default)`);

    runSweep("quantityMultiplier", [0.75, 1.5, 2.0, 3.0, 5.0], (v) => ({
      contractOptions: { quantityMultiplier: v },
    }));

    runSweep("contractThresholdFraction", [1.0, 1.5, 2.0, 3.0, 5.0], (v) => ({
      contractThresholdFraction: v,
    }));

    runSweep("targetShipsPerLocation", [5, 7, 10, 15, 20], (v) => ({
      targetShipsPerLocation: v,
    }));

    runSweep("minStockpileDays", [7, 14, 21, 30, 45], (v) => ({
      minStockpileDays: v,
    }));
  }, 1_800_000);
});
