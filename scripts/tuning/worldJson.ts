/**
 * Loose, local description of the editor's exported World JSON shape (mirrors
 * editor/src/worldJson.ts's EditorWorld / editor/src/types.ts, and
 * src/sim/buildWorldFromJson.ts's own local Json* interfaces) -- kept as a
 * standalone copy rather than imported across app boundaries, same reasoning
 * as buildWorldFromJson.ts's own comment: the editor, the sim, and this
 * script are separate things, and this script only needs to read/mutate a
 * few specific fields, not the whole authored shape.
 */
import { readFileSync, writeFileSync } from "node:fs";

export interface WorldJsonLocation {
  id: string;
  name: string;
  x: number;
  y: number;
  politicalEntityId: string;
  producedCommodities: Record<string, number>;
  consumedCommodities: Record<string, number>;
  stockpiles: Record<string, number>;
  minStockpiles: Record<string, number>;
  basePriceModifiers: Record<string, number>;
  fuelPrice: number;
  terminalTypes: string[];
  [key: string]: unknown;
}

export interface WorldJsonCommodity {
  name: string;
  basePrice: number;
  productionRate: number;
  consumptionRate: number;
}

/** Permissive top-level shape -- only locations/commodities are read/mutated by the tuning stages; everything else (companies, politicalEntities, routes, worldScale, distanceMode, ...) is carried through untouched via [key: string]: unknown. */
export interface WorldJson {
  locations: WorldJsonLocation[];
  commodities: WorldJsonCommodity[];
  [key: string]: unknown;
}

export function readWorldJson(path: string): WorldJson {
  const text = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} is not a World object.`);
  }
  const world = parsed as WorldJson;
  if (!Array.isArray(world.locations) || world.locations.length === 0) {
    throw new Error(`${path} has no locations.`);
  }
  return world;
}

export function writeWorldJson(path: string, world: WorldJson): void {
  writeFileSync(path, `${JSON.stringify(world, null, 2)}\n`, "utf8");
}

/** A deep, independent copy -- every stage clones before mutating so a rejected candidate never corrupts the state the next candidate is tried from. */
export function cloneWorldJson(world: WorldJson): WorldJson {
  return structuredClone(world);
}
