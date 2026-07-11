/**
 * Standalone Location model for the World editor. A World built here is
 * exported/imported as a single JSON document (see worldJson.ts), preserving
 * the nested shapes (per-commodity produced/consumed/stockpile/base-price
 * maps, terminal types) directly rather than flattening them into columns.
 */
export type TerminalType =
  | "Port" | "Wagon yard" | "Airport" | "Platform" | "Spaceport" | "TransitDepot" | "Station";

export const TERMINAL_TYPES: TerminalType[] = [
  "Port", "Wagon yard", "Airport", "Platform", "Spaceport", "TransitDepot", "Station",
];

/** Default base rate (units/day, at a Location whose rate modifier is the default 1.0) for a newly defined Commodity -- mirrors DEFAULT_BASE_PRODUCTION_RATE/DEFAULT_BASE_CONSUMPTION_RATE in sim/commodity.py. */
export const DEFAULT_COMMODITY_RATE = 8;

/**
 * A registered Commodity: basePrice is this commodity's world-wide reference
 * price; productionRate/consumptionRate are its units/day rate at a Location
 * with the default 1.0 rate modifier (see
 * EditorLocation.producedCommodities/consumedCommodities).
 */
export interface Commodity {
  name: string;
  basePrice: number;
  productionRate: number;
  consumptionRate: number;
}

export type CommodityField =
  | "producedCommodities"
  | "consumedCommodities"
  | "stockpiles"
  | "minStockpiles"
  | "basePriceModifiers";

/** The scale a PoliticalEntity groups Locations at -- mirrors src/sim/politicalEntity.ts's PoliticalEntityType. */
export type PoliticalEntityType = "Universal" | "Planet" | "Country" | "State";

export const POLITICAL_ENTITY_TYPES: PoliticalEntityType[] = ["Universal", "Planet", "Country", "State"];

export const DEFAULT_POLITICAL_ENTITY_TYPE: PoliticalEntityType = "Universal";

/** A group of Locations -- mirrors src/sim/politicalEntity.ts's PoliticalEntity (TS-only, no Python original). The editor only needs name/membership/type; shared cash pooling is a simulation-runtime concern. */
export interface PoliticalEntity {
  id: string;
  name: string;
  type: PoliticalEntityType;
}

/** Default starting cash for a newly defined Company -- an editor-only convenience default, distinct from src/sim/faction.ts's Company (whose own default startingCash is 0). */
export const DEFAULT_COMPANY_STARTING_FUNDS = 100_000;

/** Mirrors src/sim/transport.ts's concrete Transport subclasses (Ship/WagonTrain/Plane/Spaceship/Lorry/FreightTrain). */
export type TransportType = "Ship" | "WagonTrain" | "Plane" | "Spaceship" | "Lorry" | "FreightTrain";

export const TRANSPORT_TYPES: TransportType[] = [
  "Ship", "WagonTrain", "Plane", "Spaceship", "Lorry", "FreightTrain",
];

export const TRANSPORT_TYPE_LABELS: Record<TransportType, string> = {
  Ship: "Ship",
  WagonTrain: "Wagon Train",
  Plane: "Plane",
  Spaceship: "Spaceship",
  Lorry: "Lorry",
  FreightTrain: "Freight Train",
};

/** A Captain/Transport pair added to a Company's fleet -- mirrors the (Transport, Captain) construction pattern Faction.__init__ expects (src/sim/faction.ts), minus everything (strategy params, home location) that only matters once a simulation actually runs. */
export interface EditorFleetMember {
  id: string;
  transportType: TransportType;
  transportName: string;
  captainName: string;
}

/** A pool of famous historical figures to draw a random Captain name from -- purely an editor convenience, unrelated to src/sim/names.ts's procedural first/last name pools (which name crew for a running simulation, not hand-authored World fixtures). */
export const FAMOUS_HISTORICAL_NAMES: string[] = [
  "Christopher Columbus", "Ferdinand Magellan", "Marco Polo", "Zheng He",
  "Vasco da Gama", "James Cook", "Amelia Earhart", "Ibn Battuta",
  "Leif Erikson", "Francis Drake", "Henry Hudson", "Jacques Cartier",
  "Ernest Shackleton", "Roald Amundsen", "Charles Lindbergh", "Howard Hughes",
  "Cleopatra", "Julius Caesar", "Genghis Khan", "Alexander the Great",
  "Hannibal Barca", "Joan of Arc", "Marco Aurelio", "Suleiman the Magnificent",
  "Catherine the Great", "Peter the Great", "Napoleon Bonaparte", "Wellington",
  "Nikola Tesla", "Benjamin Franklin", "Leonardo da Vinci", "Isaac Newton",
  "Marie Curie", "Charles Darwin", "Galileo Galilei", "Johannes Kepler",
];

