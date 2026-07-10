/**
 * Builds the default procedurally generated world + fleet -- the
 * procedural branch of cli.py's build_world() (the CSV branches are
 * sim/csv_loaders.py, explicitly deferred to a later phase). Same fixed
 * RNG seeds, fleet shape, and event probabilities as the Python original.
 */
import { Rng } from "./rng";
import {
  ALL_LOCATION_NAMES, COMMODITIES, FUEL_DEPOT_NAMES, WORLD_GEN_SEED,
  DEFAULT_MIN_STOCKPILE_DAYS, DEFAULT_CONSUMED_STOCKPILE_FACTOR,
  generateLocations, generateCoordinates, setGeography,
} from "./worldData";
import type { Commodity } from "./commodity";
import { generateRoutes, setRoutes } from "./routes";
import { SHIP_CLASSES, type Transport } from "./transport";
import { Captain } from "./captain";
import { DUTCH_FIRST_NAMES, DUTCH_LAST_NAMES, randomName } from "./names";
import { Faction, Company, SoloTrader } from "./faction";
import { World } from "./world";
import type { TenderContractsOptions } from "./contracts";

export interface BuiltWorld {
  world: World;
  factions: Faction[];
}

/** Overrides for buildWorld -- all optional; omitting them reproduces the default world byte-for-byte. */
export interface BuildWorldOptions {
  /**
   * Seed for the World's stochastic stream (market events, closures, price
   * noise, and the daily agent act-order). Default 42. Vary this to sample
   * different trajectories of the SAME economy -- the sweep harness does
   * exactly that to average out Monte-Carlo noise (see analysis.ts).
   */
  seed?: number;
  /** Total ships is ~ locations.length * this. Default 5 (the calibrated ratio). */
  targetShipsPerLocation?: number;
  /** Ships grouped into each Company. Default 5. */
  shipsPerCompany?: number;
  /**
   * Extra ships added to every Company on top of shipsPerCompany, as a
   * fraction (0 to 1) of shipsPerCompany, rounded up -- so a Company's
   * fleet is never fully saturated by Contract duty (which is prioritized
   * over arbitrage, see Company.directFleet) and some ships are always
   * free to arbitrage. Default 0.2. Not empirically tuned like the ship-
   * per-location ratio -- a reasonable buffer, easy to retune.
   */
  arbitrageShipFraction?: number;
  /**
   * Fraction of locations.length used to size the number of `Company`
   * factions specifically -- `SoloTrader` count is unaffected (see
   * buildWorld's fleet-sizing comment). Each Company's own fleet grows to
   * absorb the reduction, so the total ship count owned by Companies (and
   * therefore the grand total across Companies + SoloTraders) stays the
   * same regardless of this value. Must fall within
   * [MIN_COMPANY_FRACTION, MAX_COMPANY_FRACTION] = [0.2, 0.5]. Default 0.35
   * -- the midpoint of that band, not empirically tuned.
   */
  companyFraction?: number;
  /** Overrides for tenderContracts' tunable knobs -- forwarded to World, see WorldInit.contractOptions. */
  contractOptions?: TenderContractsOptions;
  /** Location roster to generate the world from. Default ALL_LOCATION_NAMES (the 30 hubs + 3 fuel depots). Used to test whether fleet-sizing ratios generalize to a different-sized world. */
  locationNames?: string[];
  /** Commodity roster to generate locations against. Default worldData.COMMODITIES (the 10 built-in commodities). Used to test whether fleet-sizing ratios generalize to a different total commodity count. */
  commodities?: Record<string, Commodity>;
  /** [min, max] (inclusive) commodities sampled per role (produced/consumed) at each non-depot Location. Default [2, 4]. Used to test whether fleet-sizing ratios generalize to a different per-Location commodity spread. */
  commodityCountRange?: [number, number];
  /** Days-of-consumption buffer a consumed commodity's minStockpile represents (minStockpile = dailyRate * this). Default worldData.DEFAULT_MIN_STOCKPILE_DAYS (7.5). */
  minStockpileDays?: number;
  /** Multiple N a consumed commodity's starting stockpile is set to, relative to its minStockpile (stockpile = minStockpile * N). Default worldData.DEFAULT_CONSUMED_STOCKPILE_FACTOR (2.0). */
  consumedStockpileFactor?: number;
}

