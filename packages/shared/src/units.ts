/**
 * Real-world display units for the abstract "world unit" every distance/speed
 * in this codebase is computed in (Route.distance, Transport.speedUnitsPerDay,
 * WeatherSystem.windSpeed, ...). Fixed anchor: 1 world unit = 1 mile -- chosen
 * because every existing speed constant already reads as a plausible
 * real-world mph once interpreted that way (a 500-unit/day Ship is ~21 mph;
 * 80-480-unit/day wind is ~3-20 mph), so this is a pure display/conversion
 * layer with no change to any simulation math or tuning constant.
 */

export type DistanceUnit = "miles" | "nauticalMiles" | "kilometers";

export const DISTANCE_UNITS: DistanceUnit[] = ["miles", "nauticalMiles", "kilometers"];

export const DEFAULT_DISTANCE_UNIT: DistanceUnit = "miles";

const KM_PER_MILE = 1.609344;
const NAUTICAL_MILES_PER_MILE = 0.868976;

/** World units (1 world unit = 1 mile) converted to the given display unit. */
export function convertDistance(worldUnits: number, unit: DistanceUnit): number {
  switch (unit) {
    case "miles":
      return worldUnits;
    case "nauticalMiles":
      return worldUnits * NAUTICAL_MILES_PER_MILE;
    case "kilometers":
      return worldUnits * KM_PER_MILE;
  }
}

/** World units per (sim) day converted to the matching real-world speed unit, per hour. */
export function convertSpeed(worldUnitsPerDay: number, unit: DistanceUnit): number {
  return convertDistance(worldUnitsPerDay, unit) / 24;
}

/** Abbreviation for a distance reading in `unit` (e.g. "12 mi"). */
export function distanceUnitLabel(unit: DistanceUnit): string {
  switch (unit) {
    case "miles":
      return "mi";
    case "nauticalMiles":
      return "nmi";
    case "kilometers":
      return "km";
  }
}

/** Abbreviation for a speed reading in `unit`'s matching per-hour unit (miles->mph, nautical miles->knots, kilometers->km/h). */
export function speedUnitLabel(unit: DistanceUnit): string {
  switch (unit) {
    case "miles":
      return "mph";
    case "nauticalMiles":
      return "kn";
    case "kilometers":
      return "km/h";
  }
}

/** Human-readable name for a `<select>` option (e.g. "Nautical miles"). */
export function distanceUnitName(unit: DistanceUnit): string {
  switch (unit) {
    case "miles":
      return "Miles";
    case "nauticalMiles":
      return "Nautical miles";
    case "kilometers":
      return "Kilometers";
  }
}
