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
import { Route, routeKey, type RouteType } from "./routes";
import { PoliticalEntity, type PoliticalEntityType } from "./politicalEntity";
import { Ship, WagonTrain, Plane, Spaceship, Lorry, FreightTrain, type Transport } from "./transport";
import { Captain } from "./captain";
import { Company, SoloTrader, type Faction, type FleetCrew } from "./faction";
import { World } from "./world";
import { setCommodities, setGeography } from "./worldData";
import { setRoutes } from "./routes";
import type { BuiltWorld } from "./buildWorld";

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
  commodities?: JsonCommodity[];
  locations?: JsonLocation[];
  politicalEntities?: JsonPoliticalEntity[];
  companies?: JsonCompany[];
  routes?: JsonRoute[];
}

const VALID_POLITICAL_ENTITY_TYPES = new Set<PoliticalEntityType>(["Universal", "Planet", "Country", "State"]);
const VALID_ROUTE_TYPES = new Set<RouteType>(["Land", "Air", "Sea", "Space", "Road", "Railroad"]);

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

  // 3. Build the route network (Route's constructor reads LOCATION_COORDINATES,
  // so this must run after setGeography). A route referencing a missing
  // location id is skipped rather than aborting the whole load.
  const routes = new Map<string, Route>();
  for (const r of jsonRoutes) {
    const originName = idToName.get(r.locationAId);
    const destName = idToName.get(r.locationBId);
    if (originName === undefined || destName === undefined || originName === destName) continue;
    const routeType = VALID_ROUTE_TYPES.has(r.routeType as RouteType) ? (r.routeType as RouteType) : "Sea";
    const controlPointCount = Array.isArray(r.controlPoints) ? r.controlPoints.length : 0;
    routes.set(routeKey(originName, destName), new Route(originName, destName, routeType, undefined, controlPointCount));
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
  const politicalEntities: PoliticalEntity[] = jsonPoliticalEntities.map((pe) => {
    const type = VALID_POLITICAL_ENTITY_TYPES.has(pe.type as PoliticalEntityType)
      ? (pe.type as PoliticalEntityType)
      : "Universal";
    return new PoliticalEntity(pe.name, membersByEntityId.get(pe.id) ?? [], undefined, type);
  });

  // 5. Build the merchant fleet. The editor doesn't model a captain's home
  // port, so home ports are handed out round-robin across the locations.
  // Faction subclass mirrors the editor's own factionType(): exactly one
  // ship -> SoloTrader (its constructor requires it), otherwise Company.
  const homePorts = locations.map((l) => l.name);
  let homePortCursor = 0;
  const factions: Faction[] = [];
  for (const company of jsonCompanies) {
    const crew: FleetCrew = company.fleet.map((member) => {
      const transport = makeTransport(member.transportType, member.transportName);
      const homePort = homePorts[homePortCursor % homePorts.length];
      homePortCursor += 1;
      const captain = new Captain(member.captainName, homePort);
      return [transport, captain, homePort];
    });
    if (crew.length === 1) {
      factions.push(new SoloTrader(company.name, crew, company.startingFunds));
    } else {
      factions.push(new Company(company.name, crew, company.startingFunds));
    }
  }

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
