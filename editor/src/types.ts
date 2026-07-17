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
import {
  COMMODITY_TYPES, DEFAULT_COMMODITY_TYPE, type CommodityType,
} from "@market-sim/shared/commodity";
export { COMMODITY_TYPES, DEFAULT_COMMODITY_TYPE };
export type { CommodityType };
import {
  POLITICAL_ENTITY_TYPES, DEFAULT_POLITICAL_ENTITY_TYPE, type PoliticalEntityType,
} from "@market-sim/shared/politicalEntity";
export { POLITICAL_ENTITY_TYPES, DEFAULT_POLITICAL_ENTITY_TYPE };
export type { PoliticalEntityType };
import {
  SETTLEMENT_TYPES, DEFAULT_SETTLEMENT_TYPE, type SettlementType,
} from "@market-sim/shared/settlement";
export { SETTLEMENT_TYPES, DEFAULT_SETTLEMENT_TYPE };
export type { SettlementType };
// The De Casteljau curve math a Route's path is rendered/measured through
// (also used by src/sim/routes.ts's Route) lives in @market-sim/shared.
import { sampleBezierCurve, CURVE_SAMPLE_COUNT, type Point } from "@market-sim/shared/bezier";

/** Default base rate (units/day, at a Location whose rate modifier is the default 1.0) for a newly defined Commodity -- mirrors DEFAULT_BASE_PRODUCTION_RATE/DEFAULT_BASE_CONSUMPTION_RATE in sim/commodity.py. */
export const DEFAULT_COMMODITY_RATE = 8;

/** Default gift-worthiness for a newly defined Commodity -- mirrors src/sim/commodity.ts's DEFAULT_GIFT_VALUE (not gift-worthy at all). */
export const DEFAULT_COMMODITY_GIFT = 0;

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
  /** [0, 1] -- how good a gift this commodity makes for a Chieftain (see src/sim/commodity.ts's Commodity.gift). Global, not per-chieftain: every chieftain shares the same taste. 0 (default) means not gift-worthy at all. */
  gift: number;
}

export type CommodityField =
  | "producedCommodities"
  | "consumedCommodities"
  | "stockpiles"
  | "minStockpiles"
  | "basePriceModifiers";

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

