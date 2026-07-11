/**
 * Whole-World JSON export/import for the editor. One file captures the
 * entire authored World -- world scale, PoliticalEntities, Locations,
 * Commodities, Companies, and Routes -- so it round-trips losslessly back
 * into the editor (see useEditorStore.loadWorld).
 *
 * Locations and route control points live in the editor as NORMALIZED canvas
 * coordinates in [0,1]; the exported JSON stores their WORLD positions
 * (normalized * worldScale), which is what the simulation consumes (see
 * src/sim/buildWorldFromJson.ts). worldToJson multiplies up on the way out and
 * parseWorldJson divides back down on the way in, so the in-memory EditorWorld
 * this module hands the store is always normalized.
 */
import type {
  Commodity, EditorCompany, EditorLocation, EditorRoute, PoliticalEntity,
} from "./types";

/** Current on-disk schema version -- bump if the shape changes in a way old files can't satisfy. */
export const WORLD_JSON_VERSION = 2;

/** The full authored World in the editor's own (normalized) coordinate space -- UI-only state like selection is excluded. */
export interface EditorWorld {
  version: number;
  worldScale: number;
  politicalEntities: PoliticalEntity[];
  locations: EditorLocation[];
  commodities: Commodity[];
  companies: EditorCompany[];
  routes: EditorRoute[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Locations with their normalized [0,1] x/y scaled up to world positions (normalized * worldScale). */
function locationsToWorld(locations: EditorLocation[], scale: number): EditorLocation[] {
  return locations.map((loc) => ({ ...loc, x: round2(loc.x * scale), y: round2(loc.y * scale) }));
}

/** Routes with their control points' normalized x/y scaled up to world positions. */
function routesToWorld(routes: EditorRoute[], scale: number): EditorRoute[] {
  return routes.map((r) => ({
    ...r,
    controlPoints: r.controlPoints.map((p) => ({ ...p, x: round2(p.x * scale), y: round2(p.y * scale) })),
  }));
}

export function worldToJson(world: Omit<EditorWorld, "version">): string {
  const scale = world.worldScale;
  const payload: EditorWorld = {
    version: WORLD_JSON_VERSION,
    ...world,
    locations: locationsToWorld(world.locations, scale),
    routes: routesToWorld(world.routes, scale),
  };
  return JSON.stringify(payload, null, 2);
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** World-position locations divided back down to normalized [0,1] by worldScale. */
function locationsToNormalized(locations: EditorLocation[], scale: number): EditorLocation[] {
  return locations.map((loc) => ({ ...loc, x: loc.x / scale, y: loc.y / scale }));
}

function routesToNormalized(routes: EditorRoute[], scale: number): EditorRoute[] {
  return routes.map((r) => ({
    ...r,
    controlPoints: r.controlPoints.map((p) => ({ ...p, x: p.x / scale, y: p.y / scale })),
  }));
}

/**
 * Parses a World JSON string into an EditorWorld (normalized coordinates),
 * throwing an Error with a human-readable message on anything that isn't a
 * recognizable World file. Individual arrays default to empty rather than
 * throwing, so a partial file (e.g. Locations but no Companies yet) still
 * imports cleanly.
 */
export function parseWorldJson(text: string): EditorWorld {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Not valid JSON.");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Expected a World object at the top level.");
  }
  const obj = raw as Record<string, unknown>;
  const worldScale =
    typeof obj.worldScale === "number" && Number.isFinite(obj.worldScale) && obj.worldScale > 0
      ? obj.worldScale
      : undefined;
  if (worldScale === undefined) {
    throw new Error("Missing or invalid 'worldScale'.");
  }
  return {
    version: typeof obj.version === "number" ? obj.version : WORLD_JSON_VERSION,
    worldScale,
    politicalEntities: asArray<PoliticalEntity>(obj.politicalEntities),
    locations: locationsToNormalized(asArray<EditorLocation>(obj.locations), worldScale),
    commodities: asArray<Commodity>(obj.commodities),
    companies: asArray<EditorCompany>(obj.companies),
    routes: routesToNormalized(asArray<EditorRoute>(obj.routes), worldScale),
  };
}

export function downloadJson(json: string, filename: string): void {
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
