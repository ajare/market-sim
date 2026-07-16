/**
 * Commodity: encapsulates all data about ONE tradeable commodity that's
 * independent of any particular Location. Ported from sim/commodity.py.
 *
 * Fuel is deliberately NOT a Commodity -- see sim/worldData.ts.
 */
import { COMMODITY_TYPES, DEFAULT_COMMODITY_TYPE, type CommodityType } from "@market-sim/shared/commodity";
export { COMMODITY_TYPES, DEFAULT_COMMODITY_TYPE, type CommodityType };

export const DEFAULT_PRICE_SENSITIVITY = 0.45;
export const DEFAULT_DEFICIT_PRICE_BOOST = 1.4;
/** Mirror of DEFAULT_DEFICIT_PRICE_BOOST for the producer/excess side (see Market.stockpilePrice). */
export const DEFAULT_EXCESS_PRICE_BOOST = 1.4;

/** Fallback base production/consumption rate (units/day, at a Location whose rate modifier is the default 1.0 -- see Location.productionRate/consumptionRate). */
export const DEFAULT_BASE_PRODUCTION_RATE = 8.0;
export const DEFAULT_BASE_CONSUMPTION_RATE = 8.0;

/** Fallback weight/bulk per unit -- only consulted by PorterParty's capacity math (see transport.ts); every existing commodity's implicit weight stays 1.0, matching how every other Transport type treats cargoCapacity as a plain unit count. */
export const DEFAULT_WEIGHT_PER_UNIT = 1.0;

/** Fallback reference price for a Location.basePrice() lookup whose commodity has no registry entry at all. */
export const DEFAULT_BASE_PRICE = 1.0;

// The total commodity roster must fall within this range. Calibrated via
// seed-averaged stockpile-ratio sweeps (see Simulation.md): too few
// commodities (~4) causes severe production/consumption collision effects
// across locations; too many (~20+) dilutes the fixed fleet's coverage per
// commodity. The default 10-commodity roster sits comfortably inside.
export const MIN_COMMODITIES = 5;
export const MAX_COMMODITIES = 25;

export interface EventTemplate {
  name: string;
  demandMultiplier: number;
  supplyMultiplier: number;
  durationDays: number;
}

export class Commodity {
  name: string;
  basePrice: number;
  priceSensitivity: number;
  /** How steeply the consumer buy-price climbs as stock runs BELOW its reference (deficit). */
  deficitPriceBoost: number;
  /** How steeply the producer sell-price falls as stock builds ABOVE its reference (excess). */
  excessPriceBoost: number;
  eventTemplates: EventTemplate[];
  /**
   * This commodity's units/day rate at a Location with the default 1.0 rate
   * modifier -- a Location's actual per-day rate is this times its own
   * modifier (see Location.productionRate/consumptionRate), so two
   * locations producing the same commodity can still differ.
   */
  baseProductionRate: number;
  baseConsumptionRate: number;
  /** Broad category (Foodstuff, Precious, ...) -- see CommodityType. Purely descriptive. */
  type: CommodityType;
  /** Weight/bulk per unit -- only PorterParty's capacity math (transport.ts) reads this; every other Transport type ignores it entirely. */
  weightPerUnit: number;

  constructor(
    name: string,
    basePrice: number,
    priceSensitivity: number = DEFAULT_PRICE_SENSITIVITY,
    deficitPriceBoost: number = DEFAULT_DEFICIT_PRICE_BOOST,
    excessPriceBoost: number = DEFAULT_EXCESS_PRICE_BOOST,
    eventTemplates: EventTemplate[] = [],
    baseProductionRate: number = DEFAULT_BASE_PRODUCTION_RATE,
    baseConsumptionRate: number = DEFAULT_BASE_CONSUMPTION_RATE,
    type: CommodityType = DEFAULT_COMMODITY_TYPE,
    weightPerUnit: number = DEFAULT_WEIGHT_PER_UNIT,
  ) {
    this.name = name;
    this.basePrice = basePrice;
    this.priceSensitivity = priceSensitivity;
    this.deficitPriceBoost = deficitPriceBoost;
    this.excessPriceBoost = excessPriceBoost;
    this.eventTemplates = eventTemplates;
    this.baseProductionRate = baseProductionRate;
    this.baseConsumptionRate = baseConsumptionRate;
    this.type = type;
    this.weightPerUnit = weightPerUnit;
  }
}

