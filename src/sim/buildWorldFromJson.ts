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
import { Commodity, COMMODITY_TYPES, DEFAULT_COMMODITY_TYPE, type CommodityType } from "./commodity";
import { Location, type TerminalType } from "./location";
import { Route, addRouteToNetwork, type Point, type RouteType } from "./routes";
import { PoliticalEntity, type PoliticalEntityType } from "./politicalEntity";
import { Ship, WagonTrain, Plane, Spaceship, Lorry, FreightTrain, SHIP_CLASSES, type Transport } from "./transport";
import { Captain } from "./captain";
import { Company, SoloTrader, type Faction, type FleetCrew } from "./faction";
import { World } from "./world";
import { setCommodities, setGeography, setDistanceConfig, getLocation, COORDINATE_SPREAD } from "./worldData";
import { locationSupportsFleet, locationSupportsTransport, defaultCompanyHomeLocation } from "./companyHome";
import { setRoutes } from "./routes";
import { DEFAULT_GLOBE_LON_SPAN, type DistanceConfig, type DistanceMode } from "./distance";
import { Rng } from "./rng";
import { randomName } from "./names";
import { randomShipName } from "./shipNames";
import { randomCompanyName } from "./companyNames";
import {
  NATIONALITY_POOLS, randomNationality, isNationality, DEFAULT_NATIONALITY, type Nationality,
} from "./nationality";
import { DEFAULT_TARGET_SHIPS_PER_LOCATION, type BuiltWorld } from "./buildWorld";

/**
 * Optional fleet overrides for buildWorldFromJson -- all default to today's
 * behavior (no pirates/police, the calibrated ships-per-location ratio) when
 * omitted, so the editor's own "paste world" flow is completely unaffected.
 * Added for tooling (see scripts/tune-world.ts) that needs a JSON-authored
 * World to run with a real pirate/police presence and/or a different fleet
 * density, without hand-editing the JSON itself.
 */
export interface BuildWorldFromJsonOptions {
  /**
   * Reseeds the World's own dynamics stream (market events, closures, price
   * noise, daily act-order -- see World's constructor/simRandom.ts), same as
   * buildWorld's own `seed` option. Does NOT affect world-gen (Locations,
   * Routes, PoliticalEntities all come straight from the JSON) or fleet
   * synthesis (see SYNTH_FLEET_SEED below) -- only which random THINGS
   * HAPPEN while the World runs. Default: unseeded (whatever the global
   * simRandom stream's current state is), matching today's behavior.
   */
  seed?: number;
  /** Ships for the single World-wide PirateBrigade -- forwarded to World's numPirateShips. Default 0 (the editor doesn't model pirates). */
  numPirateShips?: number;
  /** Starting cash per PirateBrigade ship, only meaningful when numPirateShips > 0 -- forwarded to World's pirateStartingCash (as pirateCashPerShip * numPirateShips). Default 0. */
  pirateCashPerShip?: number;
  /** Ships for the Coast Guard PoliceFleet -- forwarded to World's numPoliceShips. Default 0 (the editor doesn't model police). */
  numPoliceShips?: number;
  /** Overrides the ships-per-location ratio the fleet-synthesis step (see step 5b below) sizes the fleet against. Default DEFAULT_TARGET_SHIPS_PER_LOCATION (the calibrated default buildWorld itself uses). */
  targetShipsPerLocation?: number;
}

// --- The editor's exported JSON shape (mirrors editor/src/types.ts +
// worldJson.ts). Kept as a local, permissive description here rather than
// imported across app boundaries, since the sim app and the editor app are
// separate builds. ---

interface JsonCommodity {
  name: string;
  basePrice: number;
  productionRate: number;
  consumptionRate: number;
  /** Absent in pre-type-field files, which default to DEFAULT_COMMODITY_TYPE. */
  type?: string;
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
  /**
   * The Location (by editor id) this Company is home-ported at -- absent/invalid/
   * incompatible with its fleet falls back to defaultCompanyHomeLocation.
   * Ignored for a 1-ship company, which is treated as a SoloTrader (no home
   * port at all) -- see the fleet-building step below.
   */
  homeLocationId?: string | null;
}

interface JsonRouteControlPoint {
  x: number;
  y: number;
}

