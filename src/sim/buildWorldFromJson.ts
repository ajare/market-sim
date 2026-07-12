/**
 * Builds a live, runnable World from the JSON a World authored in the editor
 * exports to the clipboard (editor/src/worldJson.ts's EditorWorld shape).
 * This is the hand-authored counterpart to buildWorld.ts's procedural
 * generation: instead of drawing locations/commodities/fleets from seeded
 * RNG, it constructs them directly from the pasted data, then wires up the
 * same module-level world state (COMMODITIES / LOCATIONS / LOCATION_COORDINATES
 * / ROUTES) and the same World object the sim UI already drives.
 *
 * Every parse/validation failure throws an Error with a human-readable
 * message so the caller can surface it (see ControlsPanel's "Paste World"
 * button) rather than the paste silently doing nothing.
 */
import { Commodity } from "./commodity";
import { Location, type TerminalType } from "./location";
import { Route, addRouteToNetwork, type RouteType } from "./routes";
import { PoliticalEntity, type PoliticalEntityType } from "./politicalEntity";
import { Ship, WagonTrain, Plane, Spaceship, Lorry, FreightTrain, SHIP_CLASSES, type Transport } from "./transport";
import { Captain } from "./captain";
import { Company, SoloTrader, type Faction, type FleetCrew } from "./faction";
import { World } from "./world";
import { setCommodities, setGeography, setDistanceConfig } from "./worldData";
import { setRoutes } from "./routes";
import { DEFAULT_GLOBE_LON_SPAN, type DistanceMode } from "./distance";
import { Rng } from "./rng";
import { randomName } from "./names";
import { randomShipName } from "./shipNames";
import { randomCompanyName } from "./companyNames";
import {
  NATIONALITY_POOLS, randomNationality, isNationality, DEFAULT_NATIONALITY, type Nationality,
} from "./nationality";
import { DEFAULT_TARGET_SHIPS_PER_LOCATION, type BuiltWorld } from "./buildWorld";

// --- The editor's exported JSON shape (mirrors editor/src/types.ts +
// worldJson.ts). Kept as a local, permissive description here rather than
// imported across app boundaries, since the sim app and the editor app are
// separate builds. ---

interface JsonCommodity {
  name: string;
  basePrice: number;
  productionRate: number;
  consumptionRate: number;
}

interface JsonLocation {
  id: string;
  name: string;
  x: number;
  y: number;
  politicalEntityId: string;
  producedCommodities: Record<string, number>;
  consumedCommodities: Record<string, number>;
  stockpiles: Record<string, number>;
  minStockpiles: Record<string, number>;
  basePriceModifiers: Record<string, number>;
  fuelPrice: number;
  terminalTypes: string[];
}

interface JsonPoliticalEntity {
  id: string;
  name: string;
  type: string;
  /** Cultural nationality for name generation (see nationality.ts). Absent in pre-v4 files, which default to DEFAULT_NATIONALITY. */
  nationality?: string;
}

interface JsonFleetMember {
  id: string;
  transportType: string;
  transportName: string;
  captainName: string;
}

interface JsonCompany {
  id: string;
  name: string;
  startingFunds: number;
  fleet: JsonFleetMember[];
  /** The PoliticalEntity this Company is affiliated with, or null/absent for an independent operator. */
  politicalEntityId?: string | null;
}

interface JsonRoute {
  id: string;
  locationAId: string;
  locationBId: string;
  routeType: string;
  // A Route's shape is derived from its control points (see routes.ts); the
  // editor exports them, and we only need how many to rebuild the same curve.
  controlPoints?: unknown[];
}

interface JsonWorld {
  // The editor exports Location/control-point positions already multiplied by
  // worldScale, i.e. as world coordinates -- so this loader consumes them
  // directly and never needs worldScale itself.
  worldScale?: number;
  // How distances are measured -- "flat" (Euclidean, the default) or "globe"
  // (great-circle). globeRadius/globeLonSpan only matter in globe mode. Absent
  // in pre-v3 files, which are all flat. See distance.ts.
  distanceMode?: string;
  globeRadius?: number;
  globeLonSpan?: number;
  commodities?: JsonCommodity[];
  locations?: JsonLocation[];
  politicalEntities?: JsonPoliticalEntity[];
  companies?: JsonCompany[];
  routes?: JsonRoute[];
}

