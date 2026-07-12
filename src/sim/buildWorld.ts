/**
 * Builds the default procedurally generated world + fleet -- the
 * procedural branch of cli.py's build_world() (the CSV branches are
 * sim/csv_loaders.py, explicitly deferred to a later phase). Same fixed
 * RNG seeds, fleet shape, and event probabilities as the Python original.
 */
import { Rng } from "./rng";
import {
  ALL_LOCATION_NAMES, COMMODITIES, FUEL_DEPOT_NAMES, WORLD_GEN_SEED,
  DEFAULT_MIN_STOCKPILE_DAYS, DEFAULT_CONSUMED_STOCKPILE_FACTOR, DEFAULT_LOCATIONS_PER_POLITICAL_ENTITY,
  generateLocations, generateCoordinates, setGeography, assignPoliticalEntities,
} from "./worldData";
import type { Commodity } from "./commodity";
import type { PoliticalEntity } from "./politicalEntity";
import { generateRoutes, setRoutes, ROUTES } from "./routes";
import { SHIP_CLASSES, type Transport } from "./transport";
import { Captain } from "./captain";
import { DUTCH_NAMES, randomName } from "./names";
import { DUTCH_SHIP_NAMES, randomShipName } from "./shipNames";
import { DUTCH_COMPANY_NAMES, randomCompanyName } from "./companyNames";
import { Faction, Company, SoloTrader } from "./faction";
import { World } from "./world";
import type { TenderContractsOptions } from "./contracts";

export interface BuiltWorld {
  world: World;
  factions: Faction[];
  politicalEntities: PoliticalEntity[];
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
  /** Target Locations grouped into each PoliticalEntity (by proximity -- see worldData.assignPoliticalEntities). Default worldData.DEFAULT_LOCATIONS_PER_POLITICAL_ENTITY (5). The last PoliticalEntity may end up smaller if locations.length doesn't divide evenly. */
  locationsPerPoliticalEntity?: number;
  /** Ship count for the single PirateBrigade, forwarded to World -- see WorldInit.numPirateShips. Default DEFAULT_NUM_PIRATE_SHIPS. Set to 0 to build a pirate-free world, e.g. for sweeps isolating their effect on the stockpile metric. */
  numPirateShips?: number;
  /** Starting cash per PirateBrigade ship (that ship's own captain's private balance). Default DEFAULT_PIRATE_CASH_PER_SHIP (5,000). */
  pirateCashPerShip?: number;
  /** Coast Guard ship count, forwarded to World -- see WorldInit.numPoliceShips. Default DEFAULT_NUM_POLICE_SHIPS. */
  numPoliceShips?: number;
  /** Override applied to every generated Location's `contractThresholdFraction` (see location.ts's DEFAULT_CONTRACT_THRESHOLD_FRACTION). Default: each Location keeps its own class default (1.5). */
  contractThresholdFraction?: number;
  /**
   * If true, ignore `minStockpileDays` and derive it instead from the
   * generated route network's total length: `11 * (totalRouteLength /
   * BASELINE_TOTAL_ROUTE_LENGTH)`. Empirically (bisected against the
   * fraction of zero-stock days, not just the coarser stockpile-vs-minimum
   * ratio -- 9x undershoots, landing an 11.22% mean zero-stock fraction
   * across 5 seeds vs. the <10% target; 11x clears it with margin at 8.38%
   * mean / 9.31% max; 12x barely improves on that for extra buffer stock
   * tied up), a location needs roughly 11 days of buffer per multiple of
   * `BASELINE_TOTAL_ROUTE_LENGTH` the world's routes add up to -- expressing
   * that in terms of total route length (rather than a hardcoded days
   * number) generalizes to a custom `locationNames`/`maxRouteDistance` world
   * where the "right" buffer isn't obvious upfront. Default false.
   */
  autoMinStockpileDaysFromRoutes?: boolean;
}