function makeCommodityEvents(
  commodity: string,
  boom: string,
  disruption: string,
  glut: string,
  slump: string,
): EventTemplate[] {
  return [
    { name: `${boom} boosts ${commodity} demand`, demandMultiplier: 1.3, supplyMultiplier: 1.0, durationDays: 5 },
    { name: `${disruption} disrupts ${commodity} supply`, demandMultiplier: 1.0, supplyMultiplier: 0.65, durationDays: 5 },
    { name: `${glut} creates a ${commodity} glut`, demandMultiplier: 1.0, supplyMultiplier: 1.3, durationDays: 5 },
    { name: `${slump} dampens ${commodity} demand`, demandMultiplier: 0.8, supplyMultiplier: 1.0, durationDays: 6 },
  ];
}

const BESPOKE_EVENT_TEMPLATES: Record<string, EventTemplate[]> = {
  "Crude Oil": [
    { name: "Heatwave boosts energy demand", demandMultiplier: 1.4, supplyMultiplier: 1.0, durationDays: 4 },
    { name: "Port strike disrupts supply chain", demandMultiplier: 1.0, supplyMultiplier: 0.6, durationDays: 5 },
    { name: "Geopolitical tension in producing region", demandMultiplier: 1.1, supplyMultiplier: 0.7, durationDays: 6 },
    { name: "OPEC+ production cut", demandMultiplier: 1.0, supplyMultiplier: 0.75, durationDays: 6 },
  ],
  Copper: [
    { name: "Construction boom", demandMultiplier: 1.3, supplyMultiplier: 1.0, durationDays: 5 },
    { name: "Mine collapse cuts output", demandMultiplier: 1.0, supplyMultiplier: 0.65, durationDays: 5 },
    { name: "Technological breakthrough increases efficiency", demandMultiplier: 1.0, supplyMultiplier: 1.3, durationDays: 5 },
    { name: "Recession fears dampen demand", demandMultiplier: 0.75, supplyMultiplier: 1.0, durationDays: 6 },
  ],
  Wheat: [
    { name: "Drought reduces harvest", demandMultiplier: 1.0, supplyMultiplier: 0.6, durationDays: 6 },
    { name: "Bumper harvest / production surplus", demandMultiplier: 1.0, supplyMultiplier: 1.4, durationDays: 4 },
    { name: "Export ban announced", demandMultiplier: 1.2, supplyMultiplier: 0.8, durationDays: 5 },
    { name: "New trade agreement lowers tariffs", demandMultiplier: 1.15, supplyMultiplier: 1.0, durationDays: 4 },
  ],
  Gold: [
    { name: "Stock market turmoil drives safe-haven demand", demandMultiplier: 1.35, supplyMultiplier: 1.0, durationDays: 5 },
    { name: "Positive economic growth report", demandMultiplier: 0.85, supplyMultiplier: 1.0, durationDays: 3 },
    { name: "Central bank buying spree", demandMultiplier: 1.25, supplyMultiplier: 1.0, durationDays: 6 },
    { name: "New mine discovery", demandMultiplier: 1.0, supplyMultiplier: 1.2, durationDays: 5 },
  ],
};

const GENERATED_EVENT_DRIVERS: Record<string, [string, string, string, string]> = {
  Silver: ["Surging industrial demand", "Mine strike", "New refining capacity", "Recession fears"],
  "Natural Gas": ["Cold snap", "Pipeline outage", "Mild winter", "Warm winter forecast"],
  Coffee: ["Strong consumer demand", "Frost in growing regions", "Bumper harvest", "Weak consumer spending"],
  Cotton: ["Textile industry boom", "Drought in growing regions", "Bumper harvest", "Synthetic fiber substitution"],
  "Iron Ore": ["Steel demand surge", "Mine flooding", "New mine coming online", "Steel industry slowdown"],
  Aluminum: ["Aerospace demand surge", "Smelter power outage", "New smelter capacity", "Automotive slowdown"],
};

const GENERIC_EVENT_DRIVERS: [string, string, string, string] = [
  "Strong demand",
  "Supply disruption",
  "Oversupply",
  "Weak demand",
];

const PRICE_SENSITIVITY: Record<string, number> = {
  "Crude Oil": 0.6,
  Copper: 0.5,
  Wheat: 0.45,
  Gold: 0.25,
  Silver: 0.35,
  "Natural Gas": 0.55,
  Coffee: 0.45,
  Cotton: 0.45,
  "Iron Ore": 0.45,
  Aluminum: 0.45,
};

