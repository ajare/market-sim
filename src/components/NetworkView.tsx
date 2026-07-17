import { useEffect, useMemo, useRef, useState } from "react";
import { useSimStore } from "../state/useSimStore";
import { LOCATION_COORDINATES, FUEL_DEPOT_NAMES, travelDaysBetween, getDisplayDistanceUnit } from "../sim/worldData";
import { convertSpeed, speedUnitLabel } from "@market-sim/shared/units";
import { ROUTES, getRoute, routeTravelDays, type Point, type Route, type RouteType } from "../sim/routes";
import { Ship, WagonTrain, Plane, type Transport } from "../sim/transport";
import type { Captain } from "../sim/captain";
import { PirateBrigade, PoliceFleet, SoloTrader, Company } from "../sim/faction";
import type { Location, TerminalType } from "../sim/location";
import type { PoliticalEntity } from "../sim/politicalEntity";
import type { MarketEvent } from "../sim/events";
import { MAX_LOCATIONS, type World } from "../sim/world";
import { findShortestPath, pathNodeSequence } from "../sim/pathfinding";
import type { WeatherSystem, Position, Bounds } from "../sim/weather";
import type { Storm } from "../sim/storms";

/**
 * Sensible default max-distance/detour-distance thresholds for the new-Location
 * route planner (see World.addLocation), derived from the CURRENTLY loaded
 * world's own route lengths rather than a fixed constant -- the procedural
 * world's coordinate scale and a custom JSON-imported world's can differ
 * wildly (see CLAUDE.md's distance modes), so a single hardcoded number would
 * either connect nothing or connect everything depending on which world is
 * loaded. maxDistance is the median Sea route length (falling back to the
 * median of every route, then to a fraction of the world's bounding-box
 * diagonal if there are no routes at all yet); detourDistance is 20% of that,
 * echoing the editor's own 10:50 detour:max default ratio.
 */
function deriveDefaultThresholds(): { maxDistance: number; detourDistance: number } {
  const seaLengths: number[] = [];
  const allLengths: number[] = [];
  for (const routeList of ROUTES.values()) {
    for (const route of routeList) {
      allLengths.push(route.distance);
      if (route.routeType === "Sea") seaLengths.push(route.distance);
    }
  }
  const sample = seaLengths.length > 0 ? seaLengths : allLengths;
  let maxDistance: number;
  if (sample.length > 0) {
    const sorted = [...sample].sort((a, b) => a - b);
    maxDistance = sorted[Math.floor(sorted.length / 2)];
  } else {
    const coords = Object.values(LOCATION_COORDINATES);
    const xs = coords.map(([x]) => x);
    const ys = coords.map(([, y]) => y);
    const diagonal = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    maxDistance = diagonal / 3;
  }
  return { maxDistance: Math.round(maxDistance), detourDistance: Math.round(maxDistance * 0.2) };
}

/**
 * Every node a Captain's current voyage still passes through, from where it
 * is right now to its ultimate destination -- recomputed fresh via
 * findShortestPath rather than read off `Captain.path`, since that field
 * only advances leg-by-leg for cargo-carrying trips (see Captain.arrive) and
 * is left stale during a reposition, where the whole multi-hop trip is
 * modeled as one continuous transit with no per-leg bookkeeping at all (see
 * Captain.departEmptyTo). Empty for a Captain not actively routed.
 */
function captainRouteNodes(captain: Captain): string[] {
  if (captain.transport === null || captain.destination === null) return [];
  const finalDestination = captain.cargo !== null ? captain.cargo.destination : captain.destination;
  if (finalDestination === captain.locationName) return [];
  const path = findShortestPath(captain.locationName, finalDestination, (r) => captain.transport!.canUseRoute(r));
  if (path === null) return [captain.locationName, finalDestination];
  return pathNodeSequence(captain.locationName, path);
}

/**
 * The point `fraction` (0-1) of the way along a multi-hop `path` (as
 * returned by findShortestPath, origin-to-destination edge order starting at
 * `startNode`), by cumulative Route distance -- walks leg by leg rather than
 * a single Route's pointAtFraction, since a reposition's `path` may span
 * several Route edges with no single curve connecting its endpoints (see
 * Captain.departEmptyTo's "one continuous transit" comment). Used so an
 * in-transit ship with no direct Route between its location and destination
 * is drawn following its actual route through every intermediate stop,
 * rather than a straight line cutting across them.
 */
function pointAlongPath(path: Route[], startNode: string, fraction: number): Point {
  const totalDistance = path.reduce((sum, r) => sum + r.distance, 0);
  let remaining = Math.min(1, Math.max(0, fraction)) * totalDistance;
  let node = startNode;
  for (let i = 0; i < path.length; i++) {
    const leg = path[i];
    if (i === path.length - 1 || remaining <= leg.distance) {
      const legFraction = leg.distance > 0 ? Math.min(1, remaining / leg.distance) : 1;
      return leg.pointAtFraction(leg.origin === node ? legFraction : 1 - legFraction);
    }
    remaining -= leg.distance;
    node = leg.origin === node ? leg.destination : leg.origin;
  }
  return LOCATION_COORDINATES[startNode];
}

/** Number of distinct hues in the --political-entity-N categorical palette (index.css) -- PoliticalEntity colors cycle through these by index if there are more political entities than slots. */
const POLITICAL_ENTITY_PALETTE_SIZE = 8;

const ROUTE_COLORS: Record<RouteType, string> = {
  Sea: "#3b82f6",
  Land: "#b45309",
  Air: "#10b981",
  Space: "#a855f7",
  Road: "#6b7280",
  Railroad: "#0891b2",
  // Foot/porter trails -- distinct earthy olive-green from Land's brown.
  Trail: "#65a30d",
};

/** Ship markers are colored by the operating Faction, not transport kind. */
const FACTION_COLORS = {
  pirate: "#ef4444",
  police: "#22c55e",
  company: "#3b82f6",
  soloTrader: "#eab308",
};

/**
 * A ship's marker color signals who's operating it: pirates red, police
 * green, company (pooled-cash fleets) blue, solo traders yellow. SoloTrader is
 * checked before Company since it's a Company subclass.
 */
function factionColor(captain: Captain, fallback: string): string {
  const company = captain.company;
  if (company instanceof PirateBrigade) return FACTION_COLORS.pirate;
  if (company instanceof PoliceFleet) return FACTION_COLORS.police;
  if (company instanceof SoloTrader) return FACTION_COLORS.soloTrader;
  if (company instanceof Company) return FACTION_COLORS.company;
  return fallback;
}

function transportKind(transport: Transport): string {
  if (transport instanceof Ship) return "Ship";
  if (transport instanceof WagonTrain) return "Train";
  if (transport instanceof Plane) return "Plane";
  return "Transport";
}

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === "" ? fallback : value;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

type OverlayMetric = "temperature" | "windSpeed" | "rainfall";

/**
 * A calendar Date converted to WeatherSystem's timeOfYear convention (0 =
 * Jan 1, 1 = the following Jan 1 -- see weather.ts), dividing by the actual
 * number of days in that specific year so a leap year doesn't skew the
 * fraction.
 */
