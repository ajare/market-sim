/**
 * Calendar date/time of day 1, for any World built/loaded without an explicit
 * startDate. Shared by the simulation engine (src/sim/world.ts's World) and
 * the editor (worldJson.ts, for files predating the startDate field), so both
 * sides fall back to the exact same date.
 */
export const DEFAULT_START_DATE = "1800-01-01T00:00:00.000Z";