interface JsonRoute {
  id: string;
  locationAId: string;
  locationBId: string;
  routeType: string;
  // A Route's shape comes from these control points, in world coordinates,
  // ordered locationAId -> locationBId (see worldJson.ts's routesToWorld) --
  // used verbatim so an editor-authored curve's geometry, length, fuel cost,
  // and travel time match exactly in the simulation.
  controlPoints?: JsonRouteControlPoint[];
}

function isJsonRouteControlPoint(value: unknown): value is JsonRouteControlPoint {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as JsonRouteControlPoint).x === "number" &&
    typeof (value as JsonRouteControlPoint).y === "number"
  );
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
  /** In-world date/time of day 1, as an ISO 8601 string. Absent in pre-startDate files, which default to World's own DEFAULT_START_DATE. */
  startDate?: string;
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

/** Instantiates the Transport subclass named by the editor's TransportType. Defaults to a Ship for an unrecognized type rather than failing the whole load. `speedScale` rescales the class default speed for this world's effective map size -- see transportSpeedScale below. */
function makeTransport(transportType: string, name: string, speedScale: number): Transport {
  let transport: Transport;
  switch (transportType) {
    case "WagonTrain":
      transport = new WagonTrain({ name });
      break;
    case "Plane":
      transport = new Plane({ name });
      break;
    case "Spaceship":
      transport = new Spaceship({ name });
      break;
    case "Lorry":
      transport = new Lorry({ name });
      break;
    case "FreightTrain":
      transport = new FreightTrain({ name });
      break;
    default:
      transport = new Ship({ name });
      break;
  }
  transport.speedUnitsPerDay *= speedScale;
  return transport;
}

/**
 * Parses `text` as an editor World JSON and builds a live World from it.
 * Throws on invalid JSON, a non-World object, or an empty World (no
 * locations), and lets the domain constructors' own validation errors (e.g.
 * World's 20-50 location bound, Location's terminal/commodity checks)
 * propagate as the "cannot be created" reason.
 */