function timeOfYearFromDate(date: Date): number {
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 1);
  const startOfNextYear = Date.UTC(date.getUTCFullYear() + 1, 0, 1);
  return (date.getTime() - startOfYear) / (startOfNextYear - startOfYear);
}

function sampleMetric(weather: WeatherSystem, position: Position, metric: OverlayMetric, timeOfYear: number): number {
  switch (metric) {
    case "temperature":
      return weather.temperature(timeOfYear, position);
    case "windSpeed":
      return weather.windSpeed(timeOfYear, position);
    case "rainfall":
      return weather.rainfall(timeOfYear, position);
  }
}

/** The (noise-sampled) values of an evenly-spaced grid of today's weather points spanning a WeatherSystem's bounds, plus their observed range. */
interface WeatherGrid {
  cols: number;
  rows: number;
  bounds: Bounds;
  values: Float32Array;
  min: number;
  max: number;
}

/** Hard ceiling on grid cells regardless of the requested spacing, so a tiny spacing value on a huge map can't hang the tab -- see buildWeatherGrid. */
const MAX_WEATHER_GRID_CELLS = 300 * 300;

/**
 * Samples `metric` (temperature or wind speed) as of `timeOfYear` on an
 * evenly-spaced grid across a WeatherSystem's bounds, `spacingUnits`
 * world-units apart on each axis (clamped up, never down, so the actual cell
 * count never exceeds MAX_WEATHER_GRID_CELLS). This is the slow part (noise
 * sampling) -- kept separate from colorizing it into pixels so the color
 * mapping can react to a live theme change without re-sampling the whole
 * grid (see the weatherGrid useMemo / draw()). Callers re-run this once per
 * simulated day (timeOfYear changes daily), so the overlay always reflects
 * today's actual weather rather than a static average.
 */
function buildWeatherGrid(weather: WeatherSystem, spacingUnits: number, metric: OverlayMetric, timeOfYear: number): WeatherGrid {
  const { bounds } = weather;
  const xSpan = Math.max(1, bounds.x1 - bounds.x0);
  const ySpan = Math.max(1, bounds.y1 - bounds.y0);
  let spacing = Math.max(1, spacingUnits);
  let cols = Math.floor(xSpan / spacing) + 1;
  let rows = Math.floor(ySpan / spacing) + 1;
  if (cols * rows > MAX_WEATHER_GRID_CELLS) {
    spacing = Math.sqrt((xSpan * ySpan) / MAX_WEATHER_GRID_CELLS);
    cols = Math.floor(xSpan / spacing) + 1;
    rows = Math.floor(ySpan / spacing) + 1;
  }

  const values = new Float32Array(cols * rows);
  let min = Infinity;
  let max = -Infinity;
  for (let ry = 0; ry < rows; ry++) {
    for (let cx = 0; cx < cols; cx++) {
      const x = bounds.x0 + cx * spacing;
      const y = bounds.y0 + ry * spacing;
      const v = sampleMetric(weather, { x, y }, metric, timeOfYear);
      values[ry * cols + cx] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return { cols, rows, bounds, values, min, max };
}

/** Overlay opacity for the weather raster -- translucent enough that routes/icons/labels drawn on top stay legible. */
const WEATHER_OVERLAY_ALPHA = 140;

/**
 * Colorizes a (cheap, already-sampled) WeatherGrid into a same-size offscreen
 * canvas, diverging blue (cold) -> neutral gray -> red (hot) across an
 * explicit [min, max] domain (its midpoint is the neutral point) -- diverging
 * because "cold vs hot" is a polarity, not a plain magnitude (see the
 * dataviz skill's diverging-pair guidance). The domain is passed in rather
 * than read off the grid's own observed min/max so a caller can pin it to a
 * fixed, physically-meaningful scale (e.g. temperature's 0-40 deg C) instead
 * of one that silently rescales between worlds. Re-run on every draw() call
 * (cheap: pure arithmetic over an already-computed grid) so a live theme
 * switch is reflected immediately, unlike the expensive noise sampling in
 * buildWeatherGrid.
 */
function colorizeDiverging(grid: WeatherGrid, min: number, max: number, cold: string, neutral: string, hot: string): HTMLCanvasElement {
  const [cr, cg, cb] = hexToRgb(cold);
  const [nr, ng, nb] = hexToRgb(neutral);
  const [hr, hg, hb] = hexToRgb(hot);
  const mid = (min + max) / 2;
  const range = max - min;

  const raster = document.createElement("canvas");
  raster.width = grid.cols;
  raster.height = grid.rows;
  const rctx = raster.getContext("2d")!;
  const imageData = rctx.createImageData(grid.cols, grid.rows);
  for (let i = 0; i < grid.values.length; i++) {
    const v = grid.values[i];
    let r = nr;
    let g = ng;
    let b = nb;
    if (range > 0) {
      if (v <= mid) {
        const t = Math.max(0, Math.min(1, (v - min) / (mid - min || 1)));
        r = cr + (nr - cr) * t;
        g = cg + (ng - cg) * t;
        b = cb + (nb - cb) * t;
      } else {
        const t = Math.max(0, Math.min(1, (v - mid) / (max - mid || 1)));
        r = nr + (hr - nr) * t;
        g = ng + (hg - ng) * t;
        b = nb + (hb - nb) * t;
      }
    }
    const o = i * 4;
    imageData.data[o] = r;
    imageData.data[o + 1] = g;
    imageData.data[o + 2] = b;
    imageData.data[o + 3] = WEATHER_OVERLAY_ALPHA;
  }
  rctx.putImageData(imageData, 0, 0);
  return raster;
}

/** Fixed color-scale domain for the temperature overlay, degrees Celsius -- see colorizeDiverging. */
const TEMPERATURE_SCALE_MIN_C = 0;
const TEMPERATURE_SCALE_MAX_C = 40;

/** Fixed color-scale domain for the rainfall overlay -- WeatherSystem.rainfall is already a natural [0,1] intensity, so (unlike wind speed) there's a real fixed scale to pin the ramp to rather than rescaling per-World. */
const RAINFALL_SCALE_MIN = 0;
const RAINFALL_SCALE_MAX = 1;

/**
 * Colorizes a WeatherGrid into a same-size offscreen canvas as a single-hue
 * sequential ramp, light (near `min`) -> dark (near `max`) -- a pure
 * magnitude with no "opposite pole" the way cold/hot are, so this is a
 * sequential rather than diverging encoding (see the dataviz skill's
 * color-formula guidance). The domain is passed in rather than read off the
 * grid's own observed min/max so a caller can pin it to a fixed, physically-
 * meaningful scale (e.g. rainfall's natural 0-1 intensity) instead of one
 * that silently rescales between worlds -- mirrors colorizeDiverging's own
 * explicit-domain reasoning.
 */
function colorizeSequential(grid: WeatherGrid, min: number, max: number, low: string, high: string): HTMLCanvasElement {
  const [lr, lg, lb] = hexToRgb(low);
  const [hr, hg, hb] = hexToRgb(high);
  const range = max - min;

  const raster = document.createElement("canvas");
  raster.width = grid.cols;
  raster.height = grid.rows;
  const rctx = raster.getContext("2d")!;
  const imageData = rctx.createImageData(grid.cols, grid.rows);
  for (let i = 0; i < grid.values.length; i++) {
    const v = grid.values[i];
    const t = range > 0 ? Math.max(0, Math.min(1, (v - min) / range)) : 0;
    const o = i * 4;
    imageData.data[o] = lr + (hr - lr) * t;
    imageData.data[o + 1] = lg + (hg - lg) * t;
    imageData.data[o + 2] = lb + (hb - lb) * t;
    imageData.data[o + 3] = WEATHER_OVERLAY_ALPHA;
  }
  rctx.putImageData(imageData, 0, 0);
  return raster;
}

/** An evenly-spaced grid of today's wind DIRECTIONS (degrees, not a magnitude) -- rendered as rotated arrow icons rather than a colorized raster, so it's kept as its own grid shape rather than reusing WeatherGrid's min/max-normalized value array. */
interface DirectionGrid {
  cols: number;
  rows: number;
  bounds: Bounds;
  /** The actual (possibly clamped-up) spacing between sample points -- see buildDirectionGrid. Cell (cx, ry)'s world position is bounds.x0 + cx*spacing, bounds.y0 + ry*spacing. */
  spacing: number;
  degrees: Float32Array;
}

/**
 * Hard ceiling on grid cells for the wind-direction overlay -- much lower
 * than MAX_WEATHER_GRID_CELLS (raster pixels) because each cell here is an
 * individually drawn, individually legible arrow icon: packed as densely as
 * the raster cap allows, arrows would just overlap into an unreadable smear.
 */
const MAX_DIRECTION_GRID_CELLS = 30 * 30;

/**
 * Samples WeatherSystem.windDirection as of `timeOfYear` on an evenly-spaced
 * grid -- see buildWeatherGrid, whose spacing-clamping logic this mirrors
 * (against MAX_DIRECTION_GRID_CELLS instead) and whose "re-run once per
 * simulated day" cadence this follows too.
 */
function buildDirectionGrid(weather: WeatherSystem, spacingUnits: number, timeOfYear: number): DirectionGrid {
  const { bounds } = weather;
  const xSpan = Math.max(1, bounds.x1 - bounds.x0);
  const ySpan = Math.max(1, bounds.y1 - bounds.y0);
  let spacing = Math.max(1, spacingUnits);
  let cols = Math.floor(xSpan / spacing) + 1;
  let rows = Math.floor(ySpan / spacing) + 1;
  if (cols * rows > MAX_DIRECTION_GRID_CELLS) {
    spacing = Math.sqrt((xSpan * ySpan) / MAX_DIRECTION_GRID_CELLS);
    cols = Math.floor(xSpan / spacing) + 1;
    rows = Math.floor(ySpan / spacing) + 1;
  }

  const degrees = new Float32Array(cols * rows);
  for (let ry = 0; ry < rows; ry++) {
    for (let cx = 0; cx < cols; cx++) {
      const x = bounds.x0 + cx * spacing;
      const y = bounds.y0 + ry * spacing;
      degrees[ry * cols + cx] = weather.windDirection(timeOfYear, { x, y });
    }
  }
  return { cols, rows, bounds, spacing, degrees };
}

/**
 * Draws one wind-direction arrow centered at (x, y), rotated so it points
 * `angleDegrees` clockwise from north -- matching averageWindDirection's
 * convention and canvas's own clockwise-positive rotate(), so 0 deg points
 * straight up on screen with no sign flip needed.
 */
function drawWindArrow(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, angleDegrees: number, color: string): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((angleDegrees * Math.PI) / 180);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.3;
  ctx.lineCap = "round";

  ctx.beginPath();
  ctx.moveTo(0, size * 0.55);
  ctx.lineTo(0, -size * 0.55);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(0, -size * 0.62);
  ctx.lineTo(-size * 0.26, -size * 0.12);
  ctx.lineTo(size * 0.26, -size * 0.12);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

/** Anchor -- Port (and Platform, the other Sea-compatible terminal). Ring, shaft, crossbar, and two hook curls. */
function drawAnchor(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.lineCap = "round";

  ctx.beginPath();
  ctx.arc(x, y - r * 0.75, r * 0.28, 0, Math.PI * 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x, y - r * 0.47);
  ctx.lineTo(x, y + r * 0.8);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x - r * 0.5, y - r * 0.05);
  ctx.lineTo(x + r * 0.5, y - r * 0.05);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(x - r * 0.45, y + r * 0.5, r * 0.4, -Math.PI * 0.15, Math.PI * 0.65);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x + r * 0.45, y + r * 0.5, r * 0.4, Math.PI * 0.35, Math.PI * 1.15, true);
  ctx.stroke();
}