/** A Captain/Transport pair added to a Company's fleet -- mirrors the (Transport, Captain) construction pattern FleetOwner.__init__ expects (src/sim/faction.ts), minus everything (strategy params, home location) that only matters once a simulation actually runs. */
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
 * Suggested trade goods, one unified pool spanning both the Golden Age of
 * Piracy Caribbean trade (c. 1650-1730) and the mid-19th-century exploration
 * mode's native-village/Western-explorer trade (see doc/ExploreGame.md's
 * Trade/Agriculture/Flora/Common-illnesses sections) -- each with a suitable
 * base price (cheap staples through high-value luxuries), sorted low to high
 * so the two eras' goods interleave into one coherent price curve rather than
 * reading as two separate catalogs. Bulk foodstuffs and raw trade-good inputs
 * (salt, cowrie shells/beads, cheap to source in quantity even though the
 * latter are the natives' own currency) sit at the bottom; industrial/dye/
 * ornamental materials in the middle; goods with strong or urgent demand at
 * the top -- ivory/pearls (luxury manufacturing/jewelry), vanilla (a costly
 * spice), and quinine (a refined cinchona-bark extract, priced highest of
 * all: not just a trade good but the only real treatment for malaria, see
 * ExploreGame.md's Common illnesses section -- explorers need it to survive,
 * not just to sell). Used by the "add trade good" button in the Commodities
 * panel to seed a new Commodity with a plausible name and price -- one set
 * to choose from, not a Caribbean-vs-exploration split.
 */
export const PRESET_COMMODITIES: { name: string; basePrice: number; type: CommodityType }[] = [
  { name: "Cowrie shells", basePrice: 6, type: "General" },
  { name: "Salt", basePrice: 8, type: "Foodstuff" },
  { name: "Millet", basePrice: 9, type: "Foodstuff" },
  { name: "Sweet potato", basePrice: 10, type: "Foodstuff" },
  { name: "Manioc", basePrice: 11, type: "Foodstuff" },
  { name: "Maize", basePrice: 12, type: "Foodstuff" },
  { name: "Pumpkin", basePrice: 13, type: "Foodstuff" },
  { name: "Rice", basePrice: 14, type: "Foodstuff" },
  { name: "Blue beads", basePrice: 15, type: "General" },
  { name: "Yam", basePrice: 16, type: "Foodstuff" },
  { name: "Breadfruit", basePrice: 17, type: "Foodstuff" },
  { name: "Molasses", basePrice: 18, type: "Foodstuff" },
  { name: "Okra", basePrice: 19, type: "Foodstuff" },
  { name: "Plantain", basePrice: 20, type: "Foodstuff" },
  { name: "Mango", basePrice: 21, type: "Foodstuff" },
  { name: "Pawpaw", basePrice: 22, type: "Foodstuff" },
  { name: "Hides", basePrice: 24, type: "Textile" },
  { name: "Oranges", basePrice: 26, type: "Foodstuff" },
  { name: "Sugar", basePrice: 30, type: "Foodstuff" },
  { name: "Cannabis", basePrice: 32, type: "General" },
  { name: "Ginger", basePrice: 34, type: "Foodstuff" },
  { name: "Cotton", basePrice: 38, type: "Textile" },
  { name: "Pineapple", basePrice: 40, type: "Foodstuff" },
  { name: "Pimento", basePrice: 42, type: "Foodstuff" },
  { name: "Rum", basePrice: 46, type: "Foodstuff" },
  { name: "Tin", basePrice: 49, type: "Metal" },
  { name: "Tobacco", basePrice: 52, type: "Foodstuff" },
  { name: "Coffee", basePrice: 56, type: "Foodstuff" },
  { name: "Furs", basePrice: 58, type: "Textile" },
  { name: "Cacao", basePrice: 60, type: "Foodstuff" },
  { name: "Logwood", basePrice: 66, type: "General" },
  { name: "Ebony", basePrice: 69, type: "General" },
  { name: "Mahogany", basePrice: 72, type: "General" },
  { name: "Indigo", basePrice: 82, type: "Textile" },
  { name: "Rubber", basePrice: 86, type: "General" },
  { name: "Gunpowder", basePrice: 90, type: "General" },
  { name: "Cinchona bark", basePrice: 100, type: "General" },
  { name: "Cochineal", basePrice: 110, type: "Textile" },
  { name: "Cobalt", basePrice: 118, type: "Metal" },
  { name: "Tortoiseshell", basePrice: 125, type: "General" },
  { name: "Amber", basePrice: 160, type: "Precious" },
  { name: "Vanilla", basePrice: 190, type: "General" },
  { name: "Silver", basePrice: 210, type: "Precious" },
  { name: "Ivory", basePrice: 250, type: "General" },
  { name: "Pearls", basePrice: 300, type: "Precious" },
  { name: "Quinine", basePrice: 340, type: "General" },
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

/** Mirrors which FleetOwner subclass src/sim/faction.ts would actually construct for this fleet: SoloTrader requires exactly one Transport/Captain (its constructor throws otherwise), so a fleet of any other size -- including zero -- has to be a plain Company. */
export type FactionType = "Company" | "SoloTrader";

export function factionType(fleet: readonly EditorFleetMember[]): FactionType {
  return fleet.length === 1 ? "SoloTrader" : "Company";
}

/**
 * A Location's personal ruler (exploration mode) -- mirrors src/sim/chieftain.ts's
 * Chieftain. When present, this authority's passage-tax terms take precedence
 * over the owning PoliticalEntity's for diplomacy decisions. The editor
 * doesn't author gender/date of birth (display-only in the sim, defaulted
 * there -- see buildWorldFromJson.ts's resolveGender/resolveBirthDate).
 */
export interface EditorChieftain {
  name: string;
  /** Fraction (0-1) of the party's cash/value demanded as passage tax on arrival. */
  passageTaxRate: number;
  /** [0, 1] -- persistent trust toward the player's party. */
  trust: number;
}

export const DEFAULT_CHIEFTAIN_PASSAGE_TAX_RATE = 0.1;
export const DEFAULT_CHIEFTAIN_TRUST = 0.5;

export function createChieftain(name: string): EditorChieftain {
  return {
    name,
    passageTaxRate: DEFAULT_CHIEFTAIN_PASSAGE_TAX_RATE,
    trust: DEFAULT_CHIEFTAIN_TRUST,
  };
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
  /** Settlement scale (exploration mode) -- orthogonal to terminalTypes, purely a scale/presentation classification. Defaults to "Town" (see createLocation). */
  settlementType: SettlementType;
  /** This Location's personal ruler (exploration mode), or null for none -- see EditorChieftain. */
  ruler: EditorChieftain | null;
}

/**
 * An expedition party (exploration mode) -- mirrors src/sim/faction.ts's
 * ExpeditionParty (the Faction) wrapping src/sim/explorer.ts's Explorer.
 * Carries nothing personally (its trade goods live on its PorterParty
 * transport, sized from porterCount/animalCount -- see buildWorldFromJson.ts).
 */
export interface EditorExplorer {
  id: string;
  name: string;
  /** The Location (by id) this Explorer starts at. */
  homeLocationId: string;
  porterCount: number;
  animalCount: number;
  startingCash: number;
  /** The PoliticalEntity this ExpeditionParty is affiliated with, or null for an independent operator (mirrors EditorCompany.politicalEntityId) -- set via the ExplorerPartiesPanel, same as a Company's. */
  politicalEntityId: string | null;
  /** Whether this ExpeditionParty wanders autonomously once the World is running (see src/sim/faction.ts's ExpeditionParty.direct), instead of waiting on a player's manual leg choice. Defaults to true (DEFAULT_EXPLORER_AI_CONTROLLED) -- unlike a Ship, which always trades/moves on its own regardless of this flag, an Explorer needs it explicitly set or it never moves at all once dropped into the main sim app. */
  aiControlled: boolean;
}

export const DEFAULT_EXPLORER_PORTER_COUNT = 4;
export const DEFAULT_EXPLORER_ANIMAL_COUNT = 0;
export const DEFAULT_EXPLORER_STARTING_CASH = 500;
export const DEFAULT_EXPLORER_AI_CONTROLLED = true;

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

function toPoint(p: { x: number; y: number }): Point {
  return [p.x, p.y];
}

function fromPoint([x, y]: Point): { x: number; y: number } {
  return { x, y };
}

/**
 * The points a Route's path should actually be drawn/measured through: `a`
 * and `b` directly if there are no control points (nothing to curve
 * through), otherwise CURVE_SAMPLE_COUNT points sampled along the single
 * Bezier curve through `a`, every control point, and `b` -- quadratic for
 * exactly one control point, cubic-or-higher for more, the same De Casteljau
 * sampling src/sim/routes.ts's Route measures/animates along (see
 * @market-sim/shared/bezier). Always smooth once there's at least one
 * control point, never a sharp-cornered polyline through them, regardless of
 * how many.
 */
export function routeRenderPoints(
  a: { x: number; y: number },
  b: { x: number; y: number },
  controlPoints: readonly RouteControlPoint[],
): { x: number; y: number }[] {
  const sorted = sortRouteControlPoints(a, b, controlPoints);
  if (sorted.length === 0) return [a, b];
  const throughPoints = [a, ...sorted, b].map(toPoint);
  return sampleBezierCurve(throughPoints, CURVE_SAMPLE_COUNT).map(fromPoint);
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
    settlementType: DEFAULT_SETTLEMENT_TYPE,
    ruler: null,
  };
}
