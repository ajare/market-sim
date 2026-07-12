/**
 * Stage 2: tune the single global ships-per-location ratio (the only fleet-
 * density knob buildWorldFromJson's synthesis has -- see
 * BuildWorldFromJsonOptions.targetShipsPerLocation). Halving-step-size
 * ASCENT from the starting ratio (more ships should reduce shortages Stage
 * 1's demand-side fixes couldn't reach), capped at 2x the starting value.
 * Mirrors stage1.ts's mechanics exactly, just one dimension, searching up
 * instead of down.
 *
 * This never touches the World JSON itself -- ships-per-location is a build
 * parameter, not part of the authored World schema, so Stage 2's result is a
 * CLI recommendation reported alongside the JSON diff, not embodied in it.
 */
import { evaluateWorld, isImprovement, type AggregatedResult, type EvalConfig } from "./evaluate";
import type { WorldJson } from "./worldJson";

const INITIAL_STEP_FRACTION = 0.2;
const MIN_STEP_FRACTION = 0.02;
const CEILING_MULTIPLE = 2;

export interface Stage2Result {
  startingRatio: number;
  finalRatio: number;
  baseline: AggregatedResult;
  final: AggregatedResult;
  changed: boolean;
}

export function runStage2(
  worldJson: WorldJson,
  config: EvalConfig,
  ratioTolerance: number,
  onProgress?: (message: string) => void,
): Stage2Result {
  const log = onProgress ?? (() => {});
  const startingRatio = config.targetShipsPerLocation;
  const ceiling = startingRatio * CEILING_MULTIPLE;

  let bestRatio = startingRatio;
  let bestResult = evaluateWorld(worldJson, config);
  const baseline = bestResult;
  let step = INITIAL_STEP_FRACTION;

  while (step > MIN_STEP_FRACTION) {
    const testRatio = Math.min(ceiling, bestRatio * (1 + step));
    if (testRatio <= bestRatio) break; // ceiling already reached

    log(`Stage 2: trying targetShipsPerLocation=${testRatio.toFixed(2)} (from ${bestRatio.toFixed(2)})...`);
    const candidateResult = evaluateWorld(worldJson, { ...config, targetShipsPerLocation: testRatio });

    if (isImprovement(bestResult, candidateResult, ratioTolerance)) {
      bestRatio = testRatio;
      bestResult = candidateResult;
      log(`  -> accepted`);
    } else {
      step /= 2;
    }
  }

  return { startingRatio, finalRatio: bestRatio, baseline, final: bestResult, changed: bestRatio !== startingRatio };
}
