/**
 * The commodity roster and the world's geography (coordinates, distance,
 * travel time). Ported from sim/world_data.py.
 *
 * LOCATIONS/LOCATION_COORDINATES/COMMODITIES are exported `let` bindings,
 * mirroring Python's mutable-module-global pattern (see CLAUDE.md) -- ES
 * module named imports are LIVE bindings (unlike Python's `from x import y`,
 * which copies the reference at import time), so every other module that
 * does `import { LOCATIONS } from "./worldData"` automatically observes a
 * reassignment via setGeography() below, no `import * as` workaround needed.
 */
import { Rng } from "./rng";
import { Commodity, buildCommodities } from "./commodity";
import { Location, type TerminalType } from "./location";
import { Country } from "./country";

export const FUEL_BASE_PRICE = 1.25;

export let COMMODITIES: Record<string, Commodity> = buildCommodities(
  [
    "Crude Oil", "Copper", "Wheat", "Gold", "Silver",
    "Natural Gas", "Coffee", "Cotton", "Iron Ore", "Aluminum",
  ],
  {
    "Crude Oil": 75.0, Copper: 82.0, Wheat: 6.5, Gold: 2300.0,
    Silver: 28.0, "Natural Gas": 3.5, Coffee: 1.85, Cotton: 0.85,
    "Iron Ore": 110.0, Aluminum: 95.0,
  },
);

export function setCommodities(commodities: Record<string, Commodity>): void {
  COMMODITIES = commodities;
}

export const LOCATION_NAMES: string[] = [
  "Rotterdam Port", "Chicago Exchange", "Shanghai Hub", "Sao Paulo Depot",
  "Singapore Terminal", "Dubai Exchange", "Mumbai Hub", "Lagos Port",
  "Sydney Terminal", "Vancouver Port", "Hamburg Exchange", "Busan Hub",
  "Cape Town Port", "Houston Terminal", "Antwerp Exchange", "Santos Port",
  "Jakarta Hub", "Istanbul Exchange", "Los Angeles Port", "Mexico City Hub",
  "London Exchange", "Tokyo Terminal", "Buenos Aires Port", "Cairo Exchange",
  "Bangkok Hub", "Toronto Terminal", "Karachi Port", "Manila Exchange",
  "Lima Hub", "Nairobi Terminal",
];

export const FUEL_DEPOT_NAMES: string[] = [
  "Gibraltar Fuel Depot", "Suez Bunkering Station", "Malacca Fuel Depot",
];

export const ALL_LOCATION_NAMES: string[] = [...LOCATION_NAMES, ...FUEL_DEPOT_NAMES];

export const WORLD_GEN_SEED = 2024;

// The [minPerRole, maxPerRole] commodities-sampled-per-role range passed to
// generateLocations must fall within this range. Calibrated via seed-
// averaged stockpile-ratio sweeps (see Simulation.md): a wider spread means
// the same fixed fleet has to cover far more distinct (location, commodity)
// pairs, and the ratio degrades roughly monotonically as spread widens --
// the default [2, 4] sits well inside this bound with margin either way.
export const MIN_COMMODITIES_PER_LOCATION = 2;
export const MAX_COMMODITIES_PER_LOCATION = 6;

/**
 * Default days-of-consumption buffer a consumed commodity's minStockpile
 * target represents (minStockpile = dailyConsumptionRate * this), passed to
 * generateLocations. Set to 14 (up from an initial 7.5, the midpoint of the
 * random U(5, 10) draw per location this replaced) because a seed-averaged
 * scan of every consumed (location, commodity) pair's daily stockpile found
 * that a bigger buffer overwhelmingly reduces how often a commodity
 * actually runs out (a much bigger effect than its mild, non-monotonic
 * effect on the aggregate stockpile-ratio metric): the zero-stockpile day
 * rate fell from 43.6% at minStockpileDays=2 to just 2.1% at 14 -- roughly
 * a 4x reduction from 7.5's 8.2% alone -- while the *length* of each
 * stockout episode barely changed (~4 days regardless), since recovery
 * time is governed by delivery-cycle logistics, not buffer size. See
 * Simulation.md's Finding 6 for the full sweep.
 */