const DEFICIT_PRICE_BOOST: Record<string, number> = {
  "Crude Oil": 1.5,
  Copper: 1.4,
  Wheat: 1.6,
  Gold: 1.2,
  Silver: 1.4,
  "Natural Gas": 1.6,
  Coffee: 2.0,
  Cotton: 1.5,
  "Iron Ore": 1.3,
  Aluminum: 1.3,
};

// Per-commodity producer-side excess boost. Empty by default: each commodity
// falls back to its own deficit boost (symmetric elasticity). Add entries
// here to make a commodity's surplus price react more or less sharply than
// its shortage price.
const EXCESS_PRICE_BOOST: Record<string, number> = {};

// Hand-tuned base production/consumption rates (units/day) for the ten
// default commodities -- bulkier/cheaper goods (Crude Oil, Natural Gas, Iron
// Ore) move at a higher daily volume than scarce/expensive ones (Gold,
// Silver). Anything not listed here (a custom commodity) falls back to
// DEFAULT_BASE_PRODUCTION_RATE/DEFAULT_BASE_CONSUMPTION_RATE.
const BASE_PRODUCTION_RATE: Record<string, number> = {
  "Crude Oil": 14.0, Copper: 8.0, Wheat: 10.0, Gold: 2.0, Silver: 4.0,
  "Natural Gas": 12.0, Coffee: 6.0, Cotton: 7.0, "Iron Ore": 11.0, Aluminum: 8.0,
};
const BASE_CONSUMPTION_RATE: Record<string, number> = {
  "Crude Oil": 13.0, Copper: 7.0, Wheat: 9.0, Gold: 2.0, Silver: 4.0,
  "Natural Gas": 11.0, Coffee: 6.0, Cotton: 6.0, "Iron Ore": 10.0, Aluminum: 7.0,
};

// Category for the ten default commodities. Anything not listed here (a
// custom commodity) falls back to DEFAULT_COMMODITY_TYPE.
const COMMODITY_TYPE: Record<string, CommodityType> = {
  "Crude Oil": "Energy", "Natural Gas": "Energy",
  Copper: "Metal", "Iron Ore": "Metal", Aluminum: "Metal",
  Gold: "Precious", Silver: "Precious",
  Wheat: "Foodstuff", Coffee: "Foodstuff",
  Cotton: "Textile",
};

function eventTemplatesFor(name: string): EventTemplate[] {
  if (name in BESPOKE_EVENT_TEMPLATES) return BESPOKE_EVENT_TEMPLATES[name];
  const drivers = GENERATED_EVENT_DRIVERS[name] ?? GENERIC_EVENT_DRIVERS;
  return makeCommodityEvents(name, ...drivers);
}

/**
 * Build one Commodity per name, pulling hand-tuned price sensitivity/
 * deficit boost/event templates where they exist and falling back to the
 * DEFAULT_* / generic-driver values otherwise. The producer-side excess
 * boost defaults to the commodity's own deficit boost, so each commodity is
 * as price-elastic to surplus as it is to shortage -- override per commodity
 * later if you want the two sides tuned independently.
 */
export function buildCommodities(
  names: string[],
  basePrices: Record<string, number>,
  productionRates: Record<string, number> = {},
  consumptionRates: Record<string, number> = {},
  types: Record<string, CommodityType> = {},
  weights: Record<string, number> = {},
): Record<string, Commodity> {
  if (names.length < MIN_COMMODITIES || names.length > MAX_COMMODITIES) {
    throw new Error(
      `buildCommodities: names.length must be between ${MIN_COMMODITIES} and ${MAX_COMMODITIES} (got ${names.length}).`,
    );
  }
  const result: Record<string, Commodity> = {};
  for (const name of names) {
    const deficitBoost = DEFICIT_PRICE_BOOST[name] ?? DEFAULT_DEFICIT_PRICE_BOOST;
    result[name] = new Commodity(
      name,
      basePrices[name],
      PRICE_SENSITIVITY[name] ?? DEFAULT_PRICE_SENSITIVITY,
      deficitBoost,
      EXCESS_PRICE_BOOST[name] ?? deficitBoost,
      eventTemplatesFor(name),
      productionRates[name] ?? BASE_PRODUCTION_RATE[name] ?? DEFAULT_BASE_PRODUCTION_RATE,
      consumptionRates[name] ?? BASE_CONSUMPTION_RATE[name] ?? DEFAULT_BASE_CONSUMPTION_RATE,
      types[name] ?? COMMODITY_TYPE[name] ?? DEFAULT_COMMODITY_TYPE,
      weights[name] ?? DEFAULT_WEIGHT_PER_UNIT,
    );
  }
  return result;
}
