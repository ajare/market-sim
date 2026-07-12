/**
 * Stage 1: tune the consumedCommodities modifier at the worst-offending
 * (Location, commodity) pairs. Targets only the top `topN` worst pairs from a
 * fresh baseline (never every pair in the world -- see the grilled spec),
 * re-ranking from a fresh baseline after each accepted fix since fixing one
 * pair can shift bottleneck pressure elsewhere.
 *
 * Per targeted pair: halving-step-size descent, decrease-only (a shortage
 * means consumption is outpacing supply, so there's never a reason to try
 * increasing it here), floored at 30% of the original modifier.
 */
import { evaluateWorld, isImprovement, rankWorstPairs, type AggregatedResult, type EvalConfig } from "./evaluate";
import { cloneWorldJson, type WorldJson } from "./worldJson";

export interface ModifierChange {
  location: string;
  commodity: string;
  fromModifier: number;
  toModifier: number;
}

export interface Stage1Result {
  worldJson: WorldJson;
  baseline: AggregatedResult;
  final: AggregatedResult;
  changes: ModifierChange[];
}

const INITIAL_STEP_FRACTION = 0.2;
const MIN_STEP_FRACTION = 0.02;
const FLOOR_FRACTION = 0.3;

/** Rounds to 4 decimal places -- repeated `*(1 - step)` multiplications otherwise leave float noise like 0.40960000000000013 in the accepted modifier. */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Descends `originalModifier` for one pair via halving-step decrease-only search, starting from `startResult`/`current`. Returns the best modifier found (possibly unchanged) and its evaluation. */
function descendModifier(
  current: WorldJson,
  config: EvalConfig,
  ratioTolerance: number,
  location: string,
  commodity: string,
  originalModifier: number,
  startResult: AggregatedResult,
): { modifier: number; result: AggregatedResult } {
  let bestModifier = originalModifier;
  let bestResult = startResult;
  let step = INITIAL_STEP_FRACTION;
  const floor = originalModifier * FLOOR_FRACTION;

  while (step > MIN_STEP_FRACTION) {
    const testModifier = round4(Math.max(floor, bestModifier * (1 - step)));
    if (testModifier >= bestModifier) break; // floor already reached, no further room to descend

    const candidate = cloneWorldJson(current);
    const candidateLoc = candidate.locations.find((l) => l.name === location)!;
    candidateLoc.consumedCommodities[commodity] = testModifier;
    const candidateResult = evaluateWorld(candidate, config);

    if (isImprovement(bestResult, candidateResult, ratioTolerance)) {
      bestModifier = testModifier;
      bestResult = candidateResult;
      // Keep descending at the same step size from the new best point.
    } else {
      step /= 2;
    }
  }

  return { modifier: bestModifier, result: bestResult };
}

export function runStage1(
  worldJson: WorldJson,
  config: EvalConfig,
  ratioTolerance: number,
  topN: number,
  onProgress?: (message: string) => void,
): Stage1Result {
  const log = onProgress ?? (() => {});
  let current = cloneWorldJson(worldJson);
  let baseline = evaluateWorld(current, config);
  const initialBaseline = baseline;
  const changes: ModifierChange[] = [];
  const attempted = new Set<string>();

  // Bounded by pairs ATTEMPTED, not accepted -- topN caps total effort at a
  // predictable ceiling regardless of how many candidates turn out to have
  // no improving modifier at all.
  while (attempted.size < topN) {
    const worst = rankWorstPairs(baseline.perSeed).find(
      (p) => p.avgZeroDays > 0 && !attempted.has(`${p.location}::${p.commodity}`),
    );
    if (worst === undefined) break;
    attempted.add(`${worst.location}::${worst.commodity}`);

    const loc = current.locations.find((l) => l.name === worst.location);
    const originalModifier = loc?.consumedCommodities[worst.commodity];
    if (loc === undefined || originalModifier === undefined) continue;

    log(`Stage 1: tuning ${worst.location} / ${worst.commodity} (avg ${worst.avgZeroDays.toFixed(1)} zero-stock days)...`);
    const { modifier, result } = descendModifier(
      current, config, ratioTolerance, worst.location, worst.commodity, originalModifier, baseline,
    );

    if (modifier !== originalModifier) {
      const targetLoc = current.locations.find((l) => l.name === worst.location)!;
      targetLoc.consumedCommodities[worst.commodity] = modifier;
      changes.push({ location: worst.location, commodity: worst.commodity, fromModifier: originalModifier, toModifier: modifier });
      baseline = result;
      log(`  -> modifier ${originalModifier.toFixed(3)} to ${modifier.toFixed(3)} (accepted)`);
    } else {
      log(`  -> no improving modifier found, leaving as-is`);
    }
  }

  return { worldJson: current, baseline: initialBaseline, final: baseline, changes };
}
