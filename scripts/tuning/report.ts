/**
 * Markdown report generation for the tuning CLI -- metrics before/after each
 * stage, and what was tried/accepted/rejected.
 */
import type { AggregatedResult } from "./evaluate";
import type { Stage0Result } from "./stage0";
import type { ModifierChange } from "./stage1";
import type { Stage2Result } from "./stage2";
import type { SwapChange } from "./stage3";

function fmt(n: number): string {
  return Number.isNaN(n) ? "n/a" : n.toFixed(3);
}

function metricsTable(label: string, result: AggregatedResult): string {
  return [
    `| ${label} | ${fmt(result.zeroStockPairCount)} | ${fmt(result.avgEpisodeLength)} | ${fmt(result.avgRatio)} |`,
  ].join("\n");
}

export interface ReportInput {
  inputPath: string;
  config: {
    days: number;
    warmupDays: number;
    seeds: number[];
    ratioTolerance: number;
    numPirateShips: number;
    numPoliceShips: number;
  };
  initialBaseline: AggregatedResult;
  stage0: Stage0Result;
  afterStage0: AggregatedResult;
  stage1Changes: ModifierChange[];
  afterStage1: AggregatedResult;
  stage2: Stage2Result;
  stage3Changes: SwapChange[];
  afterStage3: AggregatedResult;
  tunedJsonPath: string | null;
  diffPath: string | null;
}

export function buildReport(input: ReportInput): string {
  const lines: string[] = [];
  lines.push(`# World tuning report: ${input.inputPath}`);
  lines.push("");
  lines.push(
    `Run over ${input.config.days} days (first ${input.config.warmupDays} excluded as warmup), ` +
      `averaged across ${input.config.seeds.length} seeds (${input.config.seeds.join(", ")}), ` +
      `with ${input.config.numPirateShips} pirate ship(s) and ${input.config.numPoliceShips} police ship(s) added. ` +
      `Ratio guardrail band: 1.0 +/- ${input.config.ratioTolerance}.`,
  );
  lines.push("");
  lines.push("## Metrics by stage");
  lines.push("");
  lines.push("| Stage | Zero-stock pairs | Avg. outage length (days) | Avg. stockpile/minimum ratio |");
  lines.push("| --- | --- | --- | --- |");
  lines.push(metricsTable("Baseline", input.initialBaseline));
  lines.push(metricsTable("After Stage 0 (world-wide commodity balance)", input.afterStage0));
  lines.push(metricsTable("After Stage 1 (consumption modifiers)", input.afterStage1));
  lines.push(metricsTable("After Stage 2 (ships per Location)", input.stage2.final));
  lines.push(metricsTable("After Stage 3 (commodity-Location swaps)", input.afterStage3));
  lines.push("");

  lines.push("## Stage 0: world-wide commodity balance");
  lines.push("");
  if (input.stage0.rescaledCommodities.length === 0) {
    lines.push("No commodity had both a producer and a consumer to balance -- nothing changed.");
  } else {
    const n = input.stage0.rescaledCommodities.length;
    lines.push(
      `Rescaled ${n} ${n === 1 ? "commodity's" : "commodities'"} produced/consumed modifiers toward ` +
        "the midpoint of world-wide total production and consumption:",
    );
    lines.push("");
    lines.push("| Commodity | Produced/day (before) | Consumed/day (before) | Produced/day (after) | Consumed/day (after) |");
    lines.push("| --- | --- | --- | --- | --- |");
    const afterByCommodity = new Map(input.stage0.totalsAfter.map((t) => [t.commodity, t]));
    for (const before of input.stage0.totalsBefore) {
      if (!input.stage0.rescaledCommodities.includes(before.commodity)) continue;
      const after = afterByCommodity.get(before.commodity);
      lines.push(
        `| ${before.commodity} | ${before.totalProduced.toFixed(2)} | ${before.totalConsumed.toFixed(2)} | ` +
          `${after?.totalProduced.toFixed(2) ?? "n/a"} | ${after?.totalConsumed.toFixed(2) ?? "n/a"} |`,
      );
    }
  }
  lines.push("");

  lines.push("## Stage 1: consumption-modifier changes");
  lines.push("");
  if (input.stage1Changes.length === 0) {
    lines.push("No consumption-modifier changes were accepted.");
  } else {
    lines.push("| Location | Commodity | From | To |");
    lines.push("| --- | --- | --- | --- |");
    for (const c of input.stage1Changes) {
      lines.push(`| ${c.location} | ${c.commodity} | ${c.fromModifier.toFixed(3)} | ${c.toModifier.toFixed(3)} |`);
    }
  }
  lines.push("");

  lines.push("## Stage 2: ships-per-Location ratio");
  lines.push("");
  if (input.stage2.changed) {
    lines.push(
      `Recommended change: **${input.stage2.startingRatio} -> ${input.stage2.finalRatio.toFixed(2)}** ships per Location.`,
    );
    lines.push("");
    lines.push(
      "This is a build parameter (`targetShipsPerLocation`), not part of the World JSON schema -- it isn't reflected " +
        "in the tuned JSON/diff. Pass it when building this World, e.g. via `buildWorldFromJson(text, " +
        `{ targetShipsPerLocation: ${input.stage2.finalRatio.toFixed(2)} })\`.`,
    );
  } else {
    lines.push(`No improvement found -- kept at ${input.stage2.startingRatio} ships per Location.`);
  }
  lines.push("");

  lines.push("## Stage 3: commodity-Location swaps");
  lines.push("");
  if (input.stage3Changes.length === 0) {
    lines.push("No commodity-Location swaps were accepted.");
  } else {
    lines.push("| Commodity | Moved from | Moved to | In exchange for |");
    lines.push("| --- | --- | --- | --- |");
    for (const c of input.stage3Changes) {
      lines.push(`| ${c.commodity} | ${c.fromLocation} | ${c.toLocation} | ${c.inExchangeFor} |`);
    }
  }
  lines.push("");

  lines.push("## Output files");
  lines.push("");
  if (input.tunedJsonPath !== null && input.diffPath !== null) {
    lines.push(`- Tuned World JSON: \`${input.tunedJsonPath}\``);
    lines.push(`- Unified diff: \`${input.diffPath}\` (apply with \`git apply\` or \`patch -p0\`)`);
  } else {
    lines.push("No JSON-level changes were made (Stages 0/1/3 found nothing to change), so no tuned JSON or diff was written.");
  }
  lines.push("");

  return lines.join("\n");
}
