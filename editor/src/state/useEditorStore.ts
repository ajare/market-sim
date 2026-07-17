/**
 * Holds the editor's World -- currently just a flat list of Locations
 * (Routes/Companies/etc. aren't modeled yet). Starts empty; the canvas adds
 * a Location wherever the user clicks.
 */
import { create } from "zustand";
import {
  createLocation, createChieftain, compatibleRouteTypes, factionType,
  DEFAULT_COMMODITY_RATE, DEFAULT_COMMODITY_TYPE, DEFAULT_COMMODITY_GIFT, DEFAULT_COMPANY_STARTING_FUNDS, DEFAULT_POLITICAL_ENTITY_TYPE,
  DEFAULT_EXPLORER_PORTER_COUNT, DEFAULT_EXPLORER_ANIMAL_COUNT, DEFAULT_EXPLORER_STARTING_CASH, DEFAULT_EXPLORER_AI_CONTROLLED,
  ROUTE_TERMINAL_COMPATIBILITY,
  type Commodity, type CommodityField, type CommodityType, type EditorChieftain, type EditorCompany,
  type EditorExplorer, type EditorFleetMember, type EditorRoute,
  type PoliticalEntity, type PoliticalEntityType, type EditorLocation, type RouteType, type TerminalType, type TransportType,
} from "../types";
import { DEFAULT_START_DATE, type EditorWorld } from "../worldJson";
import {
  DEFAULT_DISTANCE_MODE, DEFAULT_GLOBE_LON_SPAN, defaultGlobeRadius,
  type DistanceConfig, type DistanceMode,
} from "../distance";
import { DEFAULT_DISTANCE_UNIT, type DistanceUnit } from "../units";
import { DEFAULT_WEATHER_PROFILE_NAME, type WeatherProfileName } from "../weatherProfiles";
import { DEFAULT_NATIONALITY, type Nationality } from "../nameGenerators";
import { defaultCompanyHomeLocation, refreshCompanyHomeLocations, resolveCompanyHomeLocation } from "../companyHome";