/** A trading Faction -- mirrors src/sim/faction.ts's Company (TS-only, no Python original). The editor only needs name/starting funds/fleet; captain strategy params and home location are a simulation-runtime concern. */
export interface EditorCompany {
  id: string;
  name: string;
  startingFunds: number;
  fleet: EditorFleetMember[];
}

/** Mirrors which Faction subclass src/sim/faction.ts would actually construct for this fleet: SoloTrader requires exactly one Transport/Captain (its constructor throws otherwise), so a fleet of any other size -- including zero -- has to be a plain Company. */
export type FactionType = "Company" | "SoloTrader";

export function factionType(fleet: readonly EditorFleetMember[]): FactionType {
  return fleet.length === 1 ? "SoloTrader" : "Company";
}

export interface EditorLocation {
  id: string;
  name: string;
  x: number;
  y: number;
  /** The PoliticalEntity this Location belongs to -- required at creation time (see useEditorStore.addLocation); deleting that PoliticalEntity deletes this Location too (see removePoliticalEntity), so this is never left dangling. */
  politicalEntityId: string;
  /** commodity name -> production rate MODIFIER (default 1.0), scaling that Commodity's registered productionRate. */
  producedCommodities: Record<string, number>;
  /** commodity name -> consumption rate MODIFIER (default 1.0), scaling that Commodity's registered consumptionRate. */
  consumedCommodities: Record<string, number>;
  stockpiles: Record<string, number>;
  minStockpiles: Record<string, number>;
  /** commodity name -> price MODIFIER (default 1.0), scaling that Commodity's registered basePrice -- auto-added/removed alongside produced/consumedCommodities, always shown and editable. */
  basePriceModifiers: Record<string, number>;
  fuelPrice: number;
  terminalTypes: TerminalType[];
}

/** Mirrors src/sim/routes.ts's RouteType. */
export type RouteType = "Land" | "Air" | "Sea" | "Space" | "Road" | "Railroad";

export const ROUTE_TYPES: RouteType[] = ["Land", "Air", "Sea", "Space", "Road", "Railroad"];

/** Mirrors src/sim/routes.ts's ROUTE_TERMINAL_COMPATIBILITY -- which TerminalTypes each RouteType requires at both ends. Space connects Spaceports, Road connects TransitDepots, Railroad connects Stations. */
export const ROUTE_TERMINAL_COMPATIBILITY: Record<RouteType, TerminalType[]> = {
  Land: ["Wagon yard"],
  Air: ["Airport"],
  Sea: ["Port", "Platform"],
  Space: ["Spaceport"],
  Road: ["TransitDepot"],
  Railroad: ["Station"],
};

/** Every RouteType a Route between Locations with these two TerminalType sets could plausibly be, in ROUTE_TYPES priority order -- mirrors src/sim/routes.ts's compatibleRouteTypes. */
export function compatibleRouteTypes(a: readonly TerminalType[], b: readonly TerminalType[]): RouteType[] {
  return ROUTE_TYPES.filter((routeType) => {
    const required = ROUTE_TERMINAL_COMPATIBILITY[routeType];
    return required.some((t) => a.includes(t)) && required.some((t) => b.includes(t));
  });
}

/** A user-placed bend in a Route's path between its two Locations -- created/moved by shift-dragging on the Route (see WorldCanvas). Mirrors src/sim/routes.ts's Bezier control points; whether they're rendered as a sampled Bezier curve or a straight-segment polyline through them depends on the Route's curveType (see routeRenderPoints). */
export interface RouteControlPoint {
  id: string;
  x: number;
  y: number;
}

/** Mirrors src/sim/routes.ts's RouteCurveType. */
export type RouteCurveType = "Straight" | "Bezier";

export const DEFAULT_ROUTE_CURVE_TYPE: RouteCurveType = "Straight";