export function buildWorldFromJson(text: string, options: BuildWorldFromJsonOptions = {}): BuiltWorld {
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
    const type: CommodityType = COMMODITY_TYPES.includes(c.type as CommodityType)
      ? (c.type as CommodityType)
      : DEFAULT_COMMODITY_TYPE;
    commodityRecord[c.name] = new Commodity(
      c.name, c.basePrice, undefined, undefined, undefined, [], c.productionRate, c.consumptionRate, type,
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
  const distanceConfig: DistanceConfig = {
    mode: distanceMode,
    radius: typeof world.globeRadius === "number" && world.globeRadius > 0 ? world.globeRadius : 1,
    lonSpan:
      typeof world.globeLonSpan === "number" && world.globeLonSpan > 0
        ? world.globeLonSpan
        : DEFAULT_GLOBE_LON_SPAN,
    worldScale,
  };
  setDistanceConfig(distanceConfig);

  // Every Transport speed default (transport.ts, SHIP_CLASSES) is calibrated
  // against the procedural world's COORDINATE_SPREAD-unit flat map (see
  // buildWorld.ts). A JSON world's effective map size instead comes from its
  // own worldScale (flat mode) or radius * PI, the antipodal distance (globe
  // mode -- exactly worldScale under the editor's own default radius, see
  // defaultGlobeRadius). Rescale every fleet Transport's speed by the ratio
  // of the two below, so a tiny or huge authored map doesn't make ships
  // cross it in a fraction of a day or crawl for years.
  const effectiveMapScale =
    distanceConfig.mode === "globe" ? distanceConfig.radius * Math.PI : distanceConfig.worldScale;
  const transportSpeedScale = effectiveMapScale / COORDINATE_SPREAD;

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
    const controlPoints: Point[] = Array.isArray(r.controlPoints)
      ? r.controlPoints.filter(isJsonRouteControlPoint).map((p): Point => [p.x, p.y])
      : [];
    addRouteToNetwork(routes, new Route(originName, destName, routeType, undefined, controlPoints));
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

  // 5. Build the merchant fleet. Classification (Company vs. SoloTrader)
  // follows the editor's own factionType() rule from the AUTHORED fleet size
  // -- exactly one ship is a SoloTrader (no home Location; its one ship
  // starts at a random TerminalType-compatible Location), anything else is a
  // real Company (home Location resolved below; every ship in it -- authored
  // or later-synthesized -- starts there).
  // Deterministic RNG for every synthesized ship/captain/name AND every
  // random SoloTrader placement below.
  const fleetRng = new Rng(SYNTH_FLEET_SEED);
  const shipClassNames = Object.keys(SHIP_CLASSES);
  let genShipIndex = 0;
  // A freshly generated (Transport, Captain, homeLocation) slot named in
  // `nationality`, mirroring buildWorld's ship-class cycling / captain
  // params -- always placed at the given `homeLocation` (a Company's fixed
  // home, or a just-picked random spot for a brand-new SoloTrader).
  const generateCrewSlot = (nationality: Nationality, homeLocation: string): [Transport, Captain, string] => {
    const pools = NATIONALITY_POOLS[nationality];
    const shipClass = SHIP_CLASSES[shipClassNames[genShipIndex % shipClassNames.length]];
    // crewRequirement isn't overridden here -- clone() carries over shipClass's
    // own fixed value (see SHIP_CLASSES in transport.ts).
    const transport = shipClass.clone({ name: randomShipName(fleetRng, pools.ships) });
    transport.speedUnitsPerDay *= transportSpeedScale;
    const captain = new Captain(
      randomName(fleetRng, pools.names), homeLocation, null, 1.25, 0.012 + 0.002 * (genShipIndex % 5),
    );
    genShipIndex += 1;
    return [transport, captain, homeLocation];
  };

  /** A random Location (out of the whole World) compatible with every Transport in `transports`. Throws if none qualify. */
  const randomCompatibleLocation = (transports: readonly Transport[]): string => {
    const candidates = locations.filter((loc) => locationSupportsFleet(loc, transports));
    if (candidates.length === 0) {
      throw new Error("No Location in this World supports a fleet with these Transport types.");
    }
    return fleetRng.choice(candidates).name;
  };

  // A throwaway Ship, used only to ask "does this Location support a
  // synthesized Ship" (every SHIP_CLASSES entry is a Ship, so one instance's
  // allowedRouteTypes() speaks for all of them) -- never added to a fleet.
  const probeShip = new Ship({ name: "_ProbeShip" });

  const soloFactions: SoloTrader[] = [];
  // The authored real Companies: their JSON-defined ships (kept in order),
  // resolved home Location, plus the nationality any ships later synthesized
  // onto them will use -- the entity's nationality if affiliated, else a
  // seeded-random one (drawn once per faction).
  interface PendingFaction {
    name: string;
    startingFunds: number;
    entity: PoliticalEntity | null;
    nationality: Nationality;
    homeLocation: string;
    crew: FleetCrew;
  }
  const pending: PendingFaction[] = [];
  for (const company of jsonCompanies) {
    const transports = company.fleet.map(
      (member) => makeTransport(member.transportType, member.transportName, transportSpeedScale),
    );
    const entity = company.politicalEntityId != null
      ? entityByJsonId.get(company.politicalEntityId) ?? null
      : null;

    if (transports.length === 1) {
      // A 1-ship authored company is a SoloTrader outright -- no home
      // Location, no bulking-up-into-a-Company later; its one ship starts
      // somewhere random and compatible.
      const homeLocation = randomCompatibleLocation(transports);
      const crew: FleetCrew = [[transports[0], new Captain(company.fleet[0].captainName, homeLocation), homeLocation]];
      const solo = new SoloTrader(company.name, crew, company.startingFunds);
      solo.politicalEntity = entity;
      soloFactions.push(solo);
      continue;
    }

    const authoredLocationName = company.homeLocationId != null ? idToName.get(company.homeLocationId) : undefined;
    const authoredLocation = authoredLocationName !== undefined ? getLocation(authoredLocationName) : undefined;
    const homeLocation =
      authoredLocation !== undefined && locationSupportsFleet(authoredLocation, transports)
        ? authoredLocation.name
        : defaultCompanyHomeLocation(entity, transports);

    const crew: FleetCrew = company.fleet.map((member, i) => [transports[i], new Captain(member.captainName, homeLocation), homeLocation]);
    const nationality = entity !== null ? entity.nationality : randomNationality(fleetRng);
    pending.push({ name: company.name, startingFunds: company.startingFunds, entity, nationality, homeLocation, crew });
  }

  // 5b. Size the fleet up to the required ship count (per the grilled spec):
  //   required  = round(locations * 5)               -- the calibrated minimum
  //   remainder = required - ships already defined
  //   newSolo   = round(0.2 * required)  (capped at remainder)
  //               -> that many NEW Independent SoloTraders (1 ship each)
  //   the rest  = spread round-robin over the real (non-SoloTrader) Companies,
  //               skipping any whose home Location can't take another
  //               synthesized Ship. If none of them can (or there are no
  //               Companies at all), the rest become SoloTraders too.
  // If the world already has at least `required` ships, nothing is added.
  const targetShipsPerLocation = options.targetShipsPerLocation ?? DEFAULT_TARGET_SHIPS_PER_LOCATION;
  const required = Math.round(locations.length * targetShipsPerLocation);
  const existingShips =
    pending.reduce((sum, f) => sum + f.crew.length, 0) + soloFactions.reduce((sum, f) => sum + f.captains.length, 0);
  const remainder = required - existingShips;

  const newSoloTraders: SoloTrader[] = [];
  // Every synthesized ship is a Ship (SHIP_CLASSES), needing Port/Platform --
  // in an all-Spaceship/all-Railroad/etc. World with no such Location at all,
  // there's nowhere for a synthesized Ship to go. Rather than throw (this is
  // just padding toward a calibrated target, not anything the world author
  // asked for), silently fall short of `required` instead.
  const anyLocationTakesShips = locations.some((loc) => locationSupportsTransport(loc, probeShip));
  if (remainder > 0 && anyLocationTakesShips) {
    let newSolo = Math.min(remainder, Math.round(SOLO_TRADER_FRACTION * required));
    let companyShipsToAdd = remainder - newSolo;

    const eligiblePending = pending.filter((f) => {
      const home = getLocation(f.homeLocation);
      return home !== undefined && locationSupportsTransport(home, probeShip);
    });
    if (eligiblePending.length === 0) {
      // No Company can take another (synthesized) Ship -> the rest become SoloTraders too.
      newSolo += companyShipsToAdd;
      companyShipsToAdd = 0;
    } else {
      for (let i = 0; i < companyShipsToAdd; i++) {
        const target = eligiblePending[i % eligiblePending.length];
        target.crew.push(generateCrewSlot(target.nationality, target.homeLocation));
        target.startingFunds += SYNTH_CASH_PER_SHIP;
      }
    }

    for (let i = 0; i < newSolo; i++) {
      const nationality = randomNationality(fleetRng);
      const homeLocation = randomCompatibleLocation([probeShip]);
      const crew: FleetCrew = [generateCrewSlot(nationality, homeLocation)];
      newSoloTraders.push(
        new SoloTrader(randomCompanyName(fleetRng, NATIONALITY_POOLS[nationality].companies), crew, SYNTH_CASH_PER_SHIP),
      );
    }
  }

  // 5c. Construct the (possibly augmented) authored Companies, then append
  // every SoloTrader (authored 1-ship companies, plus the newly synthesized
  // ones).
  const factions: Faction[] = [];
  for (const f of pending) {
    const company = new Company(f.name, f.crew, f.startingFunds, f.homeLocation);
    company.politicalEntity = f.entity;
    factions.push(company);
  }
  factions.push(...soloFactions, ...newSoloTraders);

  // 6. Assemble the World. No pirates/police by default (the editor doesn't
  // model them) -- overridable via options (see BuildWorldFromJsonOptions).
  // Event probabilities are irrelevant since random events are disabled.
  const numPirateShips = options.numPirateShips ?? 0;
  const builtWorld = new World({
    locations,
    factions,
    seed: options.seed,
    startDate: world.startDate,
    numPirateShips,
    pirateStartingCash: (options.pirateCashPerShip ?? 0) * numPirateShips,
    numPoliceShips: options.numPoliceShips ?? 0,
  });

  return { world: builtWorld, factions, politicalEntities };
}
