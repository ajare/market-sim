/**
 * Holds the editor's World -- currently just a flat list of Locations
 * (Routes/Companies/etc. aren't modeled yet). Starts empty; the canvas adds
 * a Location wherever the user clicks.
 */
import { create } from "zustand";
import {
  createLocation, DEFAULT_COMMODITY_RATE,
  type Commodity, type CommodityField, type PoliticalEntity, type EditorLocation, type TerminalType,
} from "../types";

let nextId = 1;
let nextPoliticalEntityId = 1;

export const WORLD_ASPECT_RATIO = 4 / 3;
export const MIN_WORLD_WIDTH = 100;
export const MAX_WORLD_WIDTH = 1000;
export const DEFAULT_WORLD_WIDTH = 800;

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
  /** World width in units; height is always worldWidth / WORLD_ASPECT_RATIO, keeping a fixed 4:3 world. */
  worldWidth: number;
  setWorldWidth: (width: number) => void;

  /** PoliticalEntities a new Location can be placed into -- membership is required at creation time (see addLocation/pendingPoliticalEntityId), so an empty registry blocks placement entirely. */
  politicalEntities: PoliticalEntity[];
  /** Which PoliticalEntity a click on the canvas will assign to the new Location -- must be set (via the PoliticalEntities panel's dropdown) before addLocation will do anything. */
  pendingPoliticalEntityId: string | null;
  addPoliticalEntity: (name: string) => void;
  /** Removes the PoliticalEntity; any Locations that belonged to it fall back to unassigned (politicalEntityId: null) rather than being deleted themselves. */
  removePoliticalEntity: (id: string) => void;
  setPendingPoliticalEntityId: (id: string | null) => void;

  /** No-ops if pendingPoliticalEntityId is unset -- a Location can't be created without a PoliticalEntity selected first. */
  addLocation: (x: number, y: number) => void;
  updateLocation: (id: string, patch: Partial<EditorLocation>) => void;
  moveLocation: (id: string, x: number, y: number) => void;
  removeLocation: (id: string) => void;
  selectLocation: (id: string | null) => void;
  toggleTerminalType: (id: string, terminal: TerminalType) => void;
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
  worldWidth: DEFAULT_WORLD_WIDTH,

  politicalEntities: [],
  pendingPoliticalEntityId: null,

  addPoliticalEntity: (name: string) =>
    set((s) => {
      const trimmed = name.trim();
      if (trimmed === "") return s;
      const id = `political-entity-${nextPoliticalEntityId++}`;
      return {
        politicalEntities: [...s.politicalEntities, { id, name: trimmed }],
        // First PoliticalEntity defined becomes the default target for new Locations.
        pendingPoliticalEntityId: s.pendingPoliticalEntityId ?? id,
      };
    }),

  removePoliticalEntity: (id) =>
    set((s) => ({
      politicalEntities: s.politicalEntities.filter((c) => c.id !== id),
      locations: s.locations.map((loc) =>
        loc.politicalEntityId === id ? { ...loc, politicalEntityId: null } : loc,
      ),
      pendingPoliticalEntityId: s.pendingPoliticalEntityId === id ? null : s.pendingPoliticalEntityId,
    })),

  setPendingPoliticalEntityId: (id) => set({ pendingPoliticalEntityId: id }),

  setWorldWidth: (width: number) => {
    const worldWidth = clamp(width, MIN_WORLD_WIDTH, MAX_WORLD_WIDTH);
    const worldHeight = worldWidth / WORLD_ASPECT_RATIO;
    set((s) => ({
      worldWidth,
      locations: s.locations.map((loc) => ({
        ...loc,
        x: clamp(loc.x, 0, worldWidth),
        y: clamp(loc.y, 0, worldHeight),
      })),
    }));
  },

  addLocation: (x: number, y: number) => {
    const { worldWidth, pendingPoliticalEntityId } = get();
    if (pendingPoliticalEntityId === null) return;
    const worldHeight = worldWidth / WORLD_ASPECT_RATIO;
    const id = `loc-${nextId++}`;
    const location = createLocation(
      id,
      `Location ${nextId - 1}`,
      clamp(x, 0, worldWidth),
      clamp(y, 0, worldHeight),
      pendingPoliticalEntityId,
    );
    set((s) => ({ locations: [...s.locations, location], selectedId: id }));
  },

  updateLocation: (id, patch) => set((s) => ({ locations: updateOne(s.locations, id, patch) })),

  moveLocation: (id, x, y) => {
    const { worldWidth } = get();
    const worldHeight = worldWidth / WORLD_ASPECT_RATIO;
    set((s) => ({
      locations: updateOne(s.locations, id, { x: clamp(x, 0, worldWidth), y: clamp(y, 0, worldHeight) }),
    }));
  },

  removeLocation: (id) =>
    set((s) => ({
      locations: s.locations.filter((loc) => loc.id !== id),
      selectedId: s.selectedId === id ? null : s.selectedId,
    })),

  selectLocation: (id) => set({ selectedId: id }),

  toggleTerminalType: (id, terminal) =>
    set((s) => ({
      locations: s.locations.map((loc) => {
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
}));
