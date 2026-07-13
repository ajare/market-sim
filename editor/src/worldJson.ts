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
  Commodity, CommodityType, EditorCompany, EditorLocation, EditorRoute, PoliticalEntity,
} from "./types";
import { COMMODITY_TYPES, DEFAULT_COMMODITY_TYPE } from "./types";
import {
  DEFAULT_DISTANCE_MODE, DEFAULT_GLOBE_LON_SPAN, defaultGlobeRadius, type DistanceMode,
} from "./distance";
import { DEFAULT_NATIONALITY, NATIONALITIES, type Nationality } from "./nameGenerators";

/** Current on-disk schema version -- bump if the shape changes in a way old files can't satisfy. Version 3 added distanceMode/globeRadius/globeLonSpan; version 4 added PoliticalEntity.nationality (absent in older files, which default to English); version 5 added EditorCompany.homeLocationId (absent in older files, which get one computed on load -- see useEditorStore.loadWorld); version 6 added Commodity.type (absent in older files, which default to "General"). */
export const WORLD_JSON_VERSION = 6;

/** The full authored World in the editor's own (normalized) coordinate space -- UI-only state like selection is excluded. */
export interface EditorWorld {
  version: number;
  worldScale: number;
  /** How distances are measured -- see distance.ts. Defaults to "flat" for files predating this field. */
  distanceMode: DistanceMode;
  globeRadius: number;
  globeLonSpan: number;
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
  const distanceMode: DistanceMode = obj.distanceMode === "globe" ? "globe" : DEFAULT_DISTANCE_MODE;
  const globeRadius =
    typeof obj.globeRadius === "number" && Number.isFinite(obj.globeRadius) && obj.globeRadius > 0
      ? obj.globeRadius
      : defaultGlobeRadius(worldScale);
  const globeLonSpan =
    typeof obj.globeLonSpan === "number" && Number.isFinite(obj.globeLonSpan) && obj.globeLonSpan > 0
      ? obj.globeLonSpan
      : DEFAULT_GLOBE_LON_SPAN;
  return {
    version: typeof obj.version === "number" ? obj.version : WORLD_JSON_VERSION,
    worldScale,
    distanceMode,
    globeRadius,
    globeLonSpan,
    // Default a missing/invalid nationality (files predating v4) to English.
    politicalEntities: asArray<PoliticalEntity>(obj.politicalEntities).map((pe) => ({
      ...pe,
      nationality: (NATIONALITIES as string[]).includes((pe as { nationality?: string }).nationality ?? "")
        ? ((pe as unknown as { nationality: Nationality }).nationality)
        : DEFAULT_NATIONALITY,
    })),
    locations: locationsToNormalized(asArray<EditorLocation>(obj.locations), worldScale),
    // Default a missing/invalid type (files predating v6) to "General".
    commodities: asArray<Commodity>(obj.commodities).map((c) => ({
      ...c,
      type: (COMMODITY_TYPES as readonly string[]).includes((c as { type?: string }).type ?? "")
        ? ((c as unknown as { type: CommodityType }).type)
        : DEFAULT_COMMODITY_TYPE,
    })),
    companies: asArray<EditorCompany>(obj.companies),
    routes: routesToNormalized(asArray<EditorRoute>(obj.routes), worldScale),
  };
}

/** The sliver of the File System Access API (Chromium-only) this module needs -- not yet in lib.dom.d.ts, so declared locally rather than widening the whole global Window type. */
interface FileSystemWritableFileStream {
  write(data: BlobPart): Promise<void>;
  close(): Promise<void>;
}
interface FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>;
}
interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: Array<{ description: string; accept: Record<string, string[]> }>;
}
type ShowSaveFilePicker = (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;

/** Unconditional browser download via a synthetic anchor click -- lands wherever the browser's default download location is, with no picker. Used as the fallback where showSaveFilePicker isn't available. */
export function downloadJson(json: string, filename: string): void {
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Saves `json` to disk, prompting the user for a filename and location via
 * the File System Access API's save dialog where the browser supports it
 * (Chromium-based browsers); falls back to the no-dialog `downloadJson` on
 * Firefox/Safari, which lack that API. A user-cancelled dialog resolves
 * quietly (no error, no fallback download) rather than propagating the
 * picker's AbortError.
 */
export async function saveJsonWithDialog(json: string, suggestedName: string): Promise<void> {
  const showSaveFilePicker = (window as unknown as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker;
  if (typeof showSaveFilePicker !== "function") {
    downloadJson(json, suggestedName);
    return;
  }
  let handle: FileSystemFileHandle;
  try {
    handle = await showSaveFilePicker({
      suggestedName,
      types: [{ description: "World JSON", accept: { "application/json": [".json"] } }],
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return;
    throw err;
  }
  const writable = await handle.createWritable();
  await writable.write(json);
  await writable.close();
}
