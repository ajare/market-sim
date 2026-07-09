/**
 * Builds the default procedurally generated world + fleet -- the
 * procedural branch of cli.py's build_world() (the CSV branches are
 * sim/csv_loaders.py, explicitly deferred to a later phase). Same fixed
 * RNG seeds, fleet shape, and event probabilities as the Python original.
 */
import { Rng } from "./rng";
import {
  ALL_LOCATION_NAMES, COMMODITIES, FUEL_DEPOT_NAMES, WORLD_GEN_SEED,
  generateLocations, generateCoordinates, setGeography,
} from "./worldData";
import { generateRoutes, setRoutes } from "./routes";
import { SHIP_CLASSES, type Transport } from "./transport";
import { Captain } from "./captain";
import { DUTCH_FIRST_NAMES, DUTCH_LAST_NAMES, randomName } from "./names";
import { Faction, Company, SoloTrader } from "./faction";
import { World } from "./world";

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
  /** Total ships is ~ locations.length * this. Default 480/33 (the calibrated ratio). */
  targetShipsPerLocation?: number;
  /** Ships grouped into each Company. Default 5. */
  shipsPerCompany?: number;
}

const DEFAULT_SEED = 42;
// Fleet is sized off the number of Locations, not a hardcoded count, so it
// scales if the location roster changes (e.g. a CSV-driven world). The ratio
// is fixed to 480/33 to reproduce the specific 96-company/480-ship fleet that
// was validated to land near the stockpile target.
//
// IMPORTANT (see the chaos diagnosis, `analysis.ts`): the stockpile-vs-minimum
// metric is a high-variance, seed-sensitive estimator -- one run carries a
// ~0.05 SD of pure Monte-Carlo noise, so nudging TARGET_SHIPS_PER_LOCATION and
// reading a single run tells you almost nothing at fine resolution. To retune
// this ratio, average many seeds per candidate value (`npm run sweep`), never
// a lone run.
const DEFAULT_TARGET_SHIPS_PER_LOCATION = 480 / 33;
const DEFAULT_SHIPS_PER_COMPANY = 5;

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

  const locations = generateLocations(ALL_LOCATION_NAMES, COMMODITIES);
  const coordinates = generateCoordinates(ALL_LOCATION_NAMES);
  setGeography(locations, coordinates);
  setRoutes(generateRoutes(locations, WORLD_GEN_SEED, maxRouteDistance));

  const availableHomePorts = locations.map((l) => l.name).filter((name) => !FUEL_DEPOT_NAMES.includes(name));

  const targetFleetSize = Math.round(locations.length * targetShipsPerLocation);
  const numCompanies = Math.max(1, Math.round(targetFleetSize / shipsPerCompany));
  const fleetSize = numCompanies * shipsPerCompany;
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
  for (let i = 0; i < numCompanies; i++) {
    const crew = fleetCrew.slice(i * shipsPerCompany, (i + 1) * shipsPerCompany);
    if (crew.length === 0) continue;
    const FactionCls = i % 2 === 0 ? Company : SoloTrader;
    companies.push(new FactionCls(`Company ${pad3(i + 1)}`, crew, cashPerShip * crew.length));
  }

  const factions: Faction[] = [...companies];

  const world = new World({
    locations,
    globalEventProbability: 0.06,
    localEventProbability: 0.08,
    locationEventProbability: 0.04,
    worldwideEventProbability: 0.02,
    locationClosureProbability: 0.015,
    companyEventProbability: 0.05,
    seed,
    factions,
    numPoliceShips: 0,
  });

  return { world, factions };
}