const VALID_POLITICAL_ENTITY_TYPES = new Set<PoliticalEntityType>(["Universal", "Planet", "Country", "State"]);
const VALID_ROUTE_TYPES = new Set<RouteType>(["Land", "Air", "Sea", "Space", "Road", "Railroad"]);

/** Share of the required ship count that should be crewed by (1-ship) Independent SoloTraders -- see the fleet-synthesis block. */
const SOLO_TRADER_FRACTION = 0.2;
/** Starting cash granted per synthesized ship (a new SoloTrader's balance, or added to a Company's for each ship distributed onto it). Mirrors buildWorld's cashPerShip. */
const SYNTH_CASH_PER_SHIP = 10_000;
/** Fixed seed for the synthesized-fleet RNG, so a given World JSON always yields the same made-up ships, captains, and names. */
const SYNTH_FLEET_SEED = 4242;

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** Instantiates the Transport subclass named by the editor's TransportType. Defaults to a Ship for an unrecognized type rather than failing the whole load. */
function makeTransport(transportType: string, name: string): Transport {
  switch (transportType) {
    case "WagonTrain":
      return new WagonTrain({ name });
    case "Plane":
      return new Plane({ name });
    case "Spaceship":
      return new Spaceship({ name });
    case "Lorry":
      return new Lorry({ name });
    case "FreightTrain":
      return new FreightTrain({ name });
    default:
      return new Ship({ name });
  }
}

/**
 * Parses `text` as an editor World JSON and builds a live World from it.
 * Throws on invalid JSON, a non-World object, or an empty World (no
 * locations), and lets the domain constructors' own validation errors (e.g.
 * World's 20-50 location bound, Location's terminal/commodity checks)
 * propagate as the "cannot be created" reason.
 */