export const DEFAULT_MIN_STOCKPILE_DAYS = 14;

/**
 * Default multiple N of a consumed commodity's minStockpile that its
 * starting stockpile is set to (stockpile = minStockpile * N), passed to
 * generateLocations -- every location starts N times comfortably above the
 * point where it would need a supply Contract.
 */
export const DEFAULT_CONSUMED_STOCKPILE_FACTOR = 2.0;

const OTHER_TERMINAL_TYPES: TerminalType[] = ["Wagon yard", "Airport", "Platform"];

interface LocationDraft {
  name: string;
  isDepot: boolean;
  produced: string[];
  consumed: string[];
  producedCommodities: Record<string, number>;
  consumedCommodities: Record<string, number>;
  otherTerminals: TerminalType[];
}

export function generateLocations(
  names: string[],
  commodities: Record<string, Commodity>,
  seed: number = WORLD_GEN_SEED,
  consumedStockpileFactor: number = DEFAULT_CONSUMED_STOCKPILE_FACTOR,
  minPerRole: number = 2,
  maxPerRole: number = 4,
  minStockpileDays: number = DEFAULT_MIN_STOCKPILE_DAYS,
): Location[] {
  if (minPerRole < MIN_COMMODITIES_PER_LOCATION || maxPerRole > MAX_COMMODITIES_PER_LOCATION) {
    throw new Error(
      `generateLocations: [minPerRole, maxPerRole] must fall within ` +
        `[${MIN_COMMODITIES_PER_LOCATION}, ${MAX_COMMODITIES_PER_LOCATION}] (got [${minPerRole}, ${maxPerRole}]).`,
    );
  }
  const rng = new Rng(seed);
  const commodityNames = Object.keys(commodities);

  // Pass 1: draw each location's produced/consumed commodities and their
  // (still unbalanced) per-day rates -- same RNG call sequence as before
  // this function grew a balancing pass, so a fixed seed still reproduces
  // the same world modulo the deliberate rescaling below.
  const drafts: LocationDraft[] = [];
  for (const name of names) {
    if (FUEL_DEPOT_NAMES.includes(name)) {
      drafts.push({
        name, isDepot: true, produced: [], consumed: [],
        producedCommodities: {}, consumedCommodities: {}, otherTerminals: [],
      });
      continue;
    }

    const produced = rng.sample(commodityNames, Math.min(rng.randint(minPerRole, maxPerRole), commodityNames.length));
    const remaining = commodityNames.filter((c) => !produced.includes(c));
    const consumed = rng.sample(remaining, Math.min(rng.randint(minPerRole, maxPerRole), remaining.length));

    // Rate MODIFIERS scattered +/-30% around the default 1.0 (see
    // Location.productionRate/consumptionRate) -- not absolute rates.
    const producedCommodities: Record<string, number> = {};
    for (const c of produced) producedCommodities[c] = round2(rng.uniform(0.7, 1.3));
    const consumedCommodities: Record<string, number> = {};
    for (const c of consumed) consumedCommodities[c] = round2(rng.uniform(0.7, 1.3));

    const otherTerminals = rng.sample(OTHER_TERMINAL_TYPES, rng.randint(0, 2));
    drafts.push({ name, isDepot: false, produced, consumed, producedCommodities, consumedCommodities, otherTerminals });
  }

  // Pass 2: balance each commodity's world-wide daily production against its
  // world-wide daily consumption. Left alone, independently-rolled produce/
  // consume rates create a structural, permanent glut or shortage that no
  // amount of trading can fix -- a different problem from the throughput-
  // limited scarcity tuned elsewhere (fleet size, cargo capacity, pricing).
  // Rescaling both sides toward their average preserves each location's
  // relative share of world supply/demand for that commodity. Totals are
  // computed in effective units/day (modifier * the commodity's own
  // baseProductionRate/baseConsumptionRate, which can differ from each
  // other) -- but since that base rate is a constant factor for a given
  // commodity+role, scaling the MODIFIER by produceScale/consumeScale is
  // equivalent to scaling the effective rate by it, so the drafts stay in
  // modifier space throughout.
  for (const commodityName of commodityNames) {
    const producedRate = commodities[commodityName].baseProductionRate;
    const consumedRate = commodities[commodityName].baseConsumptionRate;
    let totalProduced = 0;
    let totalConsumed = 0;
    for (const d of drafts) {
      totalProduced += (d.producedCommodities[commodityName] ?? 0) * producedRate;
      totalConsumed += (d.consumedCommodities[commodityName] ?? 0) * consumedRate;
    }
    if (totalProduced <= 0 || totalConsumed <= 0) continue;

    const target = (totalProduced + totalConsumed) / 2;
    const produceScale = target / totalProduced;
    const consumeScale = target / totalConsumed;
    for (const d of drafts) {
      if (commodityName in d.producedCommodities) {
        d.producedCommodities[commodityName] = round2(d.producedCommodities[commodityName] * produceScale);
      }
      if (commodityName in d.consumedCommodities) {
        d.consumedCommodities[commodityName] = round2(d.consumedCommodities[commodityName] * consumeScale);
      }
    }
  }

  // Pass 3: derive stockpiles/minStockpiles/basePriceModifiers off the
  // now-balanced rates, continuing the same RNG draw order the original
  // single pass used. basePriceModifiers is a MODIFIER (default 1.0, here
  // scattered +/-15% around it), not an absolute price -- Location.basePrice()
  // multiplies it by the commodity's own basePrice at lookup time.
  const locations: Location[] = [];
  for (const d of drafts) {
    if (d.isDepot) {
      locations.push(
        new Location({
          name: d.name,
          producedCommodities: {},
          consumedCommodities: {},
          stockpiles: {},
          minStockpiles: {},
          basePriceModifiers: {},
          fuelPrice: FUEL_BASE_PRICE,
          terminalTypes: new Set(["Port"]),
        }),
      );
      continue;
    }

    const stockpiles: Record<string, number> = {};
    const minStockpiles: Record<string, number> = {};
    const basePriceModifiers: Record<string, number> = {};

    for (const c of d.produced) {
      const effectiveRate = commodities[c].baseProductionRate * d.producedCommodities[c];
      stockpiles[c] = round2(effectiveRate * rng.uniform(10, 25));
      basePriceModifiers[c] = round2(rng.uniform(0.85, 1.15));
    }
    for (const c of d.consumed) {
      const effectiveRate = commodities[c].baseConsumptionRate * d.consumedCommodities[c];
      minStockpiles[c] = round2(effectiveRate * minStockpileDays);
      stockpiles[c] = round2(minStockpiles[c] * consumedStockpileFactor);
      basePriceModifiers[c] = round2(rng.uniform(0.85, 1.15));
    }

    const terminalTypes: Set<TerminalType> = d.otherTerminals.includes("Platform")
      ? new Set(["Platform"])
      : new Set<TerminalType>(["Port", ...d.otherTerminals]);

    locations.push(
      new Location({
        name: d.name,
        producedCommodities: d.producedCommodities,
        consumedCommodities: d.consumedCommodities,
        stockpiles,
        minStockpiles,
        basePriceModifiers,
        fuelPrice: FUEL_BASE_PRICE,
        terminalTypes,
      }),
    );
  }
  return locations;
}

