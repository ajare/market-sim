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

const OTHER_TERMINAL_TYPES: TerminalType[] = ["Station", "Airport", "Platform"];

export function generateLocations(
  names: string[],
  commodities: Record<string, Commodity>,
  seed: number = WORLD_GEN_SEED,
  consumedStockpileFactor: number = 2.0,
): Location[] {
  const rng = new Rng(seed);
  const commodityNames = Object.keys(commodities);
  const locations: Location[] = [];

  for (const name of names) {
    if (FUEL_DEPOT_NAMES.includes(name)) {
      locations.push(
        new Location({
          name,
          producedCommodities: {},
          consumedCommodities: {},
          stockpiles: {},
          minStockpiles: {},
          basePrices: {},
          fuelPrice: FUEL_BASE_PRICE,
          terminalTypes: new Set(["Port"]),
        }),
      );
      continue;
    }

    const produced = rng.sample(commodityNames, rng.randint(2, 4));
    const remaining = commodityNames.filter((c) => !produced.includes(c));
    const consumed = rng.sample(remaining, Math.min(rng.randint(2, 4), remaining.length));

    const producedCommodities: Record<string, number> = {};
    for (const c of produced) producedCommodities[c] = round2(rng.uniform(3, 15));
    const consumedCommodities: Record<string, number> = {};
    for (const c of consumed) consumedCommodities[c] = round2(rng.uniform(3, 15));

    const stockpiles: Record<string, number> = {};
    const minStockpiles: Record<string, number> = {};
    const basePrices: Record<string, number> = {};

    for (const c of produced) {
      const rate = producedCommodities[c];
      stockpiles[c] = round2(rate * rng.uniform(10, 25));
      basePrices[c] = round2(commodities[c].basePrice * rng.uniform(0.85, 1.15));
    }
    for (const c of consumed) {
      const rate = consumedCommodities[c];
      minStockpiles[c] = round2(rate * rng.uniform(5, 10));
      stockpiles[c] = round2(minStockpiles[c] * consumedStockpileFactor);
      basePrices[c] = round2(commodities[c].basePrice * rng.uniform(0.85, 1.15));
    }

    const otherTerminals = rng.sample(OTHER_TERMINAL_TYPES, rng.randint(0, 2));
    const terminalTypes: Set<TerminalType> = otherTerminals.includes("Platform")
      ? new Set(["Platform"])
      : new Set<TerminalType>(["Port", ...otherTerminals]);

    locations.push(
      new Location({
        name,
        producedCommodities,
        consumedCommodities,
        stockpiles,
        minStockpiles,
        basePrices,
        fuelPrice: FUEL_BASE_PRICE,
        terminalTypes,
      }),
    );
  }
  return locations;
}

export function generateCoordinates(
  names: string[],
  seed: number = WORLD_GEN_SEED,
  minDistance: number = 200.0,
): Record<string, [number, number]> {
  const rng = new Rng(seed + 1);
  const coordinates: Record<string, [number, number]> = {};

  for (const name of names) {
    let candidate: [number, number] = [rng.uniform(0, 3000), rng.uniform(0, 3000)];
    for (let attempt = 0; attempt < 1000; attempt++) {
      const farEnough = Object.values(coordinates).every(
        ([x, y]) => Math.hypot(candidate[0] - x, candidate[1] - y) >= minDistance,
      );
      if (farEnough) break;
      candidate = [rng.uniform(0, 3000), rng.uniform(0, 3000)];
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
