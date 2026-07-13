/**
 * Standalone Location model for the World editor. A World built here is
 * exported/imported as a single JSON document (see worldJson.ts), preserving
 * the nested shapes (per-commodity produced/consumed/stockpile/base-price
 * maps, terminal types) directly rather than flattening them into columns.
 */
import type { Nationality } from "./nameGenerators";
// TerminalType/RouteType/TransportType and the compatibility tables between
// them now live in @market-sim/shared (shared with the sim) -- imported AND
// re-exported so every existing `from "./types"` import keeps working, while
// this file can still reference them directly below (EditorLocation.terminalTypes etc.).
import {
  TERMINAL_TYPES, ROUTE_TYPES, ROUTE_TERMINAL_COMPATIBILITY, compatibleRouteTypes,
  TRANSPORT_TYPES, TRANSPORT_TYPE_LABELS,
  type TerminalType, type RouteType, type TransportType,
} from "@market-sim/shared/terminal";
export {
  TERMINAL_TYPES, ROUTE_TYPES, ROUTE_TERMINAL_COMPATIBILITY, compatibleRouteTypes,
  TRANSPORT_TYPES, TRANSPORT_TYPE_LABELS,
};
export type { TerminalType, RouteType, TransportType };

/** Default base rate (units/day, at a Location whose rate modifier is the default 1.0) for a newly defined Commodity -- mirrors DEFAULT_BASE_PRODUCTION_RATE/DEFAULT_BASE_CONSUMPTION_RATE in sim/commodity.py. */
export const DEFAULT_COMMODITY_RATE = 8;

/** Broad category a Commodity belongs to -- purely descriptive, mirrors src/sim/commodity.ts's CommodityType. */
export const COMMODITY_TYPES = ["Energy", "Metal", "Precious", "Foodstuff", "Textile", "General"] as const;
export type CommodityType = (typeof COMMODITY_TYPES)[number];
export const DEFAULT_COMMODITY_TYPE: CommodityType = "General";

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
  type: CommodityType;
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

/** A group of Locations -- mirrors src/sim/politicalEntity.ts's PoliticalEntity (TS-only, no Python original). The editor only needs name/membership/type/nationality; shared cash pooling is a simulation-runtime concern. */
export interface PoliticalEntity {
  id: string;
  name: string;
  type: PoliticalEntityType;
  /** Cultural nationality the sim uses to name ships/captains synthesized for this entity's affiliated Companies (see src/sim/buildWorldFromJson.ts). */
  nationality: Nationality;
}

/** Default starting cash for a newly defined Company -- an editor-only convenience default, distinct from src/sim/faction.ts's Company (whose own default startingCash is 0). */
export const DEFAULT_COMPANY_STARTING_FUNDS = 100_000;

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

/** Names of famous historical ports/trading hubs, used to randomly name a Location in the editor (see LocationInspector). */
export const FAMOUS_HISTORICAL_PORTS: string[] = [
  "Alexandria", "Carthage", "Constantinople", "Venice", "Genoa",
  "Amsterdam", "Lisbon", "Marseille", "Rotterdam", "Antwerp",
  "Bruges", "Hamburg", "Lubeck", "Danzig", "Bergen",
  "Cadiz", "Malacca", "Canton", "Nagasaki", "Calicut",
  "Aden", "Muscat", "Hormuz", "Zanzibar", "Mombasa",
  "Tyre", "Sidon", "Piraeus", "Ostia", "Ephesus",
  "Ragusa", "Palermo", "Naples", "Barcelona", "Valencia",
  "Bristol", "Liverpool", "Portsmouth", "Plymouth", "Dover",
  "Macau", "Batavia", "Goa", "Colombo", "Aleppo",
  "Smyrna", "Trebizond", "Novgorod", "Riga", "Tallinn",
];

/**
 * Goods traded in the Caribbean during the Golden Age of Piracy (c. 1650-1730),
 * with a suitable base price each (cheap staples through high-value luxuries).
 * Used by the "add trade good" button in the Commodities panel to seed a
 * new Commodity with a plausible name and price.
 */
export const CARIBBEAN_COMMODITIES: { name: string; basePrice: number; type: CommodityType }[] = [
  { name: "Salt", basePrice: 8, type: "Foodstuff" },
  { name: "Rice", basePrice: 14, type: "Foodstuff" },
  { name: "Molasses", basePrice: 18, type: "Foodstuff" },
  { name: "Hides", basePrice: 24, type: "Textile" },
  { name: "Sugar", basePrice: 30, type: "Foodstuff" },
  { name: "Ginger", basePrice: 34, type: "Foodstuff" },
  { name: "Cotton", basePrice: 38, type: "Textile" },
  { name: "Pimento", basePrice: 42, type: "Foodstuff" },
  { name: "Rum", basePrice: 46, type: "Foodstuff" },
  { name: "Tobacco", basePrice: 52, type: "Foodstuff" },
  { name: "Coffee", basePrice: 56, type: "Foodstuff" },
  { name: "Cacao", basePrice: 60, type: "Foodstuff" },
  { name: "Logwood", basePrice: 66, type: "General" },
  { name: "Mahogany", basePrice: 72, type: "General" },
  { name: "Indigo", basePrice: 82, type: "Textile" },
  { name: "Gunpowder", basePrice: 90, type: "General" },
  { name: "Cochineal", basePrice: 110, type: "Textile" },
  { name: "Tortoiseshell", basePrice: 125, type: "General" },
  { name: "Silver", basePrice: 210, type: "Precious" },
  { name: "Pearls", basePrice: 300, type: "Precious" },
  { name: "Gold", basePrice: 520, type: "Precious" },
];

/** A trading Faction -- mirrors src/sim/faction.ts's Company (TS-only, no Python original). The editor only needs name/starting funds/fleet/home Location; captain strategy params are a simulation-runtime concern. */
export interface EditorCompany {
  id: string;
  name: string;
  startingFunds: number;
  fleet: EditorFleetMember[];
  /** The PoliticalEntity this Company is affiliated with, or null for Independent (the default). Unlike a Location's required membership, a Company's affiliation is optional. */
  politicalEntityId: string | null;
  /**
   * The Location (by id) this Company's whole fleet is based out of -- every
   * Transport in it must be compatible with this Location's TerminalTypes
   * (see companyHome.ts). Always null for a SoloTrader (factionType(fleet)
   * === "SoloTrader", i.e. exactly one fleet member) -- SoloTraders have no
   * home port. Kept up to date by companyHome.ts's resolveCompanyHomeLocation
   * whenever the fleet, politicalEntityId, or the Locations themselves change.
   */
  homeLocationId: string | null;
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

/** A user-placed bend in a Route's path between its two Locations -- created/moved by shift-dragging on the Route (see WorldCanvas). Mirrors src/sim/routes.ts's Bezier control points; the Route is rendered as a sampled Bezier curve through them (see routeRenderPoints). */
export interface RouteControlPoint {
  id: string;
  x: number;
  y: number;
}

/** A direct connection between two Locations -- mirrors src/sim/routes.ts's Route (distance is derived, not stored: recomputed live from the Locations' current positions). Undirected: locationAId/locationBId order carries no meaning. */
export interface EditorRoute {
  id: string;
  locationAId: string;
  locationBId: string;
  routeType: RouteType;
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
 * least one control point, never a sharp-cornered polyline through them,
 * regardless of how many.
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