const DEFAULT_SEED = 42;
// Fleet is sized off the number of Locations, not a hardcoded count, so it
// scales if the location roster changes (e.g. a CSV-driven world). The ratio
// is fixed at 5 ships/location -- with CONTRACT_QUANTITY_MULTIPLIER at 1.5
// (see contracts.ts), this is the minimum fleet found (via seed-averaged
// sweeps, see analysis.ts) that keeps the stockpile-vs-minimum metric at or
// above 1.0 on average; the previous, much larger 480/33 ratio predates the
// location-funded contract redesign and its proactive tendering.
//
// IMPORTANT (see the chaos diagnosis, `analysis.ts`): the stockpile-vs-minimum
// metric is a high-variance, seed-sensitive estimator -- one run carries a
// ~0.05 SD of pure Monte-Carlo noise, so nudging TARGET_SHIPS_PER_LOCATION and
// reading a single run tells you almost nothing at fine resolution. To retune
// this ratio, average many seeds per candidate value (`npm run sweep`), never
// a lone run.
const DEFAULT_TARGET_SHIPS_PER_LOCATION = 5;
const DEFAULT_SHIPS_PER_COMPANY = 5;
const DEFAULT_ARBITRAGE_SHIP_FRACTION = 0.2;

/** Company count, as a fraction of locations.length, must fall within this band -- see BuildWorldOptions.companyFraction. */
export const MIN_COMPANY_FRACTION = 0.2;
export const MAX_COMPANY_FRACTION = 0.5;
const DEFAULT_COMPANY_FRACTION = 0.35;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

/**
 * Builds a full World plus its Factions, procedurally, without running any
 * days. `maxRouteDistance` prunes the generated route network down to
 * pairs within that distance (matching exp-ui's SimState.reset(), which
 * passes 1000); pass `undefined` for an uncapped network (cli.py's
 * default). `options` tweaks the dynamics seed and fleet sizing for sweeps
 * -- omit it entirely for the default world.
 */
