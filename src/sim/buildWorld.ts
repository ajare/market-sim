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
import {
  DUTCH_FIRST_NAMES, DUTCH_LAST_NAMES, SPANISH_FIRST_NAMES, SPANISH_LAST_NAMES, randomName,
} from "./names";
import { Faction, Company, SoloTrader, PirateBrigade } from "./faction";
import { World } from "./world";

export interface BuiltWorld {
  world: World;
  factions: Faction[];
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Builds a full World plus its Factions, procedurally, without running any
 * days. `maxRouteDistance` prunes the generated route network down to
 * pairs within that distance (matching exp-ui's SimState.reset(), which
 * passes 1000); pass `undefined` for an uncapped network (cli.py's
 * default).
 */
export function buildWorld(maxRouteDistance: number | undefined = 1000): BuiltWorld {
  const locations = generateLocations(ALL_LOCATION_NAMES, COMMODITIES);
  const coordinates = generateCoordinates(ALL_LOCATION_NAMES);
  setGeography(locations, coordinates);
  setRoutes(generateRoutes(locations, WORLD_GEN_SEED, maxRouteDistance));

  const availableHomePorts = locations.map((l) => l.name).filter((name) => !FUEL_DEPOT_NAMES.includes(name));

  // A 20-transport fleet spread across the network, organized into 4
  // companies (2 pooling Company, 2 non-pooling SoloTrader), ship classes
  // cycling through SHIP_CLASSES for a mix of fast/small and slow/large.
  const fleetRng = new Rng(99);
  const homePorts = fleetRng.sample(availableHomePorts, Math.min(20, availableHomePorts.length));
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

  const companySpecs: Array<[string, typeof Company]> = [
    ["Atlas Shipping", Company],
    ["Meridian Freight", Company],
    ["Nordic Cargo Co", SoloTrader],
    ["Pacific Trading Co", SoloTrader],
  ];
  const shipsPerCompany = Math.max(1, Math.floor(fleetCrew.length / companySpecs.length));
  const cashPerShip = 10_000.0;
  const companies: Company[] = [];
  companySpecs.forEach(([name, FactionCls], i) => {
    const crew = fleetCrew.slice(i * shipsPerCompany, (i + 1) * shipsPerCompany);
    if (crew.length === 0) return;
    companies.push(new FactionCls(name, crew, cashPerShip * crew.length));
  });

  // Pirate brigades hunting the merchant companies -- Speedsters make
  // natural pirate hulls (cheapest, fastest transport class).
  const pirateRng = new Rng(100);
  const pirateHomePorts = pirateRng.sample(availableHomePorts, Math.min(6, availableHomePorts.length));
  const pirateBrigadeSpecs: Array<{ name: string; homePorts: string[] }> = [
    { name: "Blackwater Raiders", homePorts: pirateHomePorts.slice(0, 3) },
    { name: "Crimson Corsairs", homePorts: pirateHomePorts.slice(3, 6) },
  ];

  const pirateBrigades: PirateBrigade[] = [];
  for (const spec of pirateBrigadeSpecs) {
    if (spec.homePorts.length === 0) continue;
    const crew: Array<[Transport, Captain, string]> = spec.homePorts.map((homePort, i) => {
      const transport = SHIP_CLASSES.Speedster.clone({
        name: `${spec.name.split(" ")[0]}-${pad2(i + 1)}`,
        crewRequirement: pirateRng.randint(1, 5),
      });
      const captain = new Captain(randomName(pirateRng, SPANISH_FIRST_NAMES, SPANISH_LAST_NAMES), homePort);
      return [transport, captain, homePort];
    });
    pirateBrigades.push(
      new PirateBrigade(spec.name, crew, companies, 3_000.0 * spec.homePorts.length),
    );
  }

  const factions: Faction[] = [...companies, ...pirateBrigades];

  const world = new World({
    locations,
    globalEventProbability: 0.06,
    localEventProbability: 0.08,
    locationEventProbability: 0.04,
    worldwideEventProbability: 0.02,
    locationClosureProbability: 0.015,
    companyEventProbability: 0.05,
    seed: 42,
    factions,
  });

  return { world, factions };
}