/**
 * Total Route.distance summed across the default 30-location + 3-depot
 * world's route network at the geography's original (pre-3x) scale,
 * maxRouteDistance=1000 -- the fixed reference point
 * `autoMinStockpileDaysFromRoutes` normalizes against. Recompute this (sum
 * `ROUTES.values()` distances right after a plain `buildWorld()`) if the
 * default location/commodity roster or coordinate spread ever changes.
 */
export const BASELINE_TOTAL_ROUTE_LENGTH = 39050.02;

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

/** Ship count for the single World-wide PirateBrigade -- see WorldInit.numPirateShips. Matches the fleet size the old fraction-of-merchant-fleet sizing produced at the default ratios. */
export const DEFAULT_NUM_PIRATE_SHIPS = 20;

/**
 * Starting cash given to each PirateBrigade ship (its own captain's private
 * balance -- PirateBrigade.poolsCash is false). Unlike a Company/SoloTrader,
 * a broke pirate captain can't even afford the fuel to reposition toward a
 * target (departEmptyTo bails if repositionFuelCost > cash) or the daily
 * carousing cost, so a $0 start (the old default before this constant was
 * added) left most of the fleet stranded at its home port for good stretches
 * of a run, only earning anything when a victim happened to wander in --
 * see the 365-day activity-report investigation this constant came out of.
 */
export const DEFAULT_PIRATE_CASH_PER_SHIP = 5_000.0;

/**
 * Coast Guard ship count buildWorld hands to World (see WorldInit.numPoliceShips)
 * -- calibrated (8-seed average, 365-day runs) so a year-long run lands
 * around ~100 successful pirate attacks. Re-calibrated after PirateBrigade
 * became a single World-built faction (previously 4-6 separate,
 * uncoordinated brigades): one coordinated 20-ship brigade hunts far more
 * effectively, so the old value (20, tuned for the fragmented-brigade world)
 * was way too low -- 0 ships now averages 503.1 attacks/year, 40 -> 153.6,
 * 80 -> 78.5, 100 -> 69.0 -- 80 is the closest match. World's own default (3)
 * is sized for a token pirate presence, not this larger PirateBrigade fleet,
 * hence overriding it here.
 */
export const DEFAULT_NUM_POLICE_SHIPS = 80;

/**
 * Builds a full World plus its Factions, procedurally, without running any
 * days. `maxRouteDistance` prunes the generated route network down to
 * pairs within that distance (matching exp-ui's SimState.reset(), which
 * passes 3000); pass `undefined` for an uncapped network (cli.py's
 * default). `options` tweaks the dynamics seed and fleet sizing for sweeps
 * -- omit it entirely for the default world.
 */