export function buildWorld(
  maxRouteDistance: number | undefined = 1000,
  options: BuildWorldOptions = {},
): BuiltWorld {
  const seed = options.seed ?? DEFAULT_SEED;
  const targetShipsPerLocation = options.targetShipsPerLocation ?? DEFAULT_TARGET_SHIPS_PER_LOCATION;
  const shipsPerCompany = options.shipsPerCompany ?? DEFAULT_SHIPS_PER_COMPANY;
  const arbitrageShipFraction = options.arbitrageShipFraction ?? DEFAULT_ARBITRAGE_SHIP_FRACTION;
  const companyFraction = options.companyFraction ?? DEFAULT_COMPANY_FRACTION;
  if (companyFraction < MIN_COMPANY_FRACTION || companyFraction > MAX_COMPANY_FRACTION) {
    throw new Error(
      `buildWorld: companyFraction must be between ${MIN_COMPANY_FRACTION} and ${MAX_COMPANY_FRACTION} (got ${companyFraction}).`,
    );
  }
  const locationNames = options.locationNames ?? ALL_LOCATION_NAMES;
  const commodities = options.commodities ?? COMMODITIES;
  const [minPerRole, maxPerRole] = options.commodityCountRange ?? [2, 4];
  const minStockpileDays = options.minStockpileDays ?? DEFAULT_MIN_STOCKPILE_DAYS;
  const consumedStockpileFactor = options.consumedStockpileFactor ?? DEFAULT_CONSUMED_STOCKPILE_FACTOR;

  const locations = generateLocations(
    locationNames, commodities, WORLD_GEN_SEED, consumedStockpileFactor, minPerRole, maxPerRole, minStockpileDays,
  );
  const coordinates = generateCoordinates(locationNames);
  setGeography(locations, coordinates);
  setRoutes(generateRoutes(locations, WORLD_GEN_SEED, maxRouteDistance));

  const availableHomePorts = locations.map((l) => l.name).filter((name) => !FUEL_DEPOT_NAMES.includes(name));

  // Total org count stays derived from the contract-calibrated baseline (5
  // ships/location); the arbitrage buffer below grows each org beyond
  // shipsPerCompany, so the actual fleet ends up bigger than that baseline
  // by design -- see arbitrageShipFraction. Orgs used to split 50/50 into
  // Company/SoloTrader by index parity; SoloTrader keeps exactly that half
  // (same count, same per-org fleet size as before). Company's half is
  // instead reduced to companyFraction * locations.length, with each
  // Company's own fleet grown (ships distributed as evenly as the integer
  // math allows) so the total ship count Companies collectively own -- and
  // therefore the grand total across Companies + SoloTraders -- matches
  // exactly what the old 50/50 split would have produced.
  const targetFleetSize = Math.round(locations.length * targetShipsPerLocation);
  const totalOrgs = Math.max(1, Math.round(targetFleetSize / shipsPerCompany));
  const extraShipsPerCompany = Math.ceil(shipsPerCompany * arbitrageShipFraction);
  const actualShipsPerCompany = shipsPerCompany + extraShipsPerCompany;

  const numSoloTraders = Math.floor(totalOrgs / 2);
  const oldNumCompanies = totalOrgs - numSoloTraders;
  const companyShipSubtotal = oldNumCompanies * actualShipsPerCompany;
  const numCompanies = Math.max(1, Math.round(locations.length * companyFraction));
  const baseShipsPerCompany = Math.floor(companyShipSubtotal / numCompanies);
  const extraShipCompanyCount = companyShipSubtotal - baseShipsPerCompany * numCompanies;

  const fleetSize = companyShipSubtotal + numSoloTraders * actualShipsPerCompany;
  const fleetRng = new Rng(99);
  const shuffledHomePorts = fleetRng.sample(availableHomePorts, availableHomePorts.length);
  const homePorts = Array.from({ length: fleetSize }, (_, i) => shuffledHomePorts[i % shuffledHomePorts.length]);
  const shipClassNames = Object.keys(SHIP_CLASSES);

  const fleetCrew: Array<[Transport, Captain, string]> = homePorts.map((homePort, i) => {
    const shipClass = SHIP_CLASSES[shipClassNames[i % shipClassNames.length]];
    const transport = shipClass.clone({ name: `Ship-${pad2(i + 1)}`, crewRequirement: fleetRng.randint(1, 5) });
    const captain = new Captain(
      randomName(fleetRng, DUTCH_FIRST_NAMES, DUTCH_LAST_NAMES),
      homePort,
      null,
      1.25,
      0.012 + 0.002 * (i % 5),
    );
    return [transport, captain, homePort];
  });

  const cashPerShip = 10_000.0;
  const companies: Company[] = [];
  let cursor = 0;
  // The first extraShipCompanyCount Companies get one extra ship each, so
  // shipsThisCompany sums to exactly companyShipSubtotal across all of them
  // (integer division alone would leave a remainder unallocated).
  for (let i = 0; i < numCompanies; i++) {
    const shipsThisCompany = baseShipsPerCompany + (i < extraShipCompanyCount ? 1 : 0);
    const crew = fleetCrew.slice(cursor, cursor + shipsThisCompany);
    cursor += shipsThisCompany;
    if (crew.length === 0) continue;
    companies.push(new Company(`Company ${pad3(i + 1)}`, crew, cashPerShip * crew.length));
  }
  for (let i = 0; i < numSoloTraders; i++) {
    const crew = fleetCrew.slice(cursor, cursor + actualShipsPerCompany);
    cursor += actualShipsPerCompany;
    if (crew.length === 0) continue;
    companies.push(new SoloTrader(`Solo ${pad3(i + 1)}`, crew, cashPerShip * crew.length));
  }

  const factions: Faction[] = [...companies];

  const world = new World({
    locations,
    globalEventProbability: 0.006,
    localEventProbability: 0.008,
    locationEventProbability: 0.004,
    worldwideEventProbability: 0.002,
    locationClosureProbability: 0.0015,
    companyEventProbability: 0.005,
    seed,
    factions,
    numPoliceShips: 0,
    contractOptions: options.contractOptions,
  });

  return { world, factions };
}