let nextId = 1;
let nextPoliticalEntityId = 1;
let nextRouteId = 1;
let nextRouteControlPointId = 1;
let nextCompanyId = 1;
let nextFleetMemberId = 1;
let nextExplorerId = 1;

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

  /** How distances are measured for display and export -- "flat" (Euclidean plane, the default) or "globe" (great-circle on a sphere). See distance.ts. */
  distanceMode: DistanceMode;
  /** Sphere radius in world-size units, used only in globe mode. */
  globeRadius: number;
  /** Degrees of longitude a full map width spans, used only in globe mode (the same degrees-per-fraction applies vertically). */
  globeLonSpan: number;
  setDistanceMode: (mode: DistanceMode) => void;
  setGlobeRadius: (radius: number) => void;
  setGlobeLonSpan: (lonSpan: number) => void;
  /** The active distance settings bundled for distance.ts's helpers. */
  distanceConfig: () => DistanceConfig;

  /** Real-world unit distances/speeds are DISPLAYED in -- purely cosmetic (route length/speed readouts), never affects distance math. See units.ts. */
  distanceUnit: DistanceUnit;
  setDistanceUnit: (unit: DistanceUnit) => void;

  /** Which named WeatherProfile (see src/sim/weather.ts) shapes this World's simulated weather. See weatherProfiles.ts. */
  weatherProfile: WeatherProfileName;
  setWeatherProfile: (profile: WeatherProfileName) => void;

  /** The in-world date/time of day 1, as an ISO 8601 string -- set via the header's start-date control, exported/imported verbatim (see worldJson.ts). */
  startDate: string;
  setStartDate: (startDate: string) => void;

  /** A user-picked background image (data URL) drawn behind the canvas, or null for none. Rendered as a plain HTML image fixed to the canvas viewport, so it does NOT scale when the world size changes (see WorldCanvas). Purely an editor view setting -- not part of the exported World. */
  backgroundImage: string | null;
  setBackgroundImage: (dataUrl: string | null) => void;

  /** Replaces the entire authored World with an imported one (see worldJson.ts), clearing UI state (selection) and re-seeding id counters past every imported id so later additions can't collide. */
  loadWorld: (world: EditorWorld) => void;

  /** PoliticalEntities a new Location can belong to -- membership is required at creation time (see addLocation), which the canvas's placement menu supplies, so an empty registry means a Location can't be placed. */
  politicalEntities: PoliticalEntity[];
  addPoliticalEntity: (name: string) => void;
  /** Removes the PoliticalEntity, along with every Location that belonged to it -- a Location can't exist without one. */
  removePoliticalEntity: (id: string) => void;
  setPoliticalEntityType: (id: string, type: PoliticalEntityType) => void;
  setPoliticalEntityNationality: (id: string, nationality: Nationality) => void;
  updatePoliticalEntityName: (id: string, name: string) => void;

  /** Creates a Location at (x, y) owned by `politicalEntityId` (chosen from the canvas's placement menu). No-ops if that PoliticalEntity doesn't exist. */
  addLocation: (x: number, y: number, politicalEntityId: string) => void;
  updateLocation: (id: string, patch: Partial<EditorLocation>) => void;
  moveLocation: (id: string, x: number, y: number) => void;
  removeLocation: (id: string) => void;
  selectLocation: (id: string | null) => void;
  toggleTerminalType: (id: string, terminal: TerminalType) => void;

  /** Adds/removes a Location's personal ruler (exploration mode) -- `true` installs a freshly created Chieftain (see createChieftain), `false` clears it back to null. No-op if the Location doesn't exist. */
  setLocationHasRuler: (id: string, hasRuler: boolean) => void;
  /** Edits fields on a Location's existing ruler -- no-op if the Location has none. */
  updateLocationRuler: (id: string, patch: Partial<EditorChieftain>) => void;

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
  /** Appends a straight Route of `routeType` for each given pair, with a fresh id and no control points -- used by the header's "Auto-connect Sea routes" action, which has already filtered the pairs (see autoRoutes.ts). Trusted to receive valid, not-already-connected pairs; performs no per-pair validation of its own. */
  addRoutesForPairs: (pairs: ReadonlyArray<{ locationAId: string; locationBId: string }>, routeType: RouteType) => void;
  removeRoute: (id: string) => void;
  /** Removes every Route, clearing any selected Route. Used by the toolbar's "Delete all routes" action. */
  clearRoutes: () => void;
  /** Adds a new control point to a Route at (x, y) and returns the point's id so the caller (WorldCanvas) can immediately start dragging it. The Route's rendered curve follows from the resulting count (see routeRenderPoints). No-ops (returning null) if the Route doesn't exist. */
  addRouteControlPoint: (routeId: string, x: number, y: number) => string | null;
  /** Repositions an existing control point -- no-op if the Route or point doesn't exist. */
  moveRouteControlPoint: (routeId: string, pointId: string, x: number, y: number) => void;
  /** Removes a control point -- no-op if the Route or point doesn't exist. The Route's rendered curve follows from the resulting (smaller) count (see routeRenderPoints). */
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
  addCommodity: (name: string, basePrice?: number, type?: CommodityType) => void;
  updateCommodityBasePrice: (name: string, basePrice: number) => void;
  updateCommodityProductionRate: (name: string, productionRate: number) => void;
  updateCommodityConsumptionRate: (name: string, consumptionRate: number) => void;
  updateCommodityType: (name: string, type: CommodityType) => void;
  updateCommodityGift: (name: string, gift: number) => void;
  removeCommodity: (name: string) => void;

  /** Companies defined for this World -- captain strategy params and home location aren't modeled in the editor, just name, starting funds, and a fleet of (Transport type/name, Captain name) pairs. */
  companies: EditorCompany[];
  addCompany: (name: string, startingFunds?: number) => void;
  /** Creates a Company with a pre-generated name and fleet in one shot (see CompaniesPanel's nationality generator) -- ids for the company and each fleet member are assigned here. `homeLocationId` is ignored (stored as null) for a 1-ship fleet, which is always a SoloTrader. */
  addGeneratedCompany: (
    name: string,
    members: Array<{ transportType: TransportType; transportName: string; captainName: string }>,
    startingFunds?: number,
    politicalEntityId?: string | null,
    homeLocationId?: string | null,
  ) => void;
  updateCompanyName: (id: string, name: string) => void;
  updateCompanyStartingFunds: (id: string, startingFunds: number) => void;
  /** Sets a Company's PoliticalEntity affiliation, or null for Independent -- also resets homeLocationId to the new affiliation's default (see companyHome.ts). */
  updateCompanyPoliticalEntity: (id: string, politicalEntityId: string | null) => void;
  /** Sets a Company's home Location directly (the inspector's dropdown) -- no-op if the Company doesn't exist. */
  updateCompanyHomeLocation: (id: string, locationId: string) => void;
  removeCompany: (id: string) => void;
  /** Adds a Captain/Transport pair to a Company's fleet -- no-op if the Company doesn't exist. */
  addFleetMember: (companyId: string, transportType: TransportType, transportName: string, captainName: string) => void;
  removeFleetMember: (companyId: string, memberId: string) => void;

  /** Expedition parties for this World (exploration mode) -- independent of Companies/PoliticalEntities, each just needs a home Location. */
  explorers: EditorExplorer[];
  /** Creates an Explorer at `homeLocationId` with default porter/animal counts and starting cash -- no-op if that Location doesn't exist. */
  addExplorer: (name: string, homeLocationId: string, politicalEntityId?: string | null) => void;
  updateExplorer: (id: string, patch: Partial<EditorExplorer>) => void;
  removeExplorer: (id: string) => void;
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

  distanceMode: DEFAULT_DISTANCE_MODE,
  globeRadius: defaultGlobeRadius(DEFAULT_WORLD_SCALE),
  globeLonSpan: DEFAULT_GLOBE_LON_SPAN,
  setDistanceMode: (mode) => set({ distanceMode: mode }),
  setGlobeRadius: (radius) => set({ globeRadius: Math.max(0.01, radius) }),
  setGlobeLonSpan: (lonSpan) => set({ globeLonSpan: clamp(lonSpan, 1, 360) }),
  distanceConfig: () => {
    const s = get();
    return { mode: s.distanceMode, radius: s.globeRadius, lonSpan: s.globeLonSpan, worldScale: s.worldScale };
  },

  distanceUnit: DEFAULT_DISTANCE_UNIT,
  setDistanceUnit: (unit) => set({ distanceUnit: unit }),

  weatherProfile: DEFAULT_WEATHER_PROFILE_NAME,
  setWeatherProfile: (profile) => set({ weatherProfile: profile }),

  startDate: DEFAULT_START_DATE,
  setStartDate: (startDate) => {
    if (Number.isNaN(Date.parse(startDate))) return;
    set({ startDate });
  },

  politicalEntities: [],

  addPoliticalEntity: (name: string) =>
    set((s) => {
      const trimmed = name.trim();
      if (trimmed === "") return s;
      const id = `political-entity-${nextPoliticalEntityId++}`;
      return {
        politicalEntities: [
          ...s.politicalEntities,
          { id, name: trimmed, type: DEFAULT_POLITICAL_ENTITY_TYPE, nationality: DEFAULT_NATIONALITY },
        ],
      };
    }),

  /** Deleting a PoliticalEntity also deletes every Location that belonged to it -- a Location can't exist without one (see addLocation), so there's no "unassigned" state to fall back to. Any Routes touching one of those Locations go with them, same as removeLocation. */
  removePoliticalEntity: (id) =>
    set((s) => {
      const removedIds = new Set(s.locations.filter((loc) => loc.politicalEntityId === id).map((loc) => loc.id));
      const remainingLocations = s.locations.filter((loc) => !removedIds.has(loc.id));
      const routes = s.routes.filter((r) => !removedIds.has(r.locationAId) && !removedIds.has(r.locationBId));
      // A Company affiliated with the removed PoliticalEntity falls back to
      // Independent rather than dangling; nulling its homeLocationId here
      // (rather than leaving whatever it was) forces refreshCompanyHomeLocations
      // below to unconditionally recompute a fresh default for the new (null)
      // affiliation, same as changing it manually would (see
      // updateCompanyPoliticalEntity) -- it also catches any OTHER Company
      // whose home Location was one of this entity's, now removed along with it.
      const reaffiliated = s.companies.map((c) =>
        c.politicalEntityId === id ? { ...c, politicalEntityId: null, homeLocationId: null } : c,
      );
      return {
        politicalEntities: s.politicalEntities.filter((c) => c.id !== id),
        locations: remainingLocations,
        routes,
        companies: refreshCompanyHomeLocations(reaffiliated, remainingLocations),
        selectedId: remainingLocations.some((loc) => loc.id === s.selectedId) ? s.selectedId : null,
        selectedRouteId: routes.some((r) => r.id === s.selectedRouteId) ? s.selectedRouteId : null,
      };
    }),

  setPoliticalEntityNationality: (id, nationality) =>
    set((s) => ({
      politicalEntities: s.politicalEntities.map((c) => (c.id === id ? { ...c, nationality } : c)),
    })),

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
    nextExplorerId = nextIdAfter(world.explorers.map((e) => e.id), "explorer-");

    // Normalize company affiliation: default a missing politicalEntityId (older
    // files predating this field) to null, and drop any affiliation pointing at
    // a PoliticalEntity that isn't in the imported World -- either way the
    // Company reads as Independent rather than dangling.
    const entityIds = new Set(world.politicalEntities.map((p) => p.id));
    const companiesWithEntity = world.companies.map((c) => ({
      ...c,
      politicalEntityId: c.politicalEntityId != null && entityIds.has(c.politicalEntityId) ? c.politicalEntityId : null,
      // Missing (pre-v5 files) or dangling homeLocationId defaults to null here;
      // refreshCompanyHomeLocations below resolves it (or leaves a SoloTrader's
      // at null) against the just-imported Locations.
      homeLocationId: c.homeLocationId ?? null,
    }));
    const companies = refreshCompanyHomeLocations(companiesWithEntity, locations);

    // An Explorer whose homeLocationId doesn't resolve to a Location in this
    // World is dropped rather than left dangling (mirrors buildWorldFromJson.ts's
    // own skip-on-unresolved behavior for the same field). Its political
    // affiliation is normalized the same way a Company's is, just above --
    // missing or dangling defaults to null (Independent).
    const locationIds = new Set(locations.map((loc) => loc.id));
    const explorers = world.explorers
      .filter((e) => locationIds.has(e.homeLocationId))
      .map((e) => ({
        ...e,
        politicalEntityId: e.politicalEntityId != null && entityIds.has(e.politicalEntityId) ? e.politicalEntityId : null,
      }));

    set({
      worldScale,
      distanceMode: world.distanceMode,
      globeRadius: world.globeRadius > 0 ? world.globeRadius : defaultGlobeRadius(worldScale),
      globeLonSpan: clamp(world.globeLonSpan, 1, 360),
      distanceUnit: world.distanceUnit,
      weatherProfile: world.weatherProfile,
      startDate: Number.isNaN(Date.parse(world.startDate)) ? DEFAULT_START_DATE : world.startDate,
      locations,
      politicalEntities: world.politicalEntities,
      commodities: world.commodities,
      companies,
      routes: world.routes,
      explorers,
      selectedId: null,
      selectedRouteId: null,
    });
  },

  // x/y are normalized canvas coordinates in [0,1] (see WorldCanvas) -- the
  // world position they map to is (x, y) * worldScale. The owning
  // politicalEntityId comes from the canvas's placement menu.
  addLocation: (x: number, y: number, politicalEntityId: string) => {
    const { politicalEntities } = get();
    if (!politicalEntities.some((p) => p.id === politicalEntityId)) return;
    const id = `loc-${nextId++}`;
    const location = createLocation(id, `Location ${nextId - 1}`, clamp(x, 0, 1), clamp(y, 0, 1), politicalEntityId);
    set((s) => ({ locations: [...s.locations, location], selectedId: id, selectedRouteId: null }));
  },

  // Reassigning a Location's politicalEntityId (see LocationInspector) can
  // change which Locations a PoliticalEntity owns, same invalidation risk as
  // removing one outright -- refreshCompanyHomeLocations is cheap and a no-op
  // for any Company this doesn't actually affect, so it's simplest to just
  // always run it here rather than special-case which patches matter.
  updateLocation: (id, patch) =>
    set((s) => {
      const locations = updateOne(s.locations, id, patch);
      return { locations, companies: refreshCompanyHomeLocations(s.companies, locations) };
    }),

  // x/y are normalized canvas coordinates in [0,1] (see WorldCanvas).
  moveLocation: (id, x, y) =>
    set((s) => ({
      locations: updateOne(s.locations, id, { x: clamp(x, 0, 1), y: clamp(y, 0, 1) }),
    })),

  removeLocation: (id) =>
    set((s) => {
      const routes = s.routes.filter((r) => r.locationAId !== id && r.locationBId !== id);
      const locations = s.locations.filter((loc) => loc.id !== id);
      return {
        locations,
        routes,
        // Any Company whose home Location was this one gets a freshly
        // recomputed default (see companyHome.ts) rather than dangling.
        companies: refreshCompanyHomeLocations(s.companies, locations),
        // An Explorer has no fallback home Location (unlike a Company) --
        // deleting its home Location deletes the Explorer along with it.
        explorers: s.explorers.filter((e) => e.homeLocationId !== id),
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
      return {
        locations,
        routes,
        // A Company home-ported here whose fleet no longer fits this
        // Location's new TerminalTypes gets a freshly recomputed default.
        companies: refreshCompanyHomeLocations(s.companies, locations),
        selectedRouteId: routes.some((r) => r.id === s.selectedRouteId) ? s.selectedRouteId : null,
      };
    }),

  setLocationHasRuler: (id, hasRuler) =>
    set((s) => ({
      locations: s.locations.map((loc) => {
        if (loc.id !== id) return loc;
        return { ...loc, ruler: hasRuler ? createChieftain(`Chief ${loc.name}`) : null };
      }),
    })),

  updateLocationRuler: (id, patch) =>
    set((s) => ({
      locations: s.locations.map((loc) => {
        if (loc.id !== id || loc.ruler === null) return loc;
        return { ...loc, ruler: { ...loc.ruler, ...patch } };
      }),
    })),

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

  addRoutesForPairs: (pairs, routeType) =>
    set((s) => ({
      routes: [
        ...s.routes,
        ...pairs.map((p) => ({
          id: `route-${nextRouteId++}`,
          locationAId: p.locationAId,
          locationBId: p.locationBId,
          routeType,
          controlPoints: [],
        })),
      ],
    })),

  removeRoute: (id) =>
    set((s) => ({
      routes: s.routes.filter((r) => r.id !== id),
      selectedRouteId: s.selectedRouteId === id ? null : s.selectedRouteId,
    })),

  clearRoutes: () => set({ routes: [], selectedRouteId: null }),

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
  explorers: [],

  addCommodity: (name: string, basePrice = 0, type = DEFAULT_COMMODITY_TYPE) =>
    set((s) => {
      const trimmed = name.trim();
      if (trimmed === "" || s.commodities.some((c) => c.name === trimmed)) return s;
      return {
        commodities: [...s.commodities, {
          name: trimmed, basePrice, type,
          productionRate: DEFAULT_COMMODITY_RATE, consumptionRate: DEFAULT_COMMODITY_RATE,
          gift: DEFAULT_COMMODITY_GIFT,
        }],
      };
    }),

  updateCommodityBasePrice: (name, basePrice) =>
    set((s) => ({
      commodities: s.commodities.map((c) => (c.name === name ? { ...c, basePrice } : c)),
    })),

  updateCommodityGift: (name, gift) =>
    set((s) => ({
      commodities: s.commodities.map((c) => (c.name === name ? { ...c, gift } : c)),
    })),

  updateCommodityType: (name, type) =>
    set((s) => ({
      commodities: s.commodities.map((c) => (c.name === name ? { ...c, type } : c)),
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
    set((s) => {
      const fleet: EditorFleetMember[] = [];
      const homeLocationId = defaultCompanyHomeLocation(null, s.locations, []);
      return {
        companies: [
          ...s.companies,
          { id: `company-${nextCompanyId++}`, name, startingFunds, fleet, politicalEntityId: null, homeLocationId },
        ],
      };
    }),
  addGeneratedCompany: (name, members, startingFunds = DEFAULT_COMPANY_STARTING_FUNDS, politicalEntityId = null, homeLocationId = null) =>
    set((s) => {
      const fleet: EditorFleetMember[] = members.map((m) => ({ id: `fleet-${nextFleetMemberId++}`, ...m }));
      // A 1-ship generated fleet is a SoloTrader (no home port) regardless of
      // what was passed in -- anything else falls back to the computed
      // default if the caller didn't supply one explicitly.
      const resolvedHomeLocationId =
        fleet.length === 1
          ? null
          : homeLocationId ?? defaultCompanyHomeLocation(politicalEntityId, s.locations, members.map((m) => m.transportType));
      return {
        companies: [
          ...s.companies,
          { id: `company-${nextCompanyId++}`, name, startingFunds, fleet, politicalEntityId, homeLocationId: resolvedHomeLocationId },
        ],
      };
    }),
  updateCompanyName: (id, name) =>
    set((s) => ({ companies: s.companies.map((c) => (c.id === id ? { ...c, name } : c)) })),
  updateCompanyStartingFunds: (id, startingFunds) =>
    set((s) => ({ companies: s.companies.map((c) => (c.id === id ? { ...c, startingFunds } : c)) })),
  // Changing affiliation always resets homeLocationId to the new entity's
  // default (per spec), even if the old one would still be compatible --
  // unlike the "keep it if still valid" policy resolveCompanyHomeLocation
  // applies everywhere else.
  updateCompanyPoliticalEntity: (id, politicalEntityId) =>
    set((s) => ({
      companies: s.companies.map((c) => {
        if (c.id !== id) return c;
        const transportTypes = c.fleet.map((m) => m.transportType);
        const homeLocationId =
          factionType(c.fleet) === "SoloTrader" ? null : defaultCompanyHomeLocation(politicalEntityId, s.locations, transportTypes);
        return { ...c, politicalEntityId, homeLocationId };
      }),
    })),
  updateCompanyHomeLocation: (id, locationId) =>
    set((s) => ({ companies: s.companies.map((c) => (c.id === id ? { ...c, homeLocationId: locationId } : c)) })),
  removeCompany: (id) => set((s) => ({ companies: s.companies.filter((c) => c.id !== id) })),

  addFleetMember: (companyId, transportType, transportName, captainName) =>
    set((s) => ({
      companies: s.companies.map((c) => {
        if (c.id !== companyId) return c;
        const member: EditorFleetMember = { id: `fleet-${nextFleetMemberId++}`, transportType, transportName, captainName };
        const updated = { ...c, fleet: [...c.fleet, member] };
        return { ...updated, homeLocationId: resolveCompanyHomeLocation(updated, s.locations) };
      }),
    })),
  removeFleetMember: (companyId, memberId) =>
    set((s) => ({
      companies: s.companies.map((c) => {
        if (c.id !== companyId) return c;
        const updated = { ...c, fleet: c.fleet.filter((m) => m.id !== memberId) };
        return { ...updated, homeLocationId: resolveCompanyHomeLocation(updated, s.locations) };
      }),
    })),

  addExplorer: (name, homeLocationId, politicalEntityId = null) =>
    set((s) => {
      if (!s.locations.some((l) => l.id === homeLocationId)) return s;
      const trimmed = name.trim();
      if (trimmed === "") return s;
      const explorer: EditorExplorer = {
        id: `explorer-${nextExplorerId++}`,
        name: trimmed,
        homeLocationId,
        porterCount: DEFAULT_EXPLORER_PORTER_COUNT,
        animalCount: DEFAULT_EXPLORER_ANIMAL_COUNT,
        startingCash: DEFAULT_EXPLORER_STARTING_CASH,
        politicalEntityId,
        aiControlled: DEFAULT_EXPLORER_AI_CONTROLLED,
      };
      return { explorers: [...s.explorers, explorer] };
    }),
  updateExplorer: (id, patch) =>
    set((s) => ({ explorers: s.explorers.map((e) => (e.id === id ? { ...e, ...patch } : e)) })),
  removeExplorer: (id) => set((s) => ({ explorers: s.explorers.filter((e) => e.id !== id) })),
}));
