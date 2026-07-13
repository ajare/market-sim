#!/usr/bin/env node
/**
 * CLI: takes an editor-exported World JSON, adds ships/pirates/police, runs
 * the simulation, measures shortages, and tries to improve them across four
 * stages (world-wide commodity balance, consumption modifiers,
 * ships-per-Location, commodity-Location swaps). See doc/Simulation.md's
 * "World-tuning CLI" section for usage and doc; run with --help for the
 * flag list.
 *
 * Run via `npm run tune -- <world.json> [options]` (wraps `tsx
 * scripts/tune-world.ts`) -- tsx handles both TypeScript stripping and this
 * codebase's extensionless/bundler-style relative imports, so this script
 * can import the real simulation engine (src/sim/*) directly with no
 * separate build step.
 */
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import {
  DEFAULT_NUM_PIRATE_SHIPS, DEFAULT_PIRATE_CASH_PER_SHIP, DEFAULT_NUM_POLICE_SHIPS, DEFAULT_TARGET_SHIPS_PER_LOCATION,
} from "../src/sim/buildWorld";
import { readWorldJson, writeWorldJson } from "./tuning/worldJson";
import type { AggregatedResult, EvalConfig } from "./tuning/evaluate";
import { runStage0 } from "./tuning/stage0";
import { runStage1 } from "./tuning/stage1";
import { runStage2 } from "./tuning/stage2";
import { runStage3 } from "./tuning/stage3";
import { runStage4 } from "./tuning/stage4";
import { worldJsonDiff } from "./tuning/diff";
import { buildReport } from "./tuning/report";

function printUsage(): void {
  console.log(`Usage: npm run tune -- <world.json> [options]

Adds ships/pirates/police to a World authored in the editor, runs the
simulation, measures stockpile shortages, and tries to improve them.

Options:
  --days <n>                 Days to simulate. Default 365.
  --seeds <n,n,...>           Comma-separated dynamics seeds, averaged across. Default 1,2,3.
  --warmup <n>                Days excluded from every metric as warmup. Default 30.
  --top-pairs <n>             Worst (Location, commodity) pairs targeted per stage. Default 10.
  --ratio-tolerance <n>       Band around 1.0 the stockpile/minimum ratio must stay within. Default 0.15.
  --num-pirate-ships <n>      Pirate ships added. Default ${DEFAULT_NUM_PIRATE_SHIPS} (buildWorld's own calibrated default).
  --num-police-ships <n>      Coast Guard ships added. Default ${DEFAULT_NUM_POLICE_SHIPS}.
  --ships-per-location <n>    Starting ships-per-Location ratio (Stage 2's search starts here). Default ${DEFAULT_TARGET_SHIPS_PER_LOCATION}.
  --help                      Show this message.

Outputs (written alongside <world.json>):
  <world>.report.md           Metrics before/after each stage, what was tried/accepted/rejected.
  <world>.tuned.json           The modified World (only written if a change was accepted).
  <world>.tuned.diff           Unified diff, original -> tuned (git apply / patch -p0 compatible).
`);
}

function parseSeeds(raw: string): number[] {
  const seeds = raw.split(",").map((s) => Number(s.trim()));
  if (seeds.some((s) => Number.isNaN(s))) throw new Error(`--seeds: could not parse "${raw}" as a comma-separated number list.`);
  return seeds;
}