/** Barrel -- Fuel depot. A filled rounded rectangle with two horizontal bands. */
function drawBarrel(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  const w = r * 1.1;
  const h = r * 1.7;
  const left = x - w / 2;
  const top = y - h / 2;

  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(left, top, w, h, w * 0.3);
  } else {
    ctx.rect(left, top, w, h);
  }
  ctx.fillStyle = color;
  ctx.fill();

  ctx.strokeStyle = "rgba(0, 0, 0, 0.3)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left, top + h * 0.34);
  ctx.lineTo(left + w, top + h * 0.34);
  ctx.moveTo(left, top + h * 0.67);
  ctx.lineTo(left + w, top + h * 0.67);
  ctx.stroke();
}

/** Wheel -- Wagon yard. A rim circle with six spokes and a small hub. */
function drawWheel(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  const rim = r * 0.85;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.3;

  ctx.beginPath();
  ctx.arc(x, y, rim, 0, Math.PI * 2);
  ctx.stroke();

  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(angle) * rim, y + Math.sin(angle) * rim);
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.arc(x, y, r * 0.15, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

/** Plane -- Airport. A filled dart/paper-airplane silhouette pointing north. */
function drawPlane(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r * 0.15, y - r * 0.2);
  ctx.lineTo(x + r * 0.9, y + r * 0.15);
  ctx.lineTo(x + r * 0.15, y + r * 0.05);
  ctx.lineTo(x + r * 0.25, y + r * 0.75);
  ctx.lineTo(x, y + r * 0.5);
  ctx.lineTo(x - r * 0.25, y + r * 0.75);
  ctx.lineTo(x - r * 0.15, y + r * 0.05);
  ctx.lineTo(x - r * 0.9, y + r * 0.15);
  ctx.lineTo(x - r * 0.15, y - r * 0.2);
  ctx.closePath();
  ctx.fill();
}

/** Hut -- Market (native villages). A filled triangular roof over a small rectangular base. */
function drawHut(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  const baseW = r * 1.2;
  const baseH = r * 0.7;
  const baseTop = y + r * 0.15;

  ctx.fillStyle = color;
  ctx.fillRect(x - baseW / 2, baseTop, baseW, baseH);

  ctx.beginPath();
  ctx.moveTo(x - baseW * 0.7, baseTop);
  ctx.lineTo(x, y - r * 0.8);
  ctx.lineTo(x + baseW * 0.7, baseTop);
  ctx.closePath();
  ctx.fill();
}