export function buildWorld(
  maxRouteDistance: number | undefined = 3000,
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
  let minStockpileDays = options.minStockpileDays ?? DEFAULT_MIN_STOCKPILE_DAYS;
  const consumedStockpileFactor = options.consumedStockpileFactor ?? DEFAULT_CONSUMED_STOCKPILE_FACTOR;
  const locationsPerPoliticalEntity = options.locationsPerPoliticalEntity ?? DEFAULT_LOCATIONS_PER_POLITICAL_ENTITY;
  const numPirateShips = options.numPirateShips ?? DEFAULT_NUM_PIRATE_SHIPS;
  const pirateCashPerShip = options.pirateCashPerShip ?? DEFAULT_PIRATE_CASH_PER_SHIP;
  const numPoliceShips = options.numPoliceShips ?? DEFAULT_NUM_POLICE_SHIPS;

  let locations = generateLocations(
    locationNames, commodities, WORLD_GEN_SEED, consumedStockpileFactor, minPerRole, maxPerRole, minStockpileDays,
  );
  if (options.contractThresholdFraction !== undefined) {
    for (const location of locations) location.contractThresholdFraction = options.contractThresholdFraction;
  }
  const coordinates = generateCoordinates(locationNames);
  setGeography(locations, coordinates);
  setRoutes(generateRoutes(locations, WORLD_GEN_SEED, maxRouteDistance));

  // Regenerate locations against a route-derived minStockpileDays now that
  // the route network (and therefore its total length) exists. Safe to redo
  // from scratch: generateLocations' RNG draw sequence never depends on
  // minStockpileDays (it only scales the derived minStockpiles/stockpiles
  // values at the end), so this reproduces identical produced/consumed
  // rates and terminal types, just with different stockpile targets.
  if (options.autoMinStockpileDaysFromRoutes) {
    let totalRouteLength = 0;
    for (const route of ROUTES.values()) totalRouteLength += route.distance;
    minStockpileDays = 11 * (totalRouteLength / BASELINE_TOTAL_ROUTE_LENGTH);
    locations = generateLocations(
      locationNames, commodities, WORLD_GEN_SEED, consumedStockpileFactor, minPerRole, maxPerRole, minStockpileDays,
    );
    if (options.contractThresholdFraction !== undefined) {
      for (const location of locations) location.contractThresholdFraction = options.contractThresholdFraction;
    }
    setGeography(locations, coordinates);
  }
  // Grouped by proximity only once coordinates are set (assignPoliticalEntities
  // reads them via distanceBetween) -- own seed stream (WORLD_GEN_SEED + 3),
  // independent of location/coordinate/route generation and the fleet.
  const politicalEntities = assignPoliticalEntities(locations, WORLD_GEN_SEED + 3, locationsPerPoliticalEntity);

  const availableHomePorts = locations.map((l) => l.name).filter((name) => !FUEL_DEPOT_NAMES.includes(name));

  // Total org count stays derived from the contract-calibrated baseline (5
  // ships/location); the arbitrage buffer below grows each org beyond
  // shipsPerCompany, so the actual fleet ends up bigger than that baseline
  // by design -- see arbitrageShipFraction. Orgs used to split 50/50 into
  // Company/SoloTrader by index parity; numSoloTraders * actualShipsPerCompany
  // (the ship count that half would have owned under the old 50/50 split) is
  // still used as the total ship count SoloTraders collectively own -- but
  // each SoloTrader now crews exactly one ship (see SoloTrader's constructor
  // validation), so that many individual single-ship SoloTraders are created
  // instead of numSoloTraders multi-ship ones. Company's half is instead
  // reduced to companyFraction * locations.length, with each Company's own
  // fleet grown (ships distributed as evenly as the integer math allows) so
  // the total ship count Companies collectively own -- and therefore the
  // grand total across Companies + SoloTraders -- matches exactly what the
  // old 50/50 split would have produced.
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
    const transport = shipClass.clone({ name: randomShipName(fleetRng, DUTCH_SHIP_NAMES), crewRequirement: fleetRng.randint(1, 5) });
    const captain = new Captain(
      randomName(fleetRng, DUTCH_NAMES),
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
    companies.push(new Company(randomCompanyName(fleetRng, DUTCH_COMPANY_NAMES), crew, cashPerShip * crew.length));
  }
  // Each SoloTrader crews exactly one ship (see SoloTrader's constructor
  // validation) -- the org count below is scaled up accordingly so the
  // total ship count owned by SoloTraders collectively is unchanged.
  const soloTraderShipCount = numSoloTraders * actualShipsPerCompany;
  for (let i = 0; i < soloTraderShipCount; i++) {
    const crew = fleetCrew.slice(cursor, cursor + 1);
    cursor += 1;
    if (crew.length === 0) continue;
    companies.push(new SoloTrader(randomCompanyName(fleetRng, DUTCH_COMPANY_NAMES), crew, cashPerShip * crew.length));
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
    numPoliceShips,
    numPirateShips,
    pirateStartingCash: pirateCashPerShip * numPirateShips,
    contractOptions: options.contractOptions,
  });

  return { world, factions, politicalEntities };
}
