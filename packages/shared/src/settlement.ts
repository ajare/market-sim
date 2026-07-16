/**
 * Settlement-scale classification a Location can carry, orthogonal to
 * TerminalType (what transport can connect there) -- applies to any
 * Location (European or native), not just villages. Shared by the
 * simulation engine (src/sim/location.ts) and the editor (types.ts) --
 * only this type/constants trio is identical between the two.
 */
export type SettlementType = "Native village" | "Settlement" | "Town" | "Outpost";

export const SETTLEMENT_TYPES: SettlementType[] = ["Native village", "Settlement", "Town", "Outpost"];

export const DEFAULT_SETTLEMENT_TYPE: SettlementType = "Town";