export function buildWorldFromJson(text: string): BuiltWorld {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Clipboard does not contain valid JSON.");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Clipboard JSON is not a World object.");
  }
  const world = raw as JsonWorld;

  const jsonCommodities = asArray<JsonCommodity>(world.commodities);
  const jsonLocations = asArray<JsonLocation>(world.locations);
  const jsonPoliticalEntities = asArray<JsonPoliticalEntity>(world.politicalEntities);
  const jsonCompanies = asArray<JsonCompany>(world.companies);
  const jsonRoutes = asArray<JsonRoute>(world.routes);

  if (jsonLocations.length === 0) {
    throw new Error("World has no locations.");
  }

  // 1. Register the commodity roster so Location.productionRate/basePrice/etc.
  // resolve against the authored rates and prices, not the defaults.
  const commodityRecord: Record<string, Commodity> = {};
  for (const c of jsonCommodities) {
    commodityRecord[c.name] = new Commodity(
      c.name, c.basePrice, undefined, undefined, undefined, [], c.productionRate, c.consumptionRate,
    );
  }
  setCommodities(commodityRecord);

  // 2. Build Location objects and their coordinate map. editorId -> name is
  // kept so Routes (which reference editor location ids) can resolve to names.
  const idToName = new Map<string, string>();
  const coordinates: Record<string, [number, number]> = {};
  const locations: Location[] = jsonLocations.map((loc) => {
    idToName.set(loc.id, loc.name);
    coordinates[loc.name] = [loc.x, loc.y];
    return new Location({
      name: loc.name,
      producedCommodities: { ...loc.producedCommodities },
      consumedCommodities: { ...loc.consumedCommodities },
      stockpiles: { ...loc.stockpiles },
      minStockpiles: { ...loc.minStockpiles },
      basePriceModifiers: { ...loc.basePriceModifiers },
      fuelPrice: loc.fuelPrice,
      terminalTypes: new Set(loc.terminalTypes as TerminalType[]),
    });
  });
  setGeography(locations, coordinates);

  // 2b. Install the distance mode BEFORE building routes, since a Route's
  // length is measured under it (see distance.ts / Route's constructor). A
  // valid worldScale is needed to recover normalized [0,1] fractions from the
  // world coordinates for globe mode; flat mode ignores it.
  const worldScale =
    typeof world.worldScale === "number" && world.worldScale > 0 ? world.worldScale : 1;
  const distanceMode: DistanceMode = world.distanceMode === "globe" ? "globe" : "flat";
  setDistanceConfig({
    mode: distanceMode,
    radius: typeof world.globeRadius === "number" && world.globeRadius > 0 ? world.globeRadius : 1,
    lonSpan:
      typeof world.globeLonSpan === "number" && world.globeLonSpan > 0
        ? world.globeLonSpan
        : DEFAULT_GLOBE_LON_SPAN,
    worldScale,
  });

  // 3. Build the route network (Route's constructor reads LOCATION_COORDINATES,
  // so this must run after setGeography). A route referencing a missing
  // location id is skipped rather than aborting the whole load. A location pair
  // may have several routes of different types; addRouteToNetwork groups them
  // and drops a duplicate type on the same pair (see routes.ts).
  const routes = new Map<string, Route[]>();
  for (const r of jsonRoutes) {
    const originName = idToName.get(r.locationAId);
    const destName = idToName.get(r.locationBId);
    if (originName === undefined || destName === undefined || originName === destName) continue;
    const routeType = VALID_ROUTE_TYPES.has(r.routeType as RouteType) ? (r.routeType as RouteType) : "Sea";
    const controlPointCount = Array.isArray(r.controlPoints) ? r.controlPoints.length : 0;
    addRouteToNetwork(routes, new Route(originName, destName, routeType, undefined, controlPointCount));
  }
  setRoutes(routes);

  // 4. Group Locations into PoliticalEntities by the editor's membership.
  const locationByName = new Map(locations.map((loc) => [loc.name, loc]));
  const membersByEntityId = new Map<string, Location[]>();
  for (const loc of jsonLocations) {
    const built = locationByName.get(loc.name);
    if (built === undefined) continue;
    const list = membersByEntityId.get(loc.politicalEntityId) ?? [];
    list.push(built);
    membersByEntityId.set(loc.politicalEntityId, list);
  }
  const entityByJsonId = new Map<string, PoliticalEntity>();
  const politicalEntities: PoliticalEntity[] = jsonPoliticalEntities.map((pe) => {
    const type = VALID_POLITICAL_ENTITY_TYPES.has(pe.type as PoliticalEntityType)
      ? (pe.type as PoliticalEntityType)
      : "Universal";
    const nationality = isNationality(pe.nationality) ? pe.nationality : DEFAULT_NATIONALITY;
    const entity = new PoliticalEntity(pe.name, membersByEntityId.get(pe.id) ?? [], undefined, type, nationality);
    entityByJsonId.set(pe.id, entity);
    return entity;
  });

  // 5. Build the merchant fleet. The editor doesn't model a captain's home
  // port, so home ports are handed out round-robin across the locations.
  const homePorts = locations.map((l) => l.name);
  let homePortCursor = 0;
  const nextHomePort = (): string => {
    const port = homePorts[homePortCursor % homePorts.length];
    homePortCursor += 1;
    return port;
  };

  // Deterministic RNG for every synthesized ship/captain/name below.
  const fleetRng = new Rng(SYNTH_FLEET_SEED);
  const shipClassNames = Object.keys(SHIP_CLASSES);
  let genShipIndex = 0;
  // A freshly generated (Transport, Captain, homePort) slot named in
  // `nationality`, mirroring buildWorld's ship-class cycling / captain params.
  const generateCrewSlot = (nationality: Nationality): [Transport, Captain, string] => {
    const pools = NATIONALITY_POOLS[nationality];
    const shipClass = SHIP_CLASSES[shipClassNames[genShipIndex % shipClassNames.length]];
    const transport = shipClass.clone({
      name: randomShipName(fleetRng, pools.ships),
      crewRequirement: fleetRng.randint(1, 5),
    });
    const homePort = nextHomePort();
    const captain = new Captain(
      randomName(fleetRng, pools.names), homePort, null, 1.25, 0.012 + 0.002 * (genShipIndex % 5),
    );
    genShipIndex += 1;
    return [transport, captain, homePort];
  };

  // The authored companies: their JSON-defined ships (kept in order), plus the
  // nationality any ships later synthesized onto them will use -- the entity's
  // nationality if affiliated, else a seeded-random one (drawn once per faction).
  interface PendingFaction {
    name: string;
    startingFunds: number;
    entity: PoliticalEntity | null;
    nationality: Nationality;
    crew: FleetCrew;
  }
  const pending: PendingFaction[] = jsonCompanies.map((company) => {
    const crew: FleetCrew = company.fleet.map((member) => {
      const transport = makeTransport(member.transportType, member.transportName);
      const homePort = nextHomePort();
      return [transport, new Captain(member.captainName, homePort), homePort];
    });
    const entity = company.politicalEntityId != null
      ? entityByJsonId.get(company.politicalEntityId) ?? null
      : null;
    const nationality = entity !== null ? entity.nationality : randomNationality(fleetRng);
    return { name: company.name, startingFunds: company.startingFunds, entity, nationality, crew };
  });

  // 5b. Size the fleet up to the required ship count (per the grilled spec):
  //   required  = round(locations * 5)               -- the calibrated minimum
  //   remainder = required - ships already defined
  //   newSolo   = round(0.2 * required)  (capped at remainder)
  //               -> that many NEW Independent SoloTraders (1 ship each)
  //   the rest  = spread round-robin over the JSON's companies (any size --
  //               a 1-ship company gets bulked up into a multi-ship Company).
  //               Only if the world defines NO companies at all do these become
  //               SoloTraders too. So only ~20% of the fleet is SoloTraders;
  //               the rest lands on the authored companies.
  // If the world already has at least `required` ships, nothing is added.
  const required = Math.round(locations.length * DEFAULT_TARGET_SHIPS_PER_LOCATION);
  const existingShips = pending.reduce((sum, f) => sum + f.crew.length, 0);
  const remainder = required - existingShips;

  const newSoloTraders: SoloTrader[] = [];
  if (remainder > 0) {
    let newSolo = Math.min(remainder, Math.round(SOLO_TRADER_FRACTION * required));
    let companyShipsToAdd = remainder - newSolo;

    if (pending.length === 0) {
      // No companies to distribute to -> the rest become SoloTraders too.
      newSolo += companyShipsToAdd;
      companyShipsToAdd = 0;
    } else {
      for (let i = 0; i < companyShipsToAdd; i++) {
        const target = pending[i % pending.length];
        target.crew.push(generateCrewSlot(target.nationality));
        target.startingFunds += SYNTH_CASH_PER_SHIP;
      }
    }

    for (let i = 0; i < newSolo; i++) {
      const nationality = randomNationality(fleetRng);
      const crew: FleetCrew = [generateCrewSlot(nationality)];
      newSoloTraders.push(
        new SoloTrader(randomCompanyName(fleetRng, NATIONALITY_POOLS[nationality].companies), crew, SYNTH_CASH_PER_SHIP),
      );
    }
  }

  // 5c. Construct the (possibly augmented) authored factions, then append the
  // new Independent SoloTraders. Faction subclass mirrors the editor's
  // factionType(): exactly one ship -> SoloTrader, otherwise Company.
  const factions: Faction[] = [];
  for (const f of pending) {
    const faction = f.crew.length === 1
      ? new SoloTrader(f.name, f.crew, f.startingFunds)
      : new Company(f.name, f.crew, f.startingFunds);
    faction.politicalEntity = f.entity;
    factions.push(faction);
  }
  factions.push(...newSoloTraders);

  // 6. Assemble the World. No pirates/police (the editor doesn't model them);
  // event probabilities are irrelevant since random events are disabled.
  const builtWorld = new World({
    locations,
    factions,
    numPirateShips: 0,
    numPoliceShips: 0,
  });

  return { world: builtWorld, factions, politicalEntities };
}