/**
 * Draws the icon for whichever terminal facility best represents this
 * Location, in priority order: fuel depots (their own category, tracked by
 * name rather than TerminalType) get a barrel; otherwise Airport (plane)
 * beats Wagon yard (wheel) beats Market (hut) beats Port/Platform (anchor,
 * the two Sea-compatible terminal types) -- picked so the rarer, more
 * specific terminal wins over the near-universal Port when a Location has
 * more than one (every non-depot Location has Port plus 0-2 others; only
 * Platform is mutually exclusive with every other type; a village is
 * Market-only in practice, so this ordering rarely matters for it).
 */
function drawLocationIcon(
  ctx: CanvasRenderingContext2D,
  loc: { terminalTypes: ReadonlySet<TerminalType> },
  isDepot: boolean,
  x: number,
  y: number,
  r: number,
  color: string,
): void {
  if (isDepot) drawBarrel(ctx, x, y, r, color);
  else if (loc.terminalTypes.has("Airport")) drawPlane(ctx, x, y, r, color);
  else if (loc.terminalTypes.has("Wagon yard")) drawWheel(ctx, x, y, r, color);
  else if (loc.terminalTypes.has("Market")) drawHut(ctx, x, y, r, color);
  else drawAnchor(ctx, x, y, r, color);
}

interface Marker {
  captain: Captain;
  x: number;
  y: number;
  r: number;
}

interface LocationMarker {
  location: Location;
  x: number;
  y: number;
  r: number;
}

interface StormMarker {
  storm: Storm;
  x: number;
  y: number;
  r: number;
}

interface CaptainHoverState {
  kind: "captain";
  captain: Captain;
  x: number;
  y: number;
}

interface LocationHoverState {
  kind: "location";
  location: Location;
  atLocation: number;
  inTransit: number;
  events: MarketEvent[];
  x: number;
  y: number;
}

interface StormHoverState {
  kind: "storm";
  storm: Storm;
  x: number;
  y: number;
}

type HoverState = CaptainHoverState | LocationHoverState | StormHoverState;