/** How a Route's curveType reacts to its control point count changing -- 2 or more forces "Bezier" (the minimum needed for a cubic-or-higher Bezier through both Locations and every control point), fewer than 2 forces "Straight". */
export function deriveRouteCurveType(controlPointCount: number): RouteCurveType {
  return controlPointCount >= 2 ? "Bezier" : "Straight";
}

/** A direct connection between two Locations -- mirrors src/sim/routes.ts's Route (distance is a simulation-runtime concern, recomputed live from the Locations' current positions instead of stored here). Undirected: locationAId/locationBId order carries no meaning. */
export interface EditorRoute {
  id: string;
  locationAId: string;
  locationBId: string;
  routeType: RouteType;
  curveType: RouteCurveType;
  controlPoints: RouteControlPoint[];
}

/**
 * `controlPoints` sorted by where they project onto the straight line from
 * `a` to `b` -- gives a stable rendering/measurement order for a Route's
 * (possibly bent) path independent of the order points were added in, since
 * a point can be shift-dragged into place anywhere along the route.
 */
export function sortRouteControlPoints(
  a: { x: number; y: number },
  b: { x: number; y: number },
  controlPoints: readonly RouteControlPoint[],
): RouteControlPoint[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy || 1;
  const projection = (p: { x: number; y: number }) => ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared;
  return [...controlPoints].sort((p, q) => projection(p) - projection(q));
}

/** Points sampled evenly in Bezier parameter t along a curve through `points` -- mirrors src/sim/routes.ts's CURVE_SAMPLE_COUNT/curvePoints sampling density, so an editor-rendered Bezier reads at the same visual smoothness as the simulation's own. */
const CURVE_SAMPLE_COUNT = 24;

/** De Casteljau evaluation -- works for a Bezier curve of any degree (any number of control points), not just cubic. Mirrors src/sim/routes.ts's bezierPoint. */
function bezierPoint(points: readonly { x: number; y: number }[], t: number): { x: number; y: number } {
  let pts = points;
  while (pts.length > 1) {
    const next: { x: number; y: number }[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      next.push({ x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, y: pts[i].y + (pts[i + 1].y - pts[i].y) * t });
    }
    pts = next;
  }
  return pts[0];
}

/**
 * The points a Route's path should actually be drawn/measured through: `a`
 * and `b` directly if there are no control points (nothing to curve
 * through), otherwise CURVE_SAMPLE_COUNT points sampled along the single
 * Bezier curve through `a`, every control point, and `b` -- quadratic for
 * exactly one control point, cubic-or-higher for more, same De Casteljau
 * technique as src/sim/routes.ts's Route. Always smooth once there's at
 * least one control point, never a sharp-cornered polyline through them --
 * this is independent of the Route's curveType label (see
 * deriveRouteCurveType), which only describes whether it's *at* the
 * 2-control-point-or-more threshold, not how 0 or 1 renders.
 */
export function routeRenderPoints(
  a: { x: number; y: number },
  b: { x: number; y: number },
  controlPoints: readonly RouteControlPoint[],
): { x: number; y: number }[] {
  const sorted = sortRouteControlPoints(a, b, controlPoints);
  if (sorted.length === 0) return [a, b];
  const throughPoints = [a, ...sorted, b];
  const samples: { x: number; y: number }[] = [];
  for (let i = 0; i <= CURVE_SAMPLE_COUNT; i++) {
    samples.push(bezierPoint(throughPoints, i / CURVE_SAMPLE_COUNT));
  }
  return samples;
}

/** Total length of the Route's actual rendered path (see routeRenderPoints) -- the straight-line distance with no control points, or the sampled curve's arc length with one or more. */
export function routePathLength(
  a: { x: number; y: number },
  b: { x: number; y: number },
  controlPoints: readonly RouteControlPoint[],
): number {
  const points = routeRenderPoints(a, b, controlPoints);
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return total;
}

export function createLocation(
  id: string,
  name: string,
  x: number,
  y: number,
  politicalEntityId: string,
): EditorLocation {
  return {
    id,
    name,
    x,
    y,
    politicalEntityId,
    producedCommodities: {},
    consumedCommodities: {},
    stockpiles: {},
    minStockpiles: {},
    basePriceModifiers: {},
    fuelPrice: 1,
    terminalTypes: [],
  };
}