function logMetrics(label: string, r: AggregatedResult): void {
  console.log(
    `${label}: zero-stock pairs=${r.zeroStockPairCount.toFixed(2)}  ` +
      `avg outage length=${r.avgEpisodeLength.toFixed(2)}d  avg ratio=${r.avgRatio.toFixed(3)}`,
  );
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      days: { type: "string", default: "365" },
      seeds: { type: "string", default: "1,2,3" },
      warmup: { type: "string", default: "30" },
      "top-pairs": { type: "string", default: "10" },
      "ratio-tolerance": { type: "string", default: "0.15" },
      "num-pirate-ships": { type: "string" },
      "num-police-ships": { type: "string" },
      "ships-per-location": { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    printUsage();
    return;
  }
  if (positionals.length === 0) {
    printUsage();
    throw new Error("Missing required <world.json> argument.");
  }

  const inputPath = positionals[0];
  const days = Number(values.days);
  const warmupDays = Number(values.warmup);
  if (warmupDays >= days) throw new Error(`--warmup (${warmupDays}) must be less than --days (${days}).`);
  const topN = Number(values["top-pairs"]);
  const ratioTolerance = Number(values["ratio-tolerance"]);
  const numPirateShips = values["num-pirate-ships"] !== undefined ? Number(values["num-pirate-ships"]) : DEFAULT_NUM_PIRATE_SHIPS;
  const numPoliceShips = values["num-police-ships"] !== undefined ? Number(values["num-police-ships"]) : DEFAULT_NUM_POLICE_SHIPS;
  const targetShipsPerLocation =
    values["ships-per-location"] !== undefined ? Number(values["ships-per-location"]) : DEFAULT_TARGET_SHIPS_PER_LOCATION;
  const seeds = parseSeeds(values.seeds as string);

  const worldJson = readWorldJson(inputPath);
  console.log(`Loaded ${inputPath}: ${worldJson.locations.length} locations.`);

  const baseConfig: EvalConfig = {
    seeds, days, warmupDays, numPirateShips, pirateCashPerShip: DEFAULT_PIRATE_CASH_PER_SHIP, numPoliceShips,
    targetShipsPerLocation,
  };

  console.log("\n=== Stage 0: world-wide commodity balance ===");
  const stage0 = runStage0(worldJson, baseConfig, (m) => console.log(m));
  logMetrics("Baseline", stage0.baseline);
  logMetrics("After Stage 0", stage0.final);

  console.log("\n=== Stage 1: consumption-modifier tuning ===");
  const stage1 = runStage1(stage0.worldJson, baseConfig, ratioTolerance, topN, (m) => console.log(m));
  logMetrics("After Stage 1", stage1.final);

  console.log("\n=== Stage 2: ships-per-Location tuning ===");
  const stage2 = runStage2(stage1.worldJson, baseConfig, ratioTolerance, (m) => console.log(m));
  logMetrics("After Stage 2", stage2.final);

  console.log("\n=== Stage 3: commodity-Location swaps ===");
  const stage2Config: EvalConfig = { ...baseConfig, targetShipsPerLocation: stage2.finalRatio };
  const stage3 = runStage3(stage1.worldJson, stage2Config, ratioTolerance, topN, (m) => console.log(m));
  logMetrics("After Stage 3", stage3.final);

  console.log("\n=== Stage 4: add producers for remaining shortages ===");
  const stage4 = runStage4(stage3.worldJson, stage2Config, (m) => console.log(m));
  logMetrics("After Stage 4", stage4.final);

  const jsonChanged =
    stage0.rescaledCommodities.length > 0 || stage0.addedConsumers.length > 0 || stage1.changes.length > 0 ||
    stage3.changes.length > 0 || stage4.changes.length > 0;
  let tunedJsonPath: string | null = null;
  let diffPath: string | null = null;
  if (jsonChanged) {
    tunedJsonPath = inputPath.replace(/\.json$/, "") + ".tuned.json";
    diffPath = inputPath.replace(/\.json$/, "") + ".tuned.diff";
    writeWorldJson(tunedJsonPath, stage4.worldJson);
    writeFileSync(diffPath, worldJsonDiff(inputPath, tunedJsonPath, worldJson, stage4.worldJson), "utf8");
  }

  const report = buildReport({
    inputPath,
    config: { days, warmupDays, seeds, ratioTolerance, numPirateShips, numPoliceShips },
    initialBaseline: stage0.baseline,
    stage0,
    afterStage0: stage0.final,
    stage1Changes: stage1.changes,
    afterStage1: stage1.final,
    stage2,
    stage3Changes: stage3.changes,
    afterStage3: stage3.final,
    stage4Changes: stage4.changes,
    afterStage4: stage4.final,
    tunedJsonPath,
    diffPath,
  });
  const reportPath = inputPath.replace(/\.json$/, "") + ".report.md";
  writeFileSync(reportPath, report, "utf8");

  console.log(`\nReport written to ${reportPath}`);
  if (tunedJsonPath !== null) console.log(`Tuned World written to ${tunedJsonPath}`);
  if (diffPath !== null) console.log(`Diff written to ${diffPath}`);
}

main().catch((err: unknown) => {
  console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