/** Every currently active MarketEvent touching any commodity market at `location`, deduped by name+daysRemaining -- a broad (Global/Location/Worldwide) event is applied as a separate MarketEvent instance to each affected market, so the same logical event otherwise shows up once per commodity/side. */
function locationActiveEvents(world: World, location: string): MarketEvent[] {
  const seen = new Set<string>();
  const events: MarketEvent[] = [];
  for (const market of [...world.buyMarkets.values(), ...world.sellMarkets.values()]) {
    if (market.locationName !== location) continue;
    for (const event of market.activeEvents) {
      const key = `${event.name}|${event.daysRemaining}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(event);
    }
  }
  return events;
}

/** State for the click-to-place popup -- mirrors the editor's WorldCanvas placeMenu. Pixel coords position the popup; world coords (already inverse-projected) are what gets passed to World.addLocation. */
interface PlaceMenuState {
  pixelX: number;
  pixelY: number;
  worldX: number;
  worldY: number;
  detourDistance: number;
  maxDistance: number;
}

export function NetworkView() {
  const world = useSimStore((s) => s.world);
  const version = useSimStore((s) => s.version);
  const date = useSimStore((s) => s.date);
  const politicalEntities = useSimStore((s) => s.politicalEntities);
  const addLocationAction = useSimStore((s) => s.addLocation);
  const selectedCaptain = useSimStore((s) => s.selectedCaptain);
  const selectTransport = useSimStore((s) => s.selectTransport);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [placeMenu, setPlaceMenu] = useState<PlaceMenuState | null>(null);
  const [overlayMode, setOverlayMode] = useState<OverlayMetric | "none">("none");
  const [showWindDirection, setShowWindDirection] = useState(false);
  const [overlaySpacing, setOverlaySpacing] = useState(50);

  // Re-sampled every simulated day (date advances once per step()) so the
  // overlay always shows TODAY's actual weather, not a static average --
  // colorizing it into pixels (cheap, theme-reactive) still happens
  // separately in draw().
  const weatherGrid = useMemo(() => {
    if (world === null || world.weather === null || overlayMode === "none" || date === null) return null;
    return buildWeatherGrid(world.weather, overlaySpacing, overlayMode, timeOfYearFromDate(date));
  }, [world, overlayMode, overlaySpacing, date]);

  // Independent of the raster dropdown above -- a separate toggle, drawn on
  // top of everything else (see draw()), so it can be combined with a
  // temperature/wind-speed raster or shown on its own. Also re-sampled daily
  // (see weatherGrid above).
  const directionGrid = useMemo(() => {
    if (world === null || world.weather === null || !showWindDirection || date === null) return null;
    return buildDirectionGrid(world.weather, overlaySpacing, timeOfYearFromDate(date));
  }, [world, showWindDirection, overlaySpacing, date]);

  // Closing the popup on Escape, same as the editor's placement menu.
  useEffect(() => {
    if (placeMenu === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPlaceMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [placeMenu]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (canvas === null || container === null || world === null) return;
    const locations = world.locations;

    const politicalEntityIndex = new Map<PoliticalEntity, number>();
    politicalEntities.forEach((politicalEntity, i) => politicalEntityIndex.set(politicalEntity, i));

    const captainsByLocation = new Map<string, Captain[]>();
    for (const captain of world.captains) {
      if (captain.transport === null) continue;
      const list = captainsByLocation.get(captain.locationName);
      if (list === undefined) captainsByLocation.set(captain.locationName, [captain]);
      else list.push(captain);
    }

    let markers: Marker[] = [];
    let locationMarkers: LocationMarker[] = [];
    let stormMarkers: StormMarker[] = [];
    let highlightedCaptain: Captain | null = null;
    // Set at the top of every draw() call -- lets handleClick invert a
    // click's pixel position back to world coordinates for placing a new
    // Location (see deriveDefaultThresholds/PlaceMenuState).
    let projection: { minX: number; minY: number; scaleX: number; scaleY: number; pad: number } | null = null;

    function draw(): void {
      const dpr = window.devicePixelRatio || 1;
      const width = container!.clientWidth;
      const height = 520;
      canvas!.width = width * dpr;
      canvas!.height = height * dpr;
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      const ctx = canvas!.getContext("2d");
      if (ctx === null) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const coordEntries = Object.values(LOCATION_COORDINATES);
      if (coordEntries.length === 0) return;
      const xs = coordEntries.map(([x]) => x);
      const ys = coordEntries.map(([, y]) => y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      const pad = 52;
      const scaleX = (width - pad * 2) / (maxX - minX || 1);
      const scaleY = (height - pad * 2) / (maxY - minY || 1);
      projection = { minX, minY, scaleX, scaleY, pad };
      const projectPoint = (point: Point): [number, number] => {
        const [x, y] = point;
        return [pad + (x - minX) * scaleX, pad + (y - minY) * scaleY];
      };
      const project = (name: string): [number, number] => projectPoint(LOCATION_COORDINATES[name]);

      // Weather overlay -- an evenly-spaced grid of today's temperature or
      // wind speed points (see weatherGrid/buildWeatherGrid), rasterized to
      // an offscreen canvas and blitted with image smoothing off so each
      // grid cell reads as a distinct point rather than a smoothly blurred
      // blob. Drawn first (background layer) so routes/icons/labels stay on
      // top. Only available for a World with a WeatherSystem (JSON-loaded
      // worlds -- see buildWorldFromJson); the dropdown is hidden otherwise.
      if (weatherGrid !== null) {
        const raster = overlayMode === "temperature"
          ? colorizeDiverging(
              weatherGrid,
              TEMPERATURE_SCALE_MIN_C,
              TEMPERATURE_SCALE_MAX_C,
              cssVar("--temp-cold", "#2a78d6"),
              cssVar("--temp-neutral", "#f0efec"),
              cssVar("--temp-hot", "#e34948"),
            )
          : overlayMode === "windSpeed"
          ? colorizeSequential(
              weatherGrid,
              weatherGrid.min,
              weatherGrid.max,
              cssVar("--wind-calm", "#dff5ee"),
              cssVar("--wind-strong", "#1baf7a"),
            )
          : colorizeSequential(
              weatherGrid,
              RAINFALL_SCALE_MIN,
              RAINFALL_SCALE_MAX,
              cssVar("--rain-light", "#b7d3f6"),
              cssVar("--rain-heavy", "#184f95"),
            );
        const [px0, py0] = projectPoint([weatherGrid.bounds.x0, weatherGrid.bounds.y0]);
        const [px1, py1] = projectPoint([weatherGrid.bounds.x1, weatherGrid.bounds.y1]);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(raster, px0, py0, px1 - px0, py1 - py0);
        ctx.imageSmoothingEnabled = true;
      }

      // Storms/cyclones (see storms.ts) -- always drawn when present, not
      // gated by the "Weather overlay" dropdown (these are discrete hazard
      // entities, not a continuous field). Background layer like the
      // weather raster above, so routes/icons/labels stay legible on top;
      // a saturated fill/border keeps them noticeable even under that.
      stormMarkers = [];
      if (world!.storms !== null) {
        const stormColor = cssVar("--storm", "#ec835a");
        const cycloneColor = cssVar("--cyclone", "#d03b3b");
        for (const storm of world!.storms.storms) {
          const [sx, sy] = projectPoint([storm.x, storm.y]);
          // scaleX/scaleY can go negative for one draw if the container is
          // narrower than `pad * 2` mid-layout -- ctx.ellipse throws on a
          // negative radius, so clamp rather than crash the whole canvas.
          const rx = Math.max(0, storm.radius * scaleX);
          const ry = Math.max(0, storm.radius * scaleY);
          const r = (rx + ry) / 2;
          const color = storm.isCyclone ? cycloneColor : stormColor;
          ctx.beginPath();
          ctx.ellipse(sx, sy, rx, ry, 0, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.globalAlpha = 0.15 + 0.25 * storm.intensity;
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.strokeStyle = color;
          ctx.lineWidth = storm.isCyclone ? 2.5 : 1.5;
          ctx.stroke();
          stormMarkers.push({ storm, x: sx, y: sy, r });
        }
      }

      const border = cssVar("--border", "#999999");
      const textColor = cssVar("--muted", "#666666");
      const accent = cssVar("--accent", "#7c3aed");
      const muted = cssVar("--muted", "#9a97a3");

      /** A Location's icon is colored by whichever PoliticalEntity owns it (cycling through the palette by PoliticalEntity index), falling back to `accent` for a Location with no PoliticalEntity. */
      function colorForLocation(politicalEntity: PoliticalEntity | null): string {
        if (politicalEntity === null) return accent;
        const idx = politicalEntityIndex.get(politicalEntity) ?? 0;
        return cssVar(`--political-entity-${(idx % POLITICAL_ENTITY_PALETTE_SIZE) + 1}`, accent);
      }

      /** Traces a Route's cached curve sample points onto the current path, in the direction from `fromNode` (its `curvePoints()` run origin-to-destination, so a leg being walked in reverse needs them flipped). */
      function traceCurve(route: Route, fromNode: string, started: boolean): boolean {
        const pts = route.origin === fromNode ? route.curvePoints() : [...route.curvePoints()].reverse();
        for (const pt of pts) {
          const [x, y] = projectPoint(pt);
          if (!started) {
            ctx!.moveTo(x, y);
            started = true;
          } else {
            ctx!.lineTo(x, y);
          }
        }
        return started;
      }

      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.55;
      for (const routeList of ROUTES.values()) {
        for (const route of routeList) {
          ctx.strokeStyle = ROUTE_COLORS[route.routeType];
          ctx.beginPath();
          traceCurve(route, route.origin, false);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;

      // The hovered Captain's full remaining route (current leg plus any
      // further queued legs -- see captainRouteNodes), drawn over the base
      // route network in a thick highlight color, following each leg's
      // actual curve, with intermediate stops ringed so a multi-hop
      // voyage's waypoints are legible.
      if (highlightedCaptain !== null) {
        const nodes = captainRouteNodes(highlightedCaptain);
        if (nodes.length >= 2) {
          const highlight = cssVar("--warning", "#f59e0b");
          ctx.strokeStyle = highlight;
          ctx.lineWidth = 3;
          ctx.lineJoin = "round";
          ctx.lineCap = "round";
          ctx.beginPath();
          let started = false;
          for (let i = 0; i < nodes.length - 1; i++) {
            const legRoute = getRoute(nodes[i], nodes[i + 1]);
            if (legRoute !== undefined) {
              started = traceCurve(legRoute, nodes[i], started);
            } else {
              const [x, y] = project(nodes[i]);
              const [nx, ny] = project(nodes[i + 1]);
              if (!started) {
                ctx.moveTo(x, y);
                started = true;
              }
              ctx.lineTo(nx, ny);
            }
          }
          ctx.stroke();

          const surface = cssVar("--panel-bg", "#ffffff");
          for (let i = 1; i < nodes.length - 1; i++) {
            const [nx, ny] = project(nodes[i]);
            ctx.beginPath();
            ctx.arc(nx, ny, 5, 0, Math.PI * 2);
            ctx.fillStyle = surface;
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = highlight;
            ctx.stroke();
          }
        }
      }

      locationMarkers = [];
      for (const loc of locations) {
        const [x, y] = project(loc.name);
        const isDepot = FUEL_DEPOT_NAMES.includes(loc.name);
        drawLocationIcon(ctx, loc, isDepot, x, y, 14, colorForLocation(loc.politicalEntity));
        locationMarkers.push({ location: loc, x, y, r: 14 });
      }

      // Transports -- colored by operating Faction (see factionColor).
      // Docked ships (status AtLocation) stack in a grid above the location
      // they're at; ships in transit are placed on their route line below.
      const markerRadius = 4;
      const cellSize = 11;
      // Taller than cellSize -- the condition bar sits ~10px above each
      // marker's center, so a plain cellSize row pitch would let the row
      // above land right on top of the bar below it.
      const rowSize = 24;
      const gridCols = 4;
      const gridGap = 20;

      /** Draws one ship marker at (mx, my) -- shared by the docked grid and the in-transit route placement below. Docked ships get a halo ring; in-transit ones don't (their position on the route line already conveys that). */
      function drawShipMarker(captain: Captain, mx: number, my: number, docked: boolean): void {
        // Condition bar -- a short horizontal line above the marker, colored
        // by which band the Transport's condition ([0,1]) falls into. Drawn
        // first (before the marker itself) so it never overlaps the
        // selection ring, which extends further out (see below).
        const condition = captain.transport!.condition;
        const conditionColor =
          condition > 0.75 ? cssVar("--condition-good", "#0ca30c")
          : condition > 0.25 ? cssVar("--condition-warning", "#fab219")
          : cssVar("--condition-critical", "#d03b3b");
        const conditionBarHalfWidth = markerRadius + 2;
        const conditionBarY = my - markerRadius - 6;
        ctx!.strokeStyle = conditionColor;
        ctx!.lineWidth = 1.5;
        ctx!.beginPath();
        ctx!.moveTo(mx - conditionBarHalfWidth, conditionBarY);
        ctx!.lineTo(mx + conditionBarHalfWidth, conditionBarY);
        ctx!.stroke();

        ctx!.beginPath();
        ctx!.arc(mx, my, markerRadius, 0, Math.PI * 2);
        ctx!.fillStyle = factionColor(captain, muted);
        ctx!.fill();
        ctx!.strokeStyle = border;
        ctx!.lineWidth = 0.75;
        ctx!.stroke();

        if (docked) {
          ctx!.beginPath();
          ctx!.arc(mx, my, markerRadius + 1.6, 0, Math.PI * 2);
          ctx!.strokeStyle = textColor;
          ctx!.lineWidth = 1;
          ctx!.stroke();
        }

        // The Transport selected in the Fleet panel gets a bold outer ring,
        // independent of (and drawn outside) the hover-only docked halo above
        // -- persists whether this ship is docked or in transit.
        if (captain === selectedCaptain) {
          ctx!.beginPath();
          ctx!.arc(mx, my, markerRadius + 4, 0, Math.PI * 2);
          ctx!.strokeStyle = accent;
          ctx!.lineWidth = 2;
          ctx!.stroke();
        }

        markers.push({ captain, x: mx, y: my, r: markerRadius });
      }

      markers = [];

      // Docked ships: stacked in a grid directly above the location they're
      // currently at.
      for (const loc of locations) {
        const captainsHere = (captainsByLocation.get(loc.name) ?? []).filter((c) => c.status === "AtLocation");
        if (captainsHere.length === 0) continue;
        const [cx, cy] = project(loc.name);
        const n = captainsHere.length;
        const cols = Math.min(gridCols, n);
        const bottomRowY = cy - gridGap;
        captainsHere.forEach((captain, i) => {
          const row = Math.floor(i / cols);
          const itemsInRow = Math.min(cols, n - row * cols);
          const col = i % cols;
          const rowWidth = (itemsInRow - 1) * cellSize;
          const mx = cx - rowWidth / 2 + col * cellSize;
          const my = bottomRowY - row * rowSize;
          drawShipMarker(captain, mx, my, true);
        });
      }

      // In-transit ships: placed on their route's actual Bezier curve, at
      // the fraction of the leg's (curve-length) distance they've completed
      // so far -- computed by comparing the leg's total travel time
      // (recomputed fresh via routeTravelDays from the same Route
      // Captain.departXxx used, since a Route's distance is cached and never
      // changes mid-leg) against daysRemaining, which ticks down toward 0 as
      // Captain.act() advances the voyage day by day. A reposition leg
      // spanning more than one Route edge (see captainRouteNodes' comment)
      // has no single curve to follow, so it falls back to a straight-line
      // fraction between its two endpoints, same as before. Ships sharing
      // the same route line are spread out with a small perpendicular
      // offset so they don't stack exactly on top of each other.
      const inTransitGroups = new Map<string, Captain[]>();
      for (const captain of world!.captains) {
        if (captain.transport === null || captain.status !== "InTransit" || captain.destination === null) continue;
        const key = [captain.locationName, captain.destination].sort().join("||");
        const list = inTransitGroups.get(key);
        if (list === undefined) inTransitGroups.set(key, [captain]);
        else list.push(captain);
      }
      const shipSpacing = 6;
      for (const group of inTransitGroups.values()) {
        const [ox, oy] = project(group[0].locationName);
        const [dx, dy] = project(group[0].destination!);
        const lineDx = dx - ox;
        const lineDy = dy - oy;
        const lineLen = Math.hypot(lineDx, lineDy) || 1;
        const perpX = -lineDy / lineLen;
        const perpY = lineDx / lineLen;
        const n = group.length;
        group.forEach((captain, i) => {
          const legRoute = getRoute(captain.locationName, captain.destination!);
          const totalDays = legRoute !== undefined
            ? routeTravelDays(legRoute, captain.transport!.speedUnitsPerDay)
            : travelDaysBetween(captain.locationName, captain.destination!, captain.transport!.speedUnitsPerDay);
          const fraction = totalDays > 0 ? Math.min(1, Math.max(0, (totalDays - captain.daysRemaining) / totalDays)) : 0;

          let baseX: number;
          let baseY: number;
          if (legRoute !== undefined) {
            const curveFraction = legRoute.origin === captain.locationName ? fraction : 1 - fraction;
            [baseX, baseY] = projectPoint(legRoute.pointAtFraction(curveFraction));
          } else {
            // No single Route connects location to destination -- a
            // multi-hop reposition (see Captain.departEmptyTo). Follow the
            // actual shortest path's concatenated curves instead of a
            // straight line cutting across whatever's in between.
            const multiHopPath = findShortestPath(
              captain.locationName, captain.destination!, (r) => captain.transport!.canUseRoute(r),
            );
            if (multiHopPath !== null && multiHopPath.length > 0) {
              [baseX, baseY] = projectPoint(pointAlongPath(multiHopPath, captain.locationName, fraction));
            } else {
              const [cox, coy] = project(captain.locationName);
              const [cdx, cdy] = project(captain.destination!);
              baseX = cox + (cdx - cox) * fraction;
              baseY = coy + (cdy - coy) * fraction;
            }
          }
          const offset = (i - (n - 1) / 2) * shipSpacing;
          drawShipMarker(captain, baseX + perpX * offset, baseY + perpY * offset, false);
        });
      }

      ctx.font = "10px system-ui, sans-serif";
      ctx.textBaseline = "top";
      ctx.textAlign = "center";
      for (const loc of locations) {
        const [x, y] = project(loc.name);
        ctx.fillStyle = textColor;
        ctx.fillText(loc.name, x, y + 20);
      }
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";

      // Wind direction overlay -- a separate toggle from the temperature/wind
      // speed raster dropdown above (can be shown together with it or on its
      // own): a rotated arrow icon per grid point, drawn as the very last
      // layer so it renders on top of routes/icons/labels/ships instead of
      // being obscured by them.
      if (directionGrid !== null) {
        const windColor = cssVar("--wind-strong", "#1baf7a");
        // Arrows are sized off the grid's actual ON-SCREEN pitch (not a fixed
        // pixel constant) so a dense grid on a small canvas shrinks its
        // arrows instead of letting them overlap into an unreadable smear --
        // scaleX/scaleY (in scope from the projection above) convert the
        // grid's world-unit spacing straight to a pixel pitch.
        const pixelPitch = Math.min(directionGrid.spacing * scaleX, directionGrid.spacing * scaleY);
        const arrowSize = Math.max(4, Math.min(12, pixelPitch * 0.7));
        for (let ry = 0; ry < directionGrid.rows; ry++) {
          for (let cx = 0; cx < directionGrid.cols; cx++) {
            const x = directionGrid.bounds.x0 + cx * directionGrid.spacing;
            const y = directionGrid.bounds.y0 + ry * directionGrid.spacing;
            const [px, py] = projectPoint([x, y]);
            drawWindArrow(ctx, px, py, arrowSize, directionGrid.degrees[ry * directionGrid.cols + cx], windColor);
          }
        }
      }
    }

    draw();
    const resizeObserver = new ResizeObserver(draw);
    resizeObserver.observe(container);

    let hoveredKey: Captain | Location | Storm | null = null;
    function handleMouseMove(e: MouseEvent): void {
      const rect = canvas!.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      const shipHit = markers.find((m) => Math.hypot(m.x - mx, m.y - my) <= m.r + 3);
      if (shipHit !== undefined) {
        if (hoveredKey === shipHit.captain) return;
        hoveredKey = shipHit.captain;
        highlightedCaptain = shipHit.captain;
        draw();
        setHover({ kind: "captain", captain: shipHit.captain, x: shipHit.x, y: shipHit.y });
        return;
      }

      const locationHit = locationMarkers.find((m) => Math.hypot(m.x - mx, m.y - my) <= m.r + 3);
      if (locationHit !== undefined) {
        if (hoveredKey === locationHit.location) return;
        hoveredKey = locationHit.location;
        if (highlightedCaptain !== null) {
          highlightedCaptain = null;
          draw();
        }
        const captainsHere = captainsByLocation.get(locationHit.location.name) ?? [];
        setHover({
          kind: "location",
          location: locationHit.location,
          atLocation: captainsHere.filter((c) => c.status === "AtLocation").length,
          inTransit: captainsHere.filter((c) => c.status === "InTransit").length,
          // world is guaranteed non-null by the effect's early return above,
          // but TS doesn't carry that narrowing into this nested handler --
          // guard inline (the [] branch never runs at runtime).
          events: world === null ? [] : locationActiveEvents(world, locationHit.location.name),
          x: locationHit.x,
          y: locationHit.y,
        });
        return;
      }

      const stormHit = stormMarkers.find((m) => Math.hypot(m.x - mx, m.y - my) <= m.r);
      if (stormHit !== undefined) {
        if (hoveredKey === stormHit.storm) return;
        hoveredKey = stormHit.storm;
        if (highlightedCaptain !== null) {
          highlightedCaptain = null;
          draw();
        }
        setHover({ kind: "storm", storm: stormHit.storm, x: stormHit.x, y: stormHit.y });
        return;
      }

      if (hoveredKey === null) return;
      hoveredKey = null;
      if (highlightedCaptain !== null) {
        highlightedCaptain = null;
        draw();
      }
      setHover(null);
    }
    function handleMouseLeave(): void {
      hoveredKey = null;
      if (highlightedCaptain !== null) {
        highlightedCaptain = null;
        draw();
      }
      setHover(null);
    }
    // Clicking a ship marker toggles its selection (mirrors clicking its row
    // in the Fleet panel -- same store state, see selectedCaptain). Clicking
    // empty canvas (not an existing ship/location marker) instead opens the
    // placement popup at the click, mirroring the editor's WorldCanvas -- the
    // chosen PoliticalEntity (or Cancel) drives actually creating the Location.
    function handleClick(e: MouseEvent): void {
      if (projection === null) return;
      const rect = canvas!.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const shipHit = markers.find((m) => Math.hypot(m.x - mx, m.y - my) <= m.r + 3);
      if (shipHit !== undefined) {
        selectTransport(shipHit.captain);
        return;
      }
      const hitLocation = locationMarkers.some((m) => Math.hypot(m.x - mx, m.y - my) <= m.r + 3);
      if (hitLocation) return;
      const worldX = (mx - projection.pad) / projection.scaleX + projection.minX;
      const worldY = (my - projection.pad) / projection.scaleY + projection.minY;
      const { maxDistance, detourDistance } = deriveDefaultThresholds();
      setPlaceMenu({ pixelX: mx, pixelY: my, worldX, worldY, detourDistance, maxDistance });
    }
    canvas.addEventListener("mousemove", handleMouseMove);
    canvas.addEventListener("mouseleave", handleMouseLeave);
    canvas.addEventListener("click", handleClick);

    return () => {
      resizeObserver.disconnect();
      canvas.removeEventListener("mousemove", handleMouseMove);
      canvas.removeEventListener("mouseleave", handleMouseLeave);
      canvas.removeEventListener("click", handleClick);
    };
  }, [world, version, politicalEntities, selectedCaptain, selectTransport, weatherGrid, directionGrid, overlayMode, showWindDirection]);

  if (world === null) return null;

  const displayDistanceUnit = getDisplayDistanceUnit();
  const speedLabel = speedUnitLabel(displayDistanceUnit);

  return (
    <div className="panel network-panel">
      <h2>Network</h2>
      {world.weather !== null && (
        <div className="network-temperature-controls">
          <label className="network-temperature-toggle">
            Weather overlay
            <select
              value={overlayMode}
              onChange={(e) => setOverlayMode(e.target.value as OverlayMetric | "none")}
            >
              <option value="none">None</option>
              <option value="temperature">Temperature</option>
              <option value="windSpeed">Wind speed</option>
              <option value="rainfall">Rainfall</option>
            </select>
          </label>
          <label className="network-temperature-toggle">
            <input
              type="checkbox"
              checked={showWindDirection}
              onChange={(e) => setShowWindDirection(e.target.checked)}
            />
            Show wind direction
          </label>
          {(overlayMode !== "none" || showWindDirection) && (
            <label className="network-temperature-toggle">
              Point spacing
              <input
                type="number"
                min={1}
                value={overlaySpacing}
                onChange={(e) => setOverlaySpacing(Math.max(1, Number(e.target.value)))}
              />
              units
            </label>
          )}
        </div>
      )}
      <div className="network-legend">
        {overlayMode === "temperature" && world.weather !== null && (
          <span>
            <i className="legend-swatch" style={{ background: "var(--temp-cold)" }} />{TEMPERATURE_SCALE_MIN_C}°C ·{" "}
            <i className="legend-swatch" style={{ background: "var(--temp-neutral)" }} />
            {(TEMPERATURE_SCALE_MIN_C + TEMPERATURE_SCALE_MAX_C) / 2}°C ·{" "}
            <i className="legend-swatch" style={{ background: "var(--temp-hot)" }} />{TEMPERATURE_SCALE_MAX_C}°C
          </span>
        )}
        {overlayMode === "windSpeed" && world.weather !== null && weatherGrid !== null && (
          <span>
            <i className="legend-swatch" style={{ background: "var(--wind-calm)" }} />
            Calm ({convertSpeed(weatherGrid.min, displayDistanceUnit).toFixed(0)} {speedLabel}) ·{" "}
            <i className="legend-swatch" style={{ background: "var(--wind-strong)" }} />
            Strong ({convertSpeed(weatherGrid.max, displayDistanceUnit).toFixed(0)} {speedLabel})
          </span>
        )}
        {overlayMode === "rainfall" && world.weather !== null && (
          <span>
            <i className="legend-swatch" style={{ background: "var(--rain-light)" }} />
            {(RAINFALL_SCALE_MIN * 100).toFixed(0)}% ·{" "}
            <i className="legend-swatch" style={{ background: "var(--rain-heavy)" }} />
            {(RAINFALL_SCALE_MAX * 100).toFixed(0)}%
          </span>
        )}
        {showWindDirection && world.weather !== null && (
          <span>Arrows point in today's wind direction at each grid point</span>
        )}
        {world.storms !== null && world.storms.storms.length > 0 && (
          <span>
            <i className="legend-swatch" style={{ background: "var(--storm)" }} />Storm ·{" "}
            <i className="legend-swatch" style={{ background: "var(--cyclone)" }} />Cyclone
          </span>
        )}
        <span><i className="legend-swatch" style={{ background: ROUTE_COLORS.Sea }} />Sea route</span>
        <span><i className="legend-swatch" style={{ background: ROUTE_COLORS.Land }} />Land route</span>
        <span><i className="legend-swatch" style={{ background: ROUTE_COLORS.Air }} />Air route</span>
        <span><i className="legend-swatch" style={{ background: ROUTE_COLORS.Trail }} />Trail (foot/porter)</span>
        <span>
          Anchor = Port · Barrel = Fuel depot · Wheel = Wagon yard · Plane = Airport · Hut = Market (village)
          (icon color = Political Entity)
        </span>
        <span><i className="legend-swatch" style={{ background: FACTION_COLORS.pirate }} />Pirates</span>
        <span><i className="legend-swatch" style={{ background: FACTION_COLORS.police }} />Police</span>
        <span><i className="legend-swatch" style={{ background: FACTION_COLORS.company }} />Company</span>
        <span><i className="legend-swatch" style={{ background: FACTION_COLORS.soloTrader }} />Solo trader</span>
        <span><i className="legend-ring" />Docked (not in transit)</span>
        <span><i className="legend-line" style={{ borderBottomColor: "var(--warning, #f59e0b)" }} />Hover a ship to see its route</span>
        <span>Click a ship to select it (also selectable from the Fleet panel)</span>
        <span>Click empty water to add a Location</span>
      </div>
      <div className="network-canvas-wrap" ref={containerRef}>
        <canvas ref={canvasRef} />
        {placeMenu !== null && (
          <div className="placement-menu" style={{ left: placeMenu.pixelX, top: placeMenu.pixelY }} role="menu">
            {world.locations.length >= MAX_LOCATIONS ? (
              <div className="placement-menu-empty">World already has the maximum of {MAX_LOCATIONS} Locations.</div>
            ) : (
              <>
                <label className="placement-menu-field">
                  detour
                  <input
                    type="number"
                    min={0}
                    value={placeMenu.detourDistance}
                    onChange={(e) => setPlaceMenu({ ...placeMenu, detourDistance: Number(e.target.value) })}
                  />
                </label>
                <label className="placement-menu-field">
                  max
                  <input
                    type="number"
                    min={0}
                    value={placeMenu.maxDistance}
                    onChange={(e) => setPlaceMenu({ ...placeMenu, maxDistance: Number(e.target.value) })}
                  />
                </label>
                <div className="placement-menu-header">Political Entity</div>
                {politicalEntities.map((entity) => (
                  <button
                    key={entity.name}
                    type="button"
                    className="placement-menu-item"
                    onClick={() => {
                      addLocationAction(
                        placeMenu.worldX, placeMenu.worldY, entity,
                        Math.max(0, placeMenu.detourDistance), placeMenu.maxDistance,
                      );
                      setPlaceMenu(null);
                    }}
                  >
                    {entity.name}
                  </button>
                ))}
                {politicalEntities.length === 0 && (
                  <div className="placement-menu-empty">No Political Entities defined</div>
                )}
              </>
            )}
            <button type="button" className="placement-menu-item placement-menu-cancel" onClick={() => setPlaceMenu(null)}>
              Cancel
            </button>
          </div>
        )}
        {hover !== null && hover.kind === "captain" && (
          <div className="network-tooltip" style={{ left: hover.x, top: hover.y }}>
            <div className="network-tooltip-title">{hover.captain.name}</div>
            <div>
              {transportKind(hover.captain.transport!)} — {hover.captain.transport!.name}
            </div>
            <div>{hover.captain.company?.name ?? "(independent)"}</div>
            <div>
              {hover.captain.status}
              {hover.captain.status === "InTransit" && hover.captain.destination !== null
                ? ` → ${hover.captain.destination}`
                : ` @ ${hover.captain.locationName}`}
            </div>
            {hover.captain.cargo !== null && (
              <div>
                Cargo: {hover.captain.cargo.items.map((item) => `${item.commodity} × ${item.quantity.toFixed(1)}`).join(", ")}
              </div>
            )}
            {Number.isFinite(hover.captain.cash) && <div>Cash: ${hover.captain.cash.toFixed(2)}</div>}
            {hover.captain.cargo !== null && hover.captain.cargo.items.some((item) => item.contract != null) && (
              <div className="network-tooltip-events">
                {hover.captain.cargo.items
                  .filter((item) => item.contract != null)
                  .map((item, i) => (
                    <div key={i}>
                      📦 Contract: {item.contract!.quantity.toFixed(1)} {item.contract!.commodity} → {item.contract!.location}{" "}
                      (fee ${item.contract!.deliveryFee.toFixed(2)})
                    </div>
                  ))}
              </div>
            )}
            {hover.captain.activeAgentEvents.length > 0 && (
              <div className="network-tooltip-events">
                {hover.captain.activeAgentEvents.map((event, i) => (
                  <div key={i}>
                    ⚡ {event.message} ({event.daysRemaining}d left)
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {hover !== null && hover.kind === "location" && (
          <div className="network-tooltip" style={{ left: hover.x, top: hover.y }}>
            <div className="network-tooltip-title">{hover.location.name}</div>
            <div>
              Status: {world.closedLocations.has(hover.location.name)
                ? `Closed (${world.closedLocations.get(hover.location.name)!.name}, ${world.closedLocations.get(hover.location.name)!.daysRemaining}d left)`
                : "Open"}
            </div>
            <div>Political Entity: {hover.location.politicalEntity?.name ?? "(none)"}</div>
            <div>Transports at location: {hover.atLocation}</div>
            <div>Transports in transit: {hover.inTransit}</div>
            {hover.events.length > 0 && (
              <div className="network-tooltip-events">
                {hover.events.map((event, i) => (
                  <div key={i}>
                    ⚡ {event.message} ({event.daysRemaining}d left)
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {hover !== null && hover.kind === "storm" && (
          <div className="network-tooltip" style={{ left: hover.x, top: hover.y }}>
            <div className="network-tooltip-title">{hover.storm.isCyclone ? "Cyclone" : "Storm"}</div>
            <div>Intensity: {(hover.storm.intensity * 100).toFixed(0)}%</div>
            <div>Age: {hover.storm.age}d</div>
            <div>Radius: {hover.storm.radius.toFixed(0)}</div>
          </div>
        )}
      </div>
    </div>
  );
}
