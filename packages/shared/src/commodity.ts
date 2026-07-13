/**
 * Broad category a Commodity belongs to -- purely descriptive (grouping/
 * display), doesn't feed into any pricing or simulation logic. "General" is
 * the catch-all for anything that doesn't fit the others (and the fallback
 * for a commodity with no registered type at all -- e.g. one authored in the
 * editor before this field existed). Shared by the simulation engine
 * (src/sim/commodity.ts) and the editor (types.ts).
 */
export const COMMODITY_TYPES = ["Energy", "Metal", "Precious", "Foodstuff", "Textile", "General"] as const;
export type CommodityType = (typeof COMMODITY_TYPES)[number];
export const DEFAULT_COMMODITY_TYPE: CommodityType = "General";
