/**
 * Holds the editor's World -- currently just a flat list of Locations
 * (Routes/Companies/etc. aren't modeled yet). Starts empty; the canvas adds
 * a Location wherever the user clicks.
 */
import { create } from "zustand";
import {
  createLocation, compatibleRouteTypes,
  DEFAULT_COMMODITY_RATE, DEFAULT_COMPANY_STARTING_FUNDS, DEFAULT_POLITICAL_ENTITY_TYPE,
  ROUTE_TERMINAL_COMPATIBILITY,
  type Commodity, type CommodityField, type EditorCompany, type EditorFleetMember, type EditorRoute,
  type PoliticalEntity, type PoliticalEntityType, type EditorLocation, type RouteType, type TerminalType, type TransportType,
} from "../types";
import type { EditorWorld } from "../worldJson";

let nextId = 1;
let nextPoliticalEntityId = 1;
let nextRouteId = 1;
let nextRouteControlPointId = 1;
let nextCompanyId = 1;
let nextFleetMemberId = 1;

/** Highest numeric suffix among ids of the form `${prefix}${n}`, plus one -- so a fresh id minted after an import can't collide with an imported one. Returns 1 if none match. */
function nextIdAfter(ids: Iterable<string>, prefix: string): number {
  let max = 0;
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue;
    const n = Number(id.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max + 1;
}

/** World scale multiplies each Location's normalized [0,1] canvas position to
 * produce its world (exported/simulation) position -- see EditorLocation and
 * worldJson.ts. It does NOT affect the editor's visual layout at all. */
export const MIN_WORLD_SCALE = 10;
export const MAX_WORLD_SCALE = 1000;
export const DEFAULT_WORLD_SCALE = 100;

// Mirror world_data.py/worldData.ts's procedural stockpile sizing (there
// drawn from a random range per location; here a single sensible default
// since this is hand-authored, not generated): a produced commodity starts
// with this many days of accumulated output, a consumed commodity's minimum
// is this many days of buffer, with its starting stockpile a straight
// multiple of that minimum.
const PRODUCED_STOCKPILE_DAYS = 15;
const MIN_STOCKPILE_DAYS = 10;
const CONSUMED_STOCKPILE_FACTOR = 2;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

interface EditorStore {
  locations: EditorLocation[];
  selectedId: string | null;
  /** Multiplier applied to each Location's normalized [0,1] canvas position to get its world (exported/simulation) position. Purely a coordinate multiplier -- changing it never moves anything on the canvas. Range [MIN_WORLD_SCALE, MAX_WORLD_SCALE]. */
  worldScale: number;
  setWorldScale: (scale: number) => void;

  /** A user-picked background image (data URL) drawn behind the canvas, or null for none. Rendered as a plain HTML image fixed to the canvas viewport, so it does NOT scale when the world size changes (see WorldCanvas). Purely an editor view setting -- not part of the exported World. */
  backgroundImage: string | null;
  setBackgroundImage: (dataUrl: string | null) => void;

  /** Replaces the entire authored World with an imported one (see worldJson.ts), clearing UI state (selection) and re-seeding id counters past every imported id so later additions can't collide. */
  loadWorld: (world: EditorWorld) => void;

  /** PoliticalEntities a new Location can be placed into -- membership is required at creation time (see addLocation/pendingPoliticalEntityId), so an empty registry blocks placement entirely. */
  politicalEntities: PoliticalEntity[];
  /** Which PoliticalEntity a click on the canvas will assign to the new Location -- must be set (via the PoliticalEntities panel's dropdown) before addLocation will do anything. */
  pendingPoliticalEntityId: string | null;
  addPoliticalEntity: (name: string) => void;
  /** Removes the PoliticalEntity, along with every Location that belonged to it -- a Location can't exist without one. */
  removePoliticalEntity: (id: string) => void;
  setPendingPoliticalEntityId: (id: string | null) => void;
  setPoliticalEntityType: (id: string, type: PoliticalEntityType) => void;
  updatePoliticalEntityName: (id: string, name: string) => void;

  /** No-ops if pendingPoliticalEntityId is unset -- a Location can't be created without a PoliticalEntity selected first. */
  addLocation: (x: number, y: number) => void;
  updateLocation: (id: string, patch: Partial<EditorLocation>) => void;
  moveLocation: (id: string, x: number, y: number) => void;
  removeLocation: (id: string) => void;
  selectLocation: (id: string | null) => void;
  toggleTerminalType: (id: string, terminal: TerminalType) => void;

  /** The currently selected Route, shown in the RouteInspector panel; null when none is selected. Selecting a Route clears any selected Location and vice versa -- only one thing is inspected at a time. */
  selectedRouteId: string | null;
  selectRoute: (id: string | null) => void;
  /** Changes a Route's RouteType -- the UI only offers types both endpoints' terminals support (see compatibleRouteTypes), so this is trusted to receive a compatible one. No-op if the Route doesn't exist. */
  setRouteType: (id: string, routeType: RouteType) => void;

  /** Direct connections between two Locations, created by shift-dragging from one pin to another; a Route's own path can be bent by shift-dragging on it to add/move control points (see WorldCanvas). */
  routes: EditorRoute[];
  /**
   * No-ops if either Location is missing, they're the same Location, either
   * has no TerminalTypes (mirrors Route generation only connecting locations
   * with a compatible terminal -- see src/sim/routes.ts's
   * compatibleRouteTypes), or a Route between them already exists (in
   * either direction, since a Route is undirected).
   */
  addRoute: (locationAId: string, locationBId: string) => void;
  removeRoute: (id: string) => void;
  /** Adds a new control point to a Route at (x, y) and returns the point's id so the caller (WorldCanvas) can immediately start dragging it. The Route's curveType follows from the resulting count (see deriveRouteCurveType). No-ops (returning null) if the Route doesn't exist. */
  addRouteControlPoint: (routeId: string, x: number, y: number) => string | null;
  /** Repositions an existing control point -- no-op if the Route or point doesn't exist. */
  moveRouteControlPoint: (routeId: string, pointId: string, x: number, y: number) => void;
  /** Removes a control point -- no-op if the Route or point doesn't exist. The Route's curveType follows from the resulting (smaller) count (see deriveRouteCurveType). */
  removeRouteControlPoint: (routeId: string, pointId: string) => void;
  setCommodityValue: (id: string, field: CommodityField, commodity: string, value: number) => void;
  /** Sets commodity's modifier in producedCommodities (adding it if new) and re-derives its starting stockpile from the commodity's registered production rate -- stockpiles are never hand-edited, so this is the only path that touches them. */
  addProducedCommodity: (id: string, commodity: string, modifier?: number) => void;
  /** Sets commodity's modifier in consumedCommodities (adding it if new) and re-derives its minimum + starting stockpile from the commodity's registered consumption rate. */
  addConsumedCommodity: (id: string, commodity: string, modifier?: number) => void;
  /** Removes commodity from producedCommodities along with its now-orphaned stockpile entry. */
  removeProducedCommodity: (id: string, commodity: string) => void;
  /** Removes commodity from consumedCommodities along with its now-orphaned stockpile/minStockpile entries. */
  removeConsumedCommodity: (id: string, commodity: string) => void;

  /** Global commodity registry, shared by every Location's dropdown-driven commodity fields. */
  commodities: Commodity[];
  addCommodity: (name: string) => void;
  updateCommodityBasePrice: (name: string, basePrice: number) => void;
  updateCommodityProductionRate: (name: string, productionRate: number) => void;
  updateCommodityConsumptionRate: (name: string, consumptionRate: number) => void;
  removeCommodity: (name: string) => void;

  /** Companies defined for this World -- captain strategy params and home location aren't modeled in the editor, just name, starting funds, and a fleet of (Transport type/name, Captain name) pairs. */
  companies: EditorCompany[];
  addCompany: (name: string, startingFunds?: number) => void;
  updateCompanyName: (id: string, name: string) => void;
  updateCompanyStartingFunds: (id: string, startingFunds: number) => void;
  removeCompany: (id: string) => void;
  /** Adds a Captain/Transport pair to a Company's fleet -- no-op if the Company doesn't exist. */
  addFleetMember: (companyId: string, transportType: TransportType, transportName: string, captainName: string) => void;
  removeFleetMember: (companyId: string, memberId: string) => void;
}

const COMMODITY_FIELDS: CommodityField[] = [
  "producedCommodities", "consumedCommodities", "stockpiles", "minStockpiles", "basePriceModifiers",
];

function updateOne(locations: EditorLocation[], id: string, patch: Partial<EditorLocation>): EditorLocation[] {
  return locations.map((loc) => (loc.id === id ? { ...loc, ...patch } : loc));
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  locations: [],
  selectedId: null,
  selectedRouteId: null,
  worldScale: DEFAULT_WORLD_SCALE,
  backgroundImage: null,

  politicalEntities: [],
  pendingPoliticalEntityId: null,

  addPoliticalEntity: (name: string) =>
    set((s) => {
      const trimmed = name.trim();
      if (trimmed === "") return s;
      const id = `political-entity-${nextPoliticalEntityId++}`;
      return {
        politicalEntities: [...s.politicalEntities, { id, name: trimmed, type: DEFAULT_POLITICAL_ENTITY_TYPE }],
        // First PoliticalEntity defined becomes the default target for new Locations.
        pendingPoliticalEntityId: s.pendingPoliticalEntityId ?? id,
      };
    }),

  /** Deleting a PoliticalEntity also deletes every Location that belonged to it -- a Location can't exist without one (see addLocation), so there's no "unassigned" state to fall back to. Any Routes touching one of those Locations go with them, same as removeLocation. */
  removePoliticalEntity: (id) =>
    set((s) => {
      const removedIds = new Set(s.locations.filter((loc) => loc.politicalEntityId === id).map((loc) => loc.id));
      const remainingLocations = s.locations.filter((loc) => !removedIds.has(loc.id));
      const routes = s.routes.filter((r) => !removedIds.has(r.locationAId) && !removedIds.has(r.locationBId));
      return {
        politicalEntities: s.politicalEntities.filter((c) => c.id !== id),
        locations: remainingLocations,
        routes,
        selectedId: remainingLocations.some((loc) => loc.id === s.selectedId) ? s.selectedId : null,
        selectedRouteId: routes.some((r) => r.id === s.selectedRouteId) ? s.selectedRouteId : null,
        pendingPoliticalEntityId: s.pendingPoliticalEntityId === id ? null : s.pendingPoliticalEntityId,
      };
    }),

  setPendingPoliticalEntityId: (id) => set({ pendingPoliticalEntityId: id }),

  setPoliticalEntityType: (id, type) =>
    set((s) => ({
      politicalEntities: s.politicalEntities.map((c) => (c.id === id ? { ...c, type } : c)),
    })),

  updatePoliticalEntityName: (id, name) =>
    set((s) => ({
      politicalEntities: s.politicalEntities.map((c) => (c.id === id ? { ...c, name } : c)),
    })),

  setWorldScale: (scale) => {
    if (!Number.isFinite(scale)) return;
    // Pure coordinate multiplier -- never touches any Location's normalized
    // position, so nothing moves on the canvas when it changes.
    set({ worldScale: clamp(scale, MIN_WORLD_SCALE, MAX_WORLD_SCALE) });
  },

  setBackgroundImage: (dataUrl) => set({ backgroundImage: dataUrl }),

  loadWorld: (world) => {
    // world.locations / route control points arrive already normalized to
    // [0,1] (parseWorldJson converts the exported world coords back down using
    // the file's own worldScale) -- just clamp defensively.
    const worldScale = clamp(world.worldScale, MIN_WORLD_SCALE, MAX_WORLD_SCALE);
    const locations = world.locations.map((loc) => ({
      ...loc,
      x: clamp(loc.x, 0, 1),
      y: clamp(loc.y, 0, 1),
    }));

    // Re-seed every id counter past the imported ids so a subsequently-added
    // entity can't reuse an id already present in the loaded World.
    nextId = nextIdAfter(locations.map((l) => l.id), "loc-");
    nextPoliticalEntityId = nextIdAfter(world.politicalEntities.map((p) => p.id), "political-entity-");
    nextRouteId = nextIdAfter(world.routes.map((r) => r.id), "route-");
    nextRouteControlPointId = nextIdAfter(
      world.routes.flatMap((r) => r.controlPoints.map((p) => p.id)),
      "route-point-",
    );
    nextCompanyId = nextIdAfter(world.companies.map((c) => c.id), "company-");
    nextFleetMemberId = nextIdAfter(world.companies.flatMap((c) => c.fleet.map((m) => m.id)), "fleet-");

    set({
      worldScale,
      locations,
      politicalEntities: world.politicalEntities,
      commodities: world.commodities,
      companies: world.companies,
      routes: world.routes,
      selectedId: null,
      selectedRouteId: null,
      pendingPoliticalEntityId: world.politicalEntities[0]?.id ?? null,
    });
  },

  // x/y are normalized canvas coordinates in [0,1] (see WorldCanvas) -- the
  // world position they map to is (x, y) * worldScale.
  addLocation: (x: number, y: number) => {
    const { pendingPoliticalEntityId } = get();
    if (pendingPoliticalEntityId === null) return;
    const id = `loc-${nextId++}`;
    const location = createLocation(
      id,
      `Location ${nextId - 1}`,
      clamp(x, 0, 1),
      clamp(y, 0, 1),
      pendingPoliticalEntityId,
    );
    set((s) => ({ locations: [...s.locations, location], selectedId: id, selectedRouteId: null }));
  },

  updateLocation: (id, patch) => set((s) => ({ locations: updateOne(s.locations, id, patch) })),

  // x/y are normalized canvas coordinates in [0,1] (see WorldCanvas).
  moveLocation: (id, x, y) =>
    set((s) => ({
      locations: updateOne(s.locations, id, { x: clamp(x, 0, 1), y: clamp(y, 0, 1) }),
    })),

  removeLocation: (id) =>
    set((s) => {
      const routes = s.routes.filter((r) => r.locationAId !== id && r.locationBId !== id);
      return {
        locations: s.locations.filter((loc) => loc.id !== id),
        routes,
        selectedId: s.selectedId === id ? null : s.selectedId,
        selectedRouteId: routes.some((r) => r.id === s.selectedRouteId) ? s.selectedRouteId : null,
      };
    }),

  // Selecting a Location clears any selected Route -- only one thing is
  // inspected at a time (see RouteInspector / LocationInspector).
  selectLocation: (id) => set({ selectedId: id, selectedRouteId: null }),

  // Toggling a terminal type off a Location can make an existing Route to it
  // no longer valid -- a Route's routeType requires at least one matching
  // terminal at BOTH ends (mirrors src/sim/routes.ts's
  // compatibleRouteTypes/ROUTE_TERMINAL_COMPATIBILITY), so once this
  // Location no longer has one, that Route can't exist anymore either and is
  // deleted along with the toggle, rather than being left dangling.
  toggleTerminalType: (id, terminal) =>
    set((s) => {
      const locations = s.locations.map((loc): EditorLocation => {
        if (loc.id !== id) return loc;
        // A Platform can't be combined with any other terminal type (mirrors
        // Location's constructor validation in sim/location.ts).
        if (terminal === "Platform") {
          const hasPlatform = loc.terminalTypes.includes("Platform");
          return { ...loc, terminalTypes: hasPlatform ? [] : ["Platform"] };
        }
        const withoutPlatform = loc.terminalTypes.filter((t) => t !== "Platform");
        const has = withoutPlatform.includes(terminal);
        return {
          ...loc,
          terminalTypes: has ? withoutPlatform.filter((t) => t !== terminal) : [...withoutPlatform, terminal],
        };
      });
      const locationById = new Map(locations.map((loc) => [loc.id, loc]));
      const routes = s.routes.filter((r) => {
        if (r.locationAId !== id && r.locationBId !== id) return true;
        const a = locationById.get(r.locationAId);
        const b = locationById.get(r.locationBId);
        if (a === undefined || b === undefined) return true;
        const required = ROUTE_TERMINAL_COMPATIBILITY[r.routeType];
        return required.some((t) => a.terminalTypes.includes(t)) && required.some((t) => b.terminalTypes.includes(t));
      });
      return { locations, routes, selectedRouteId: routes.some((r) => r.id === s.selectedRouteId) ? s.selectedRouteId : null };
    }),

  routes: [],

  addRoute: (locationAId, locationBId) =>
    set((s) => {
      if (locationAId === locationBId) return s;
      const a = s.locations.find((loc) => loc.id === locationAId);
      const b = s.locations.find((loc) => loc.id === locationBId);
      if (a === undefined || b === undefined) return s;
      if (a.terminalTypes.length === 0 || b.terminalTypes.length === 0) return s;
      const alreadyConnected = s.routes.some(
        (r) =>
          (r.locationAId === locationAId && r.locationBId === locationBId) ||
          (r.locationAId === locationBId && r.locationBId === locationAId),
      );
      if (alreadyConnected) return s;
      // Pick a RouteType both Locations' terminals actually support (in
      // ROUTE_TYPES priority order); if the two share no compatible terminal
      // at all (e.g. a Wagon yard paired with an Airport), no RouteType can
      // legally connect them, so refuse to create a Route rather than
      // falling back to some default type neither end actually supports.
      const compatible = compatibleRouteTypes(a.terminalTypes, b.terminalTypes);
      if (compatible.length === 0) return s;
      const routeType = compatible[0];
      const id = `route-${nextRouteId++}`;
      return {
        routes: [
          ...s.routes,
          { id, locationAId, locationBId, routeType, controlPoints: [] },
        ],
      };
    }),

  removeRoute: (id) =>
    set((s) => ({
      routes: s.routes.filter((r) => r.id !== id),
      selectedRouteId: s.selectedRouteId === id ? null : s.selectedRouteId,
    })),

  // Selecting a Route clears any selected Location -- only one thing is
  // inspected at a time (see RouteInspector / LocationInspector).
  selectRoute: (id) => set({ selectedRouteId: id, selectedId: null }),

  setRouteType: (id, routeType) =>
    set((s) => ({ routes: s.routes.map((r) => (r.id === id ? { ...r, routeType } : r)) })),

  addRouteControlPoint: (routeId, x, y) => {
    if (!get().routes.some((r) => r.id === routeId)) return null;
    const id = `route-point-${nextRouteControlPointId++}`;
    set((s) => ({
      routes: s.routes.map((r) => {
        if (r.id !== routeId) return r;
        const controlPoints = [...r.controlPoints, { id, x, y }];
        return { ...r, controlPoints };
      }),
    }));
    return id;
  },

  moveRouteControlPoint: (routeId, pointId, x, y) =>
    set((s) => ({
      routes: s.routes.map((r) =>
        r.id === routeId
          ? { ...r, controlPoints: r.controlPoints.map((p) => (p.id === pointId ? { ...p, x, y } : p)) }
          : r,
      ),
    })),

  removeRouteControlPoint: (routeId, pointId) =>
    set((s) => ({
      routes: s.routes.map((r) => {
        if (r.id !== routeId) return r;
        const controlPoints = r.controlPoints.filter((p) => p.id !== pointId);
        return { ...r, controlPoints };
      }),
    })),

  setCommodityValue: (id, field, commodity, value) =>
    set((s) => ({
      locations: s.locations.map((loc) =>
        loc.id === id ? { ...loc, [field]: { ...loc[field], [commodity]: value } } : loc,
      ),
    })),

  addProducedCommodity: (id, commodity, modifier = 1.0) => {
    const registered = get().commodities.find((c) => c.name === commodity);
    const effectiveRate = (registered?.productionRate ?? DEFAULT_COMMODITY_RATE) * modifier;
    const stockpile = round2(effectiveRate * PRODUCED_STOCKPILE_DAYS);
    set((s) => ({
      locations: s.locations.map((loc) => {
        if (loc.id !== id) return loc;
        // A commodity can't be both produced and consumed at the same
        // Location (mirrors Location's constructor validation in
        // sim/location.ts) -- refuse a genuinely new addition if it's
        // already consumed here; an existing entry's modifier can still be
        // edited freely via this same action.
        if (!(commodity in loc.producedCommodities) && commodity in loc.consumedCommodities) return loc;
        return {
          ...loc,
          producedCommodities: { ...loc.producedCommodities, [commodity]: modifier },
          stockpiles: { ...loc.stockpiles, [commodity]: stockpile },
          // Base price modifier defaults to 1.0 the first time this
          // commodity is added, but a later modifier edit (this same
          // action, re-invoked) must not clobber a value the user has
          // since hand-edited (see BasePriceEditor).
          basePriceModifiers:
            commodity in loc.basePriceModifiers
              ? loc.basePriceModifiers
              : { ...loc.basePriceModifiers, [commodity]: 1.0 },
        };
      }),
    }));
  },

  addConsumedCommodity: (id, commodity, modifier = 1.0) => {
    const registered = get().commodities.find((c) => c.name === commodity);
    const effectiveRate = (registered?.consumptionRate ?? DEFAULT_COMMODITY_RATE) * modifier;
    const minStockpile = round2(effectiveRate * MIN_STOCKPILE_DAYS);
    const stockpile = round2(minStockpile * CONSUMED_STOCKPILE_FACTOR);
    set((s) => ({
      locations: s.locations.map((loc) => {
        if (loc.id !== id) return loc;
        if (!(commodity in loc.consumedCommodities) && commodity in loc.producedCommodities) return loc;
        return {
          ...loc,
          consumedCommodities: { ...loc.consumedCommodities, [commodity]: modifier },
          minStockpiles: { ...loc.minStockpiles, [commodity]: minStockpile },
          stockpiles: { ...loc.stockpiles, [commodity]: stockpile },
          basePriceModifiers:
            commodity in loc.basePriceModifiers
              ? loc.basePriceModifiers
              : { ...loc.basePriceModifiers, [commodity]: 1.0 },
        };
      }),
    }));
  },

  removeProducedCommodity: (id, commodity) =>
    set((s) => ({
      locations: s.locations.map((loc) => {
        if (loc.id !== id) return loc;
        const { [commodity]: _produced, ...producedCommodities } = loc.producedCommodities;
        const { [commodity]: _stock, ...stockpiles } = loc.stockpiles;
        const { [commodity]: _price, ...basePriceModifiers } = loc.basePriceModifiers;
        return { ...loc, producedCommodities, stockpiles, basePriceModifiers };
      }),
    })),

  removeConsumedCommodity: (id, commodity) =>
    set((s) => ({
      locations: s.locations.map((loc) => {
        if (loc.id !== id) return loc;
        const { [commodity]: _consumed, ...consumedCommodities } = loc.consumedCommodities;
        const { [commodity]: _stock, ...stockpiles } = loc.stockpiles;
        const { [commodity]: _min, ...minStockpiles } = loc.minStockpiles;
        const { [commodity]: _price, ...basePriceModifiers } = loc.basePriceModifiers;
        return { ...loc, consumedCommodities, stockpiles, minStockpiles, basePriceModifiers };
      }),
    })),

  commodities: [],
  companies: [],

  addCommodity: (name: string) =>
    set((s) => {
      const trimmed = name.trim();
      if (trimmed === "" || s.commodities.some((c) => c.name === trimmed)) return s;
      return {
        commodities: [...s.commodities, {
          name: trimmed, basePrice: 0,
          productionRate: DEFAULT_COMMODITY_RATE, consumptionRate: DEFAULT_COMMODITY_RATE,
        }],
      };
    }),

  updateCommodityBasePrice: (name, basePrice) =>
    set((s) => ({
      commodities: s.commodities.map((c) => (c.name === name ? { ...c, basePrice } : c)),
    })),

  // Stockpiles are never hand-edited (see addProducedCommodity/
  // addConsumedCommodity), so a commodity's registered rate changing must
  // re-derive every Location that currently produces/consumes it -- otherwise
  // their stockpile would silently go stale with no way to notice or fix it.
  updateCommodityProductionRate: (name, productionRate) =>
    set((s) => ({
      commodities: s.commodities.map((c) => (c.name === name ? { ...c, productionRate } : c)),
      locations: s.locations.map((loc) => {
        const modifier = loc.producedCommodities[name];
        if (modifier === undefined) return loc;
        const stockpile = round2(productionRate * modifier * PRODUCED_STOCKPILE_DAYS);
        return { ...loc, stockpiles: { ...loc.stockpiles, [name]: stockpile } };
      }),
    })),

  updateCommodityConsumptionRate: (name, consumptionRate) =>
    set((s) => ({
      commodities: s.commodities.map((c) => (c.name === name ? { ...c, consumptionRate } : c)),
      locations: s.locations.map((loc) => {
        const modifier = loc.consumedCommodities[name];
        if (modifier === undefined) return loc;
        const minStockpile = round2(consumptionRate * modifier * MIN_STOCKPILE_DAYS);
        const stockpile = round2(minStockpile * CONSUMED_STOCKPILE_FACTOR);
        return {
          ...loc,
          minStockpiles: { ...loc.minStockpiles, [name]: minStockpile },
          stockpiles: { ...loc.stockpiles, [name]: stockpile },
        };
      }),
    })),

  // Dropping a commodity from the registry also scrubs it from every
  // Location's produced/consumed/stockpile/price maps -- the dropdown is the
  // only way to add a commodity to a Location, so nothing should reference a
  // name the registry no longer recognizes.
  removeCommodity: (name) =>
    set((s) => ({
      commodities: s.commodities.filter((c) => c.name !== name),
      locations: s.locations.map((loc) => {
        const patch: Partial<EditorLocation> = {};
        for (const field of COMMODITY_FIELDS) {
          if (name in loc[field]) {
            const entries = Object.entries(loc[field]).filter(([k]) => k !== name);
            patch[field] = Object.fromEntries(entries);
          }
        }
        return { ...loc, ...patch };
      }),
    })),

  addCompany: (name, startingFunds = DEFAULT_COMPANY_STARTING_FUNDS) =>
    set((s) => ({
      companies: [...s.companies, { id: `company-${nextCompanyId++}`, name, startingFunds, fleet: [] }],
    })),
  updateCompanyName: (id, name) =>
    set((s) => ({ companies: s.companies.map((c) => (c.id === id ? { ...c, name } : c)) })),
  updateCompanyStartingFunds: (id, startingFunds) =>
    set((s) => ({ companies: s.companies.map((c) => (c.id === id ? { ...c, startingFunds } : c)) })),
  removeCompany: (id) => set((s) => ({ companies: s.companies.filter((c) => c.id !== id) })),

  addFleetMember: (companyId, transportType, transportName, captainName) =>
    set((s) => ({
      companies: s.companies.map((c) => {
        if (c.id !== companyId) return c;
        const member: EditorFleetMember = { id: `fleet-${nextFleetMemberId++}`, transportType, transportName, captainName };
        return { ...c, fleet: [...c.fleet, member] };
      }),
    })),
  removeFleetMember: (companyId, memberId) =>
    set((s) => ({
      companies: s.companies.map((c) =>
        c.id === companyId ? { ...c, fleet: c.fleet.filter((m) => m.id !== memberId) } : c,
      ),
    })),
}));
