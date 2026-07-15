/**
 * Distance/speed display-unit conversions, moved into @market-sim/shared
 * (shared with the simulation engine, see src/sim/worldData.ts's
 * DISPLAY_DISTANCE_UNIT) -- this re-export keeps every existing
 * `from "./units"` import in the editor working unchanged.
 */
export * from "@market-sim/shared/units";