// Coordinate spread and minimum inter-location spacing, both 3x their
// original values (1000/200) -- scales every generated Route's distance
// (and therefore travel time and fuel burn, see distanceBetween) up
// proportionally, without changing route topology (which pairs connect at
// all is a function of relative distance, not absolute scale).
const COORDINATE_SPREAD = 9000.0;
const DEFAULT_MIN_LOCATION_DISTANCE = 600.0;

export function generateCoordinates(
  names: string[],
  seed: number = WORLD_GEN_SEED,
  minDistance: number = DEFAULT_MIN_LOCATION_DISTANCE,
): Record<string, [number, number]> {
  const rng = new Rng(seed + 1);
  const coordinates: Record<string, [number, number]> = {};

  for (const name of names) {
    let candidate: [number, number] = [rng.uniform(0, COORDINATE_SPREAD), rng.uniform(0, COORDINATE_SPREAD)];
    for (let attempt = 0; attempt < 1000; attempt++) {
      const farEnough = Object.values(coordinates).every(
        ([x, y]) => Math.hypot(candidate[0] - x, candidate[1] - y) >= minDistance,
      );
      if (farEnough) break;
      candidate = [rng.uniform(0, COORDINATE_SPREAD), rng.uniform(0, COORDINATE_SPREAD)];
    }
    coordinates[name] = candidate;
  }
  return coordinates;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export let LOCATIONS: Location[] = [];
export let LOCATION_COORDINATES: Record<string, [number, number]> = {};

/** Wholesale-reassign the world's geography (called once by buildWorld). */
export function setGeography(
  locations: Location[],
  coordinates: Record<string, [number, number]>,
): void {
  LOCATIONS = locations;
  LOCATION_COORDINATES = coordinates;
}

export function getLocation(name: string): Location | undefined {
  return LOCATIONS.find((loc) => loc.name === name);
}

/** Default target Locations per Country -- see assignCountries. */
export const DEFAULT_LOCATIONS_PER_COUNTRY = 5;

/**
 * Group `locations` into Countries of roughly `targetLocationsPerCountry`
 * each, by proximity. Repeatedly picks an arbitrary still-unassigned
 * location (order shuffled from `seed`, for reproducibility) and pulls in
 * its nearest still-unassigned neighbors (via `distanceBetween`, so this
 * must run after `setGeography` has set the coordinates these locations
 * live at) until the target size is reached or locations run out -- the
 * last group may end up smaller. `Country`'s own constructor pools each
 * member Location's cash and sets its `country` reference -- see
 * `country.ts`.
 */
export function assignCountries(
  locations: readonly Location[],
  seed: number = WORLD_GEN_SEED + 3,
  targetLocationsPerCountry: number = DEFAULT_LOCATIONS_PER_COUNTRY,
): Country[] {
  const rng = new Rng(seed);
  const remaining = rng.sample(locations, locations.length);
  const countries: Country[] = [];

  while (remaining.length > 0) {
    const seedLocation = remaining.shift()!;
    remaining.sort(
      (a, b) => distanceBetween(seedLocation.name, a.name) - distanceBetween(seedLocation.name, b.name),
    );
    const group = [seedLocation, ...remaining.splice(0, targetLocationsPerCountry - 1)];
    countries.push(new Country(`Country ${pad3(countries.length + 1)}`, group));
  }
  return countries;
}

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

export const SHIP_SPEED_UNITS_PER_DAY = 500;

export function distanceBetween(locationA: string, locationB: string): number {
  if (locationA === locationB) return 0.0;
  const [x1, y1] = LOCATION_COORDINATES[locationA];
  const [x2, y2] = LOCATION_COORDINATES[locationB];
  return Math.hypot(x2 - x1, y2 - y1);
}

export function travelDaysBetween(
  locationA: string,
  locationB: string,
  speed: number = SHIP_SPEED_UNITS_PER_DAY,
): number {
  const dist = distanceBetween(locationA, locationB);
  return Math.max(1, Math.ceil(dist / speed));
}
