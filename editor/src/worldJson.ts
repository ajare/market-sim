/**
 * Whole-World JSON export/import for the editor. One file captures the
 * entire authored World -- world size, PoliticalEntities, Locations,
 * Commodities, Companies, and Routes -- so it round-trips losslessly back
 * into the editor (see useEditorStore.loadWorld). This replaces the old
 * per-entity CSV export: JSON keeps the nested shapes (commodity maps, fleet
 * rosters, route control points) intact without any column flattening.
 */
import type {
  Commodity, EditorCompany, EditorLocation, EditorRoute, PoliticalEntity,
} from "./types";

/** Current on-disk schema version -- bump if the shape changes in a way old files can't satisfy. */
export const WORLD_JSON_VERSION = 1;

/** The full authored World, exactly as it round-trips through a JSON file (UI-only state like selection is excluded). */
export interface EditorWorld {
  version: number;
  worldWidth: number;
  politicalEntities: PoliticalEntity[];
  locations: EditorLocation[];
  commodities: Commodity[];
  companies: EditorCompany[];
  routes: EditorRoute[];
}

export function worldToJson(world: Omit<EditorWorld, "version">): string {
  const payload: EditorWorld = { version: WORLD_JSON_VERSION, ...world };
  return JSON.stringify(payload, null, 2);
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Parses a World JSON string into an EditorWorld, throwing an Error with a
 * human-readable message on anything that isn't a recognizable World file.
 * Individual arrays default to empty rather than throwing, so a partial file
 * (e.g. Locations but no Companies yet) still imports cleanly.
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
  const worldWidth = typeof obj.worldWidth === "number" && Number.isFinite(obj.worldWidth) ? obj.worldWidth : undefined;
  if (worldWidth === undefined) {
    throw new Error("Missing or invalid 'worldWidth'.");
  }
  return {
    version: typeof obj.version === "number" ? obj.version : WORLD_JSON_VERSION,
    worldWidth,
    politicalEntities: asArray<PoliticalEntity>(obj.politicalEntities),
    locations: asArray<EditorLocation>(obj.locations),
    commodities: asArray<Commodity>(obj.commodities),
    companies: asArray<EditorCompany>(obj.companies),
    routes: asArray<EditorRoute>(obj.routes),
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
