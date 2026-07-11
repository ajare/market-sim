/**
 * Standalone Location model for the World editor -- shaped to match
 * load_locations_csv's columns (sim/csv_loaders.py) so a World built here
 * can be exported straight into a CSV the Python/TS sim already knows how
 * to read: name,x,y,produced_commodities,consumed_commodities,stockpiles,
 * min_stockpiles,base_prices,fuel_price,terminal_types.
 */
export type TerminalType = "Port" | "Wagon yard" | "Airport" | "Platform";

export const TERMINAL_TYPES: TerminalType[] = ["Port", "Wagon yard", "Airport", "Platform"];

/** Default base rate (units/day, at a Location whose rate modifier is the default 1.0) for a newly defined Commodity -- mirrors DEFAULT_BASE_PRODUCTION_RATE/DEFAULT_BASE_CONSUMPTION_RATE in sim/commodity.py. */
export const DEFAULT_COMMODITY_RATE = 8;

/**
 * Shaped to match load_commodities_csv's columns (sim/csv_loaders.py):
 * name,base_price,production_rate,consumption_rate. basePrice is this
 * commodity's world-wide reference price; productionRate/consumptionRate are
 * its units/day rate at a Location with the default 1.0 rate modifier (see
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

export interface EditorLocation {
  id: string;
  name: string;
  x: number;
  y: number;
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

export function createLocation(id: string, name: string, x: number, y: number): EditorLocation {
  return {
    id,
    name,
    x,
    y,
    producedCommodities: {},
    consumedCommodities: {},
    stockpiles: {},
    minStockpiles: {},
    basePriceModifiers: {},
    fuelPrice: 1,
    terminalTypes: [],
  };
}
